/**
 * Model-request trace plugin: writes each model call's input and wire details to
 * a directory the user chooses, so a gateway content-moderation interruption can
 * be inspected afterwards instead of reconstructed.
 *
 * @module @local/dsh-llm-trace
 */

import path from 'node:path'
import fsp from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import z from '@deepseek-ai/schemastery'
import {
  appendJsonLine,
  atomicWrite,
  caseDirName,
  ensureDir,
  expandHome,
  indexRow,
  listCaseDirs,
  measure,
  removeDir,
  renderRequestText,
  stamp,
  writeJson,
  dirSize,
} from './lib/io.js'
import { createWire } from './lib/wire.js'
import { createToolHandler } from './lib/tool.js'

/** Cordis plugin name. */
export const name = 'llm-trace'

/** Services required to register the reading tool. */
export const inject = ['tools']

/** Default patterns that identify a gateway moderation refusal. */
const DEFAULT_FAILURE_PATTERNS = [
  'DataInspectionFailed',
  'inappropriate content',
  'content_filter',
  'content filter',
  'sensitive',
]

/** Default request headers that must never reach disk. */
const DEFAULT_REDACT_HEADERS = ['authorization', 'x-api-key', 'api-key', 'cookie', 'set-cookie', 'organization']

/** Default body patterns scrubbed from captured bytes. */
const DEFAULT_REDACT_PATTERNS = ['sk-[A-Za-z0-9_-]{16,}', 'Bearer\\s+[A-Za-z0-9._-]{16,}']

/**
 * Plugin configuration.
 * @satisfies {import('@deepseek-ai/schemastery').Schema}
 */
export const Config = z.object({
  enabled: z.boolean().default(false).volatile()
    .description('总开关：开启后开始采集；关闭后立即停止写入。'),
  outputDir: z.string().default('~/.dsh/traces/llm')
    .description('落盘根目录，支持 ~。'),
  mode: z.string().default('on-failure')
    .description('always = 每次调用都落盘；on-failure = 仅失败时落盘并附带前几次成功；moderation = 仅审核类失败。'),
  onlyModels: z.array(z.string()).default([])
    .description('只采集这些模型 id；留空表示全部模型。'),
  captureWire: z.boolean().default(true)
    .description('是否包装 globalThis.fetch 抓取线上原始请求体与响应头。'),
  captureHosts: z.array(z.string()).default([])
    .description('可选的 host 白名单；留空表示只按调用作用域归属，不按 host 过滤。'),
  captureErrorBody: z.boolean().default(true)
    .description('是否保存非 2xx 响应原文（网关审核报错正文）。'),
  captureStreamChunks: z.boolean().default(false)
    .description('是否保存原始流式 chunk；体积大，默认关闭。'),
  includeAuxiliary: z.boolean().default(false)
    .description('是否采集会话标题生成等辅助调用。'),
  ringSnapshots: z.number().step(1).min(0).default(2)
    .description('失败落盘时附带前几次成功调用的数量。'),
  maxBodyBytes: z.number().step(1).default(67_108_864)
    .description('单个 wire 请求体上限（字节）。'),
  maxTotalBytes: z.number().step(1).default(2_147_483_648)
    .description('落盘目录总上限（字节），超出按最旧删除。'),
  retentionDays: z.number().step(1).default(14)
    .description('保留天数；0 表示不按时间清理。'),
  failurePatterns: z.array(z.string()).default(DEFAULT_FAILURE_PATTERNS)
    .description('判定为审核失败的子串（不区分大小写）。'),
  redactHeaders: z.array(z.string()).default(DEFAULT_REDACT_HEADERS)
    .description('写入前打码的请求头。'),
  redactPatterns: z.array(z.string()).default(DEFAULT_REDACT_PATTERNS)
    .description('写入前从 body 中清除的密钥正则。'),
})

/** Prune sweep interval. */
const PRUNE_INTERVAL_MS = 5 * 60_000

/** RPC path the settings page uses. */
const RPC_PATH = '/api/llm-trace'

/** Boot diagnostics: the host reports only "failed" for an activation error. */
const BOOT_LOG = '/tmp/llm-trace-boot.log'

/**
 * Append one boot diagnostic line.
 * @param {string} message - diagnostic text.
 * @returns {void}
 */
function bootLog(message) {
  try {
    appendFileSync(BOOT_LOG, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // Diagnostics never affect activation.
  }
}

/**
 * Read one content value as text for cheap size statistics.
 * @param {unknown} value - content value.
 * @returns {number} character count.
 */
function charCount(value) {
  if (typeof value === 'string') return value.length
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + charCount(item), 0)
  if (value !== null && typeof value === 'object') {
    try { return JSON.stringify(value).length } catch { return 0 }
  }
  return 0
}

/**
 * Capture each model call and write the selected ones to disk.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} config - resolved plugin configuration.
 */
export function apply(ctx, config) {
  bootLog('apply enter')
  const als = new AsyncLocalStorage()
  /** @type {{rings: Map<string, object[]>, positions: Map<string, {turn: number, step: number}>, attempts: Map<string, number>, seq: number, lastPrune: number, flushing: Set<string>}} */
  const state = {
    rings: new Map(),
    positions: new Map(),
    attempts: new Map(),
    seq: 0,
    lastPrune: 0,
    flushing: new Set(),
  }

  /** @returns {boolean} whether capture is switched on. */
  const enabled = () => config.enabled.get() === true
  /** @returns {string} expanded output directory. */
  const root = () => expandHome(config.outputDir)
  /** @returns {string} cases directory. */
  const casesDir = () => path.join(root(), 'cases')

  /**
   * Resolve the current turn/step position of one session.
   * @param {string} sessionId - session identity.
   * @returns {{turn: number, step: number}} position, or zeros when unknown.
   */
  function positionOf(sessionId) {
    return state.positions.get(sessionId) ?? { turn: 0, step: 0 }
  }

  /**
   * Decide whether the requested model is one this bundle should capture.
   * @param {object} options - generate options.
   * @returns {boolean} whether to capture.
   */
  function wantsModel(options) {
    const only = Array.isArray(config.onlyModels) ? config.onlyModels : []
    if (only.length === 0) return true
    return only.includes(String(options.model ?? ''))
  }

  /**
   * Build one in-memory record. The request object is frozen by the loop, so the
   * record keeps a reference instead of a copy.
   * @param {object} options - generate options.
   * @returns {object} capture record.
   */
  function makeRecord(options) {
    const sessionId = options.sessionId === undefined ? 'no-session' : String(options.sessionId)
    const position = positionOf(sessionId)
    const attemptKey = `${sessionId}|${position.turn}|${position.step}`
    const attempt = (state.attempts.get(attemptKey) ?? 0) + 1
    state.attempts.set(attemptKey, attempt)
    state.seq += 1
    /** @type {object} */
    const rec = {
      id: `${stamp(Date.now())}-${state.seq.toString(36)}`,
      startedAt: Date.now(),
      endedAt: undefined,
      sessionId,
      turn: position.turn,
      step: position.step,
      attempt,
      provider: String(options.provider ?? ''),
      model: String(options.model ?? ''),
      purpose: options.purpose,
      controls: {
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.stop === undefined ? {} : { stop: options.stop },
        ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
      },
      options,
      usage: undefined,
      chunks: { count: 0, types: {}, lines: config.captureStreamChunks === true ? [] : undefined },
      outcome: { kind: 'incomplete' },
      wire: config.captureWire === true
        ? { enabled: true, calls: [], responses: [], status: null, requestId: null, errorBody: undefined, transportError: undefined }
        : undefined,
    }
    const ring = state.rings.get(sessionId) ?? []
    ring.push(rec)
    const keep = Math.max(0, Number(config.ringSnapshots) || 0) + 1
    while (ring.length > keep) ring.shift()
    state.rings.set(sessionId, ring)
    return rec
  }

  /**
   * Fold one stream chunk into the record's summary.
   * @param {object} rec - capture record.
   * @param {unknown} chunk - stream chunk.
   * @returns {void}
   */
  function observe(rec, chunk) {
    if (chunk === null || typeof chunk !== 'object') return
    const type = String(chunk.type ?? 'unknown')
    rec.chunks.count += 1
    rec.chunks.types[type] = (rec.chunks.types[type] ?? 0) + 1
    if (type === 'usage' && chunk.usage !== undefined) rec.usage = chunk.usage
    // The terminal chunk is the only place the failure code and the gateway's
    // response text reach a listener (pi-ai folds `<status> <body>` into it).
    if (type === 'finish') rec.outcome = chunk.reason ?? { kind: 'stop' }
    if (rec.chunks.lines !== undefined) {
      try { rec.chunks.lines.push(JSON.stringify(chunk)) } catch { /* unserializable chunk */ }
    }
  }

  /**
   * Whether the record's failure looks like a gateway content refusal.
   * @param {object} rec - capture record.
   * @returns {boolean} whether a configured pattern matched.
   */
  function looksModerated(rec) {
    const failure = rec.outcome?.failure ?? {}
    const message = String(failure.message ?? rec.outcome?.message ?? '')
    const text = message.toLowerCase()
    const patterns = Array.isArray(config.failurePatterns) ? config.failurePatterns : []
    return patterns.some(pattern => text.includes(String(pattern).toLowerCase()))
  }

  /**
   * Whether this settled record must be written.
   * @param {object} rec - capture record.
   * @returns {boolean} capture decision.
   */
  function shouldCapture(rec) {
    const mode = String(config.mode ?? 'on-failure')
    if (mode === 'always') return true
    const kind = rec.outcome?.kind
    const failed = kind === 'error' || kind === 'aborted' || kind === 'crash'
    if (!failed) return false
    if (mode === 'moderation') {
      return looksModerated(rec) || Number(rec.wire?.status ?? 0) >= 400 || rec.wire?.transportError !== undefined
    }
    return true
  }

  /**
   * Write one record into a directory.
   * @param {string} dir - destination directory.
   * @param {object} rec - capture record.
   * @returns {Promise<void>} completion.
   */
  async function writeRecord(dir, rec) {
    await ensureDir(dir)
    const stats = measure(rec)
    const meta = {
      schema: 1,
      key: { sessionId: rec.sessionId, turn: rec.turn, step: rec.step, attempt: rec.attempt },
      time: new Date(rec.startedAt).toISOString(),
      elapsedMs: rec.endedAt === undefined ? null : rec.endedAt - rec.startedAt,
      provider: rec.provider,
      model: rec.model,
      purpose: rec.purpose ?? null,
      request: { messages: stats.messages, chars: stats.chars, tools: stats.tools },
      outcome: rec.outcome ?? null,
      usage: rec.usage ?? null,
    }
    await writeJson(path.join(dir, 'meta.json'), meta)
    const request = {
      schema: 1,
      id: rec.id,
      provider: rec.provider,
      model: rec.model,
      purpose: rec.purpose ?? null,
      controls: rec.controls,
      sessionId: rec.sessionId,
      messages: rec.options?.messages ?? [],
      tools: rec.options?.tools ?? [],
    }
    await atomicWrite(path.join(dir, 'request.json'), `${JSON.stringify(request, null, 2)}\n`)
    await atomicWrite(path.join(dir, 'request.txt'), `${renderRequestText(rec)}\n`)
    if (rec.wire !== undefined) {
      await writeJson(path.join(dir, 'wire.request.json'), {
        calls: rec.wire.calls,
        transportError: rec.wire.transportError ?? null,
      })
      await writeJson(path.join(dir, 'wire.headers.json'), {
        responses: rec.wire.responses,
        status: rec.wire.status,
        requestId: rec.wire.requestId,
      })
      if (rec.wire.errorBody !== undefined) {
        const lines = [
          `HTTP ${rec.wire.status ?? '?'}`,
          rec.wire.requestId === null ? '' : `x-request-id: ${rec.wire.requestId}`,
          '',
          rec.wire.errorBody,
        ]
        await atomicWrite(path.join(dir, 'wire.response.txt'), lines.join('\n'))
      }
    }
    if (rec.chunks.lines !== undefined && rec.chunks.lines.length > 0) {
      await atomicWrite(path.join(dir, 'chunks.jsonl'), `${rec.chunks.lines.join('\n')}\n`)
    }
  }

  /**
   * Write the failing record plus the recent successes kept in the session ring.
   * @param {object} rec - the record that triggered the flush.
   * @returns {Promise<string|null>} case directory, or null on failure.
   */
  async function flushCase(rec) {
    if (state.flushing.has(rec.id)) return null
    state.flushing.add(rec.id)
    try {
      const dir = path.join(casesDir(), caseDirName(rec))
      const ring = state.rings.get(rec.sessionId) ?? [rec]
      const earlier = ring.filter(item => item !== rec && item.outcome?.kind !== 'crash')
      await writeRecord(dir, rec)
      for (const [index, item] of earlier.slice(-Math.max(0, Number(config.ringSnapshots) || 0)).entries()) {
        await writeRecord(path.join(dir, 'prev', `${index + 1}-t${item.turn}-s${item.step}`), item)
      }
      const stats = measure(rec)
      await appendJsonLine(path.join(root(), 'index.jsonl'), indexRow(rec, path.basename(dir), stats))
      await prune(false)
      return dir
    } catch (error) {
      ctx.logger?.warn?.(`llm-trace: 落盘失败 ${String(error?.message ?? error)}`)
      return null
    } finally {
      state.flushing.delete(rec.id)
    }
  }

  /**
   * Enforce retention and size limits.
   * @param {boolean} force - ignore the rate limit.
   * @returns {Promise<string>} human-readable summary.
   */
  async function prune(force) {
    const now = Date.now()
    if (!force && now - state.lastPrune < PRUNE_INTERVAL_MS) return 'skipped'
    state.lastPrune = now
    const dirs = await listCaseDirs(casesDir())
    if (dirs.length === 0) return 'prune: 没有 case'
    const days = Number(config.retentionDays) || 0
    const cutoff = days > 0 ? now - days * 86_400_000 : 0
    const limit = Number(config.maxTotalBytes) || 0
    const entries = []
    let total = 0
    for (const dir of dirs) {
      const size = await dirSize(path.join(casesDir(), dir.name))
      entries.push({ ...dir, size })
      total += size
    }
    let removed = 0
    for (const entry of entries) {
      const expired = cutoff > 0 && entry.mtimeMs < cutoff
      const overLimit = limit > 0 && total > limit
      if (!expired && !overLimit) continue
      await removeDir(path.join(casesDir(), entry.name))
      total -= entry.size
      removed += 1
    }
    return `prune: 检查 ${entries.length} 个 case，删除 ${removed} 个，剩余 ${(total / 1_048_576).toFixed(2)} MiB`
  }

  /**
   * Settle one record and flush it when the policy says so.
   * @param {object} rec - capture record.
   * @param {object} outcome - terminal outcome.
   * @returns {Promise<void>} completion.
   */
  async function settle(rec, outcome) {
    rec.outcome = outcome
    rec.endedAt = Date.now()
    if (shouldCapture(rec)) await flushCase(rec)
  }

  /**
   * Run a callback with the record installed as the current capture scope.
   * @param {object} rec - capture record.
   * @param {() => unknown} fn - callback.
   * @returns {unknown} callback result.
   */
  function inScope(rec, fn) {
    return als.run(rec, fn)
  }

  /**
   * Wrap the downstream chunk stream with observation only.
   * @param {object} rec - capture record.
   * @param {() => AsyncIterable<object>} next - downstream stream factory.
   * @returns {AsyncIterable<object>} wrapped stream.
   */
  function wrapStream(rec, next) {
    let iterator
    let settled = false
    /** @returns {Promise<void>} settle once. */
    async function finish() {
      if (settled) return
      settled = true
      await settle(rec, rec.outcome)
    }
    return {
      [Symbol.asyncIterator]() {
        return this
      },
      async next() {
        if (iterator === undefined) iterator = inScope(rec, () => next()[Symbol.asyncIterator]())
        let result
        try {
          result = await inScope(rec, () => iterator.next())
        } catch (error) {
          rec.outcome = { kind: 'crash', message: String(error?.message ?? error) }
          await finish()
          throw error
        }
        if (result.done === true) {
          // A stream that ends without a terminal chunk is treated as a stop.
          if (rec.outcome?.kind === 'incomplete') rec.outcome = { kind: 'stop' }
          await finish()
          return result
        }
        observe(rec, result.value)
        return result
      },
      async return(value) {
        if (rec.outcome?.kind === 'incomplete') rec.outcome = { kind: 'aborted', message: 'consumer closed the stream' }
        await finish()
        if (iterator !== undefined && typeof iterator.return === 'function') {
          try { return await inScope(rec, () => iterator.return(value)) } catch { /* already closed */ }
        }
        return { done: true, value: undefined }
      },
      async throw(error) {
        rec.outcome = { kind: 'crash', message: String(error?.message ?? error) }
        await finish()
        if (iterator !== undefined && typeof iterator.throw === 'function') {
          return inScope(rec, () => iterator.throw(error))
        }
        throw error
      },
    }
  }

  // Track the latest turn/step of every session so captured records carry a position.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'step/start') return
    const data = event.data ?? {}
    state.positions.set(String(session.id), { turn: Number(data.turn) || 0, step: Number(data.step) || 0 })
  }, { global: true })

  // Observed and forwarded unchanged; the terminal chunk carries the failure text.
  ctx.on('llm/stream', (options, next) => {
    if (!enabled()) return next()
    if (options.purpose !== undefined && config.includeAuxiliary !== true) return next()
    if (!wantsModel(options)) return next()
    const rec = makeRecord(options)
    return wrapStream(rec, next)
  }, { global: true })

  // The wire tee is installed once and only records while a capture scope is active.
  const wire = createWire(als, () => config)
  ctx.effect(() => {
    wire.install()
    return () => { wire.restore() }
  })

  // Optional: stop writing as soon as the switch flips off, even mid-flight.
  ctx.effect(() => {
    const interval = setInterval(() => {
      if (!enabled()) {
        state.rings.clear()
      }
    }, 15_000)
    return () => { clearInterval(interval) }
  })

  /**
   * Persist the master switch through the profile config editor.
   * @param {boolean} value - requested state.
   * @returns {Promise<string>} outcome text.
   */
  async function setEnabled(value) {
    const entry = ctx.fiber?.entry
    const editor = ctx.get('configEditor')
    if (entry === undefined || editor === undefined) return '当前 profile 无法写回配置，请在 插件 → 模型请求落盘 → 配置 里切换开关。'
    try {
      await editor.edit(entry, current => ({ ...current, enabled: value }))
      return value ? '已开启采集。' : '已关闭采集。'
    } catch (error) {
      return `写回配置失败：${String(error?.message ?? error)}`
    }
  }

  /**
   * Report whether the client half reached the browser boot graph. The web host
   * composes `window.__DSH_BOOT__` from enabled Loader entries, so this answers
   * "did the settings page get a chance to render" from inside the process.
   * @returns {'registered'|'absent'|'unknown'} graph membership.
   */
  function clientGraphState() {
    try {
      const registry = ctx.get('clientModules')
      const entries = registry?.graph?.()?.entries
      if (!Array.isArray(entries)) return 'unknown'
      return entries.some(entry => String(entry?.id ?? '') === '@local/dsh-llm-trace') ? 'registered' : 'absent'
    } catch {
      return 'unknown'
    }
  }

  /**
   * Build the state the settings page renders.
   * @returns {Promise<object>} current capture status.
   */
  async function statePayload() {
    const dir = root()
    let exists = false
    try {
      exists = (await fsp.stat(dir)).isDirectory()
    } catch {
      // Absent directory simply reports false.
    }
    const dirs = await listCaseDirs(path.join(dir, 'cases'))
    const total = exists ? await dirSize(path.join(dir, 'cases')) : 0
    return {
      enabled: enabled(),
      mode: String(config.mode ?? 'on-failure'),
      dir,
      exists,
      cases: dirs.length,
      totalMiB: Number((total / 1_048_576).toFixed(2)),
      lastCase: dirs.at(-1)?.name ?? null,
      captureWire: config.captureWire === true,
      clientState: clientGraphState(),
    }
  }

  /**
   * Answer one settings-page RPC call.
   * @param {Request} request - buffered request carrying `{ method }`.
   * @returns {Promise<Response>} JSON answer.
   */
  async function handleRpc(request) {
    let body = {}
    try {
      body = await request.json()
    } catch {
      // A malformed body falls through to the default method.
    }
    const method = String(body?.method ?? 'state')
    if (method === 'state') return Response.json({ ok: true, value: await statePayload() })
    if (method === 'set-enabled') {
      const message = await setEnabled(body?.enabled === true)
      return Response.json({ ok: true, value: await statePayload(), message })
    }
    if (method === 'prune') {
      const message = await prune(true)
      return Response.json({ ok: true, value: await statePayload(), message })
    }
    return Response.json({ ok: false, error: { code: 'method-not-found', message: `未知方法 ${method}` } }, { status: 404 })
  }

  // The settings page talks to this route instead of the configuration-form
  // service: the page then depends on nothing but the browser's own auth.
  try {
    ctx.inject(['connection'], (connectionCtx) => {
      let disposeRpc = null
      connectionCtx.effect(() => {
        void connectionCtx.connection.fetch.register({
          path: RPC_PATH,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: handleRpc,
        }).then((dispose) => {
          disposeRpc = dispose
          bootLog(`rpc registered at ${RPC_PATH}`)
        }).catch((error) => {
          bootLog(`rpc register failed: ${error?.message ?? String(error)}`)
        })
        return () => {
          if (disposeRpc !== null) void Promise.resolve(disposeRpc()).catch(() => {})
        }
      }, 'llm-trace: rpc route')
    })
  } catch (error) {
    bootLog(`rpc inject failed: ${error?.message ?? String(error)}`)
  }

  const handler = createToolHandler({
    enabled,
    root,
    config: () => config,
    setEnabled,
    prune,
    clientState: clientGraphState,
  })

  // Registered as a plain ToolDefinition: this bundle must not depend on the
  // shipped (unpublished) `@deepseek-ai/dsh-tools` package, and `register` only
  // requires a JSON-Schema `parameters` plus `output { schema, render }`.
  ctx.tools.register({
    name: 'llm_trace',
    description:
      '查看模型请求落盘插件采集到的细节：开关状态、最近的失败 case、某次调用的请求输入与网关报错原文。'
      + '用于排查大模型被内容审核中断（例如 DataInspectionFailed）时模型到底收到了什么。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'list', 'show', 'grep', 'enable', 'disable', 'prune'],
          description: 'status 看状态；list 列最近 case；show 看某个 case；grep 在某个 case 里搜词；enable/disable 切换采集；prune 清理。',
        },
        target: { type: 'string', description: 'case 目录名，或 latest。' },
        pattern: { type: 'string', description: 'grep 要搜索的词。' },
        limit: { type: 'number', description: 'list 返回条数，默认 15。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: (args) => handler(args),
  })
}