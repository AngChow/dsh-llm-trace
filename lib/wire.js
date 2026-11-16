/**
 * Outbound `fetch` tee for the llm-trace bundle.
 *
 * The provider adapters reach `globalThis.fetch` at call time (pi-ai uses
 * `options?.fetch ?? globalThis.fetch`; the DeepSeek adapter calls `fetch`
 * directly), so wrapping the global function observes the exact bytes the
 * gateway received. Attribution back to one model call uses the
 * AsyncLocalStorage store the stream wrapper installs around every
 * `iterator.next()`.
 *
 * @module @local/dsh-llm-trace/lib/wire
 */

/** Largest error body retained per call. */
const ERROR_BODY_CAP = 262_144

/**
 * Cap one string.
 * @param {string} text - source.
 * @param {number} cap - maximum characters.
 * @returns {string} capped text.
 */
function cap(text, limit) {
  const value = String(text ?? '')
  return value.length <= limit ? value : value.slice(0, limit)
}

/**
 * Resolve the request URL of a fetch input.
 * @param {unknown} input - fetch input.
 * @returns {string} URL text, or an empty string.
 */
function urlOf(input) {
  try {
    if (typeof input === 'string') return input
    if (input instanceof URL) return input.href
    if (input && typeof input === 'object' && typeof input.url === 'string') return input.url
  } catch {
    // A malformed input is not our business to report.
  }
  return ''
}

/**
 * Normalize any HeadersInit value into a plain record.
 * @param {unknown} headers - headers initializer.
 * @param {Record<string, string>} into - accumulator.
 * @returns {void}
 */
function collectHeaders(headers, into) {
  if (!headers) return
  if (typeof headers.forEach === 'function' && !Array.isArray(headers)) {
    headers.forEach((value, key) => { into[String(key)] = String(value) })
    return
  }
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (Array.isArray(pair) && pair.length >= 2) into[String(pair[0])] = String(pair[1])
    }
    return
  }
  if (typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) into[key] = String(value)
  }
}

/**
 * Apply the configured secret patterns to one string.
 * @param {string} text - source text.
 * @param {string[]} patterns - regular-expression sources.
 * @returns {string} redacted text.
 */
function redactText(text, patterns) {
  let value = text
  for (const source of patterns ?? []) {
    try {
      value = value.replace(new RegExp(source, 'g'), '[redacted]')
    } catch {
      // An invalid user pattern is skipped instead of failing the request.
    }
  }
  return value
}

/**
 * Build the captured request description.
 * @param {string} url - request URL.
 * @param {unknown} input - fetch input.
 * @param {unknown} init - fetch init.
 * @param {object} config - resolved plugin config.
 * @returns {object} captured request.
 */
function readRequest(url, input, init, config) {
  const headers = {}
  try { collectHeaders(input && typeof input === 'object' ? input.headers : undefined, headers) } catch { /* ignore */ }
  try { collectHeaders(init?.headers, headers) } catch { /* ignore */ }
  const blocklist = new Set((config.redactHeaders ?? []).map(name => String(name).toLowerCase()))
  const safeHeaders = {}
  for (const [key, value] of Object.entries(headers)) {
    safeHeaders[key] = blocklist.has(key.toLowerCase()) ? '[redacted]' : redactText(value, config.redactPatterns)
  }
  const rawBody = typeof init?.body === 'string' ? init.body : undefined
  return {
    url,
    method: String(init?.method ?? 'POST').toUpperCase(),
    headers: safeHeaders,
    bodyChars: rawBody === undefined ? null : rawBody.length,
    body: rawBody === undefined ? null : redactText(cap(rawBody, config.maxBodyBytes ?? 67_108_864), config.redactPatterns),
  }
}

/**
 * Build the captured response header description.
 * @param {Response} response - fetch response.
 * @returns {object} status, request id, and headers.
 */
function readResponseHead(response) {
  const headers = {}
  try {
    response.headers.forEach((value, key) => { headers[String(key)] = String(value) })
  } catch {
    // An exotic Response without iterable headers only loses the header dump.
  }
  const requestId = headers['x-request-id']
    ?? headers['x-acs-request-id']
    ?? headers['request-id']
    ?? headers['x-trace-id']
    ?? null
  return { status: response.status, statusText: response.statusText, requestId, headers }
}

/**
 * Install the fetch tee.
 * @param {import('node:async_hooks').AsyncLocalStorage<object>} als - record scope.
 * @param {() => object} readConfig - current resolved configuration.
 * @returns {{install: () => void, restore: () => void}} lifecycle handles.
 */
export function createWire(als, readConfig) {
  const state = { installed: false, original: null }

  /** Install the wrapper once; repeated calls are no-ops. */
  function install() {
    if (state.installed) return
    const original = globalThis.fetch
    if (typeof original !== 'function') return
    state.original = original
    state.installed = true

    globalThis.fetch = function tracedFetch(input, init) {
      const rec = als.getStore()
      if (!rec || rec.wire === undefined || rec.wire.enabled !== true) return original.call(this, input, init)
      const config = readConfig()
      const url = urlOf(input)
      const hosts = Array.isArray(config.captureHosts) ? config.captureHosts : []
      if (hosts.length > 0) {
        let host = ''
        try { host = new URL(url).host } catch { /* unmatched URL stays uncaptured */ }
        if (host === '' || !hosts.some(candidate => host === candidate || host.endsWith(`.${candidate}`))) {
          return original.call(this, input, init)
        }
      }
      try {
        rec.wire.calls.push(readRequest(url, input, init, config))
      } catch {
        // Capture must never change the request outcome.
      }
      let pending
      try {
        pending = original.call(this, input, init)
      } catch (error) {
        rec.wire.transportError = String(error?.message ?? error)
        throw error
      }
      return Promise.resolve(pending).then((response) => {
        try {
          const head = readResponseHead(response)
          rec.wire.responses.push(head)
          rec.wire.status = head.status
          if (head.requestId !== null) rec.wire.requestId = head.requestId
          if (config.captureErrorBody === true && response.status >= 400 && rec.wire.errorBody === undefined) {
            response.clone().text().then((text) => {
              rec.wire.errorBody = cap(text, ERROR_BODY_CAP)
            }).catch(() => {
              // A body the runtime refuses to clone simply stays uncaptured.
            })
          }
        } catch {
          // Response capture is best-effort.
        }
        return response
      }, (error) => {
        rec.wire.transportError = String(error?.message ?? error)
        throw error
      })
    }
  }

  /** Restore the original global fetch. */
  function restore() {
    if (!state.installed) return
    if (state.original !== null) globalThis.fetch = state.original
    state.installed = false
  }

  return { install, restore }
}