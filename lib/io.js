/**
 * Filesystem and rendering helpers for the llm-trace bundle.
 *
 * Deliberately free of any DSH import so the pure parts can be exercised with a
 * plain `node` process during development.
 *
 * @module @local/dsh-llm-trace/lib/io
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

/** Largest slice of one content block written to the human-readable render. */
const BLOCK_CHAR_CAP = 200_000

/**
 * Expand a leading `~` and resolve the result to an absolute path.
 * @param {string} value - configured directory.
 * @returns {string} absolute path.
 */
export function expandHome(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') return path.join(os.homedir(), '.dsh', 'traces', 'llm')
  if (raw === '~') return os.homedir()
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2))
  return path.resolve(raw)
}

/**
 * Recursively create a directory, ignoring an existing one.
 * @param {string} dir - target directory.
 * @returns {Promise<void>} completion.
 */
export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true })
}

/**
 * Write a file through a temporary sibling and an atomic rename.
 * @param {string} file - destination path.
 * @param {string|Uint8Array} data - file content.
 * @returns {Promise<void>} completion.
 */
export async function atomicWrite(file, data) {
  await ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await fsp.writeFile(tmp, data)
  await fsp.rename(tmp, file)
}

/**
 * Write one JSON document atomically.
 * @param {string} file - destination path.
 * @param {unknown} value - serializable value.
 * @returns {Promise<void>} completion.
 */
export async function writeJson(file, value) {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Append one line to a JSONL file, creating it when absent.
 * @param {string} file - destination path.
 * @param {unknown} value - serializable value.
 * @returns {Promise<void>} completion.
 */
export async function appendJsonLine(file, value) {
  await ensureDir(path.dirname(file))
  await fsp.appendFile(file, `${JSON.stringify(value)}\n`)
}

/**
 * Make a value safe for a path segment.
 * @param {string} value - raw text.
 * @returns {string} sanitized token.
 */
export function safeName(value) {
  return String(value ?? '').replace(/[^\w.@+-]+/g, '_').slice(0, 60) || 'unknown'
}

/**
 * Two-digit zero padding.
 * @param {number} value - non-negative integer.
 * @returns {string} padded text.
 */
function pad(value) {
  return String(value).padStart(2, '0')
}

/**
 * Format a timestamp as a filesystem-friendly local stamp.
 * @param {number} ms - epoch milliseconds.
 * @returns {string} `YYYYMMDD-HHMMSS`.
 */
export function stamp(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/**
 * Build the case directory name for one record.
 * @param {object} rec - capture record.
 * @returns {string} directory name without separators.
 */
export function caseDirName(rec) {
  return `${stamp(rec.startedAt)}_${safeName(rec.model)}_t${rec.turn}-s${rec.step}_a${rec.attempt}`
}

/**
 * Cap one string, marking the cut.
 * @param {string} text - source text.
 * @param {number} cap - maximum characters.
 * @returns {string} capped text.
 */
export function capText(text, cap) {
  const value = String(text ?? '')
  if (value.length <= cap) return value
  return `${value.slice(0, cap)}\n…[truncated ${value.length - cap} chars]`
}

/**
 * Render one content block as readable lines.
 * @param {unknown} block - content block.
 * @returns {string} rendered block.
 */
function renderBlock(block) {
  if (block === null || typeof block !== 'object') return String(block)
  switch (block.type) {
    case 'text':
      return capText(block.text ?? '', BLOCK_CHAR_CAP)
    case 'reasoning':
      return `[reasoning] ${capText(block.text ?? '', BLOCK_CHAR_CAP)}`
    case 'tool-call': {
      const args = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? null)
      return `[tool-call ${block.name ?? block.toolName ?? '?'}] ${capText(args, BLOCK_CHAR_CAP)}`
    }
    case 'tool-result':
      return `[tool-result] ${capText(JSON.stringify(block.content ?? null), BLOCK_CHAR_CAP)}`
    case 'image':
      return `[image ${block.mimeType ?? ''} ${block.variantId ?? ''}]`.replace(/\s+/g, ' ').trim()
    case 'file':
      return `[file ${block.path ?? block.name ?? ''}]`
    default:
      return `[${String(block.type ?? 'unknown')}] ${capText(JSON.stringify(block), BLOCK_CHAR_CAP)}`
  }
}

/**
 * Render the whole request as grep-able plain text.
 * @param {object} rec - capture record.
 * @returns {string} rendered request.
 */
export function renderRequestText(rec) {
  const options = rec.options ?? {}
  const messages = Array.isArray(options.messages) ? options.messages : []
  const tools = Array.isArray(options.tools) ? options.tools : []
  const lines = [
    `# request ${rec.id}`,
    `# time ${new Date(rec.startedAt).toISOString()}  session=${rec.sessionId}  turn=${rec.turn} step=${rec.step} attempt=${rec.attempt}`,
    `# provider=${rec.provider} model=${rec.model}${rec.purpose === undefined ? '' : ` purpose=${rec.purpose}`}`,
    `# controls ${JSON.stringify(rec.controls ?? {})}`,
    `# messages=${messages.length} tools=${tools.length}`,
  ]
  if (tools.length > 0) lines.push(`# tool-names ${tools.map(tool => String(tool?.name ?? '?')).join(', ')}`)
  lines.push('')
  messages.forEach((message, index) => {
    const role = String(message?.role ?? 'unknown')
    const source = message?.source?.kind ?? message?.source?.type
    lines.push(`### [${index}] ${role}${source === undefined ? '' : ` source=${source}`}`)
    const content = message?.content
    const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }]
    for (const block of blocks) {
      lines.push(renderBlock(block))
      lines.push('')
    }
  })
  return lines.join('\n')
}

/**
 * Count messages and UTF-16 characters without serializing the request.
 * @param {object} rec - capture record.
 * @returns {{messages: number, chars: number, tools: number}} cheap statistics.
 */
export function measure(rec) {
  const options = rec.options ?? {}
  const messages = Array.isArray(options.messages) ? options.messages : []
  let chars = 0
  for (const message of messages) {
    const content = message?.content
    if (typeof content === 'string') {
      chars += content.length
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (typeof block.text === 'string') chars += block.text.length
      else if (typeof block.arguments === 'string') chars += block.arguments.length
      else if (block.content !== undefined) chars += JSON.stringify(block.content).length
    }
  }
  return { messages: messages.length, chars, tools: Array.isArray(options.tools) ? options.tools.length : 0 }
}

/**
 * Summarize one record for the shared index file.
 * @param {object} rec - capture record.
 * @param {string} dirName - case directory name.
 * @param {object} stats - measured statistics.
 * @returns {object} index row.
 */
export function indexRow(rec, dirName, stats) {
  return {
    schema: 1,
    id: rec.id,
    case: dirName,
    time: new Date(rec.startedAt).toISOString(),
    elapsedMs: rec.endedAt === undefined ? null : rec.endedAt - rec.startedAt,
    sessionId: rec.sessionId,
    turn: rec.turn,
    step: rec.step,
    attempt: rec.attempt,
    provider: rec.provider,
    model: rec.model,
    purpose: rec.purpose ?? null,
    outcome: rec.outcome ?? null,
    httpStatus: rec.wire?.status ?? null,
    requestId: rec.wire?.requestId ?? null,
    messages: stats.messages,
    chars: stats.chars,
    tools: stats.tools,
    usage: rec.usage ?? null,
  }
}

/**
 * Recursively size a directory, ignoring failures.
 * @param {string} dir - directory.
 * @returns {Promise<number>} total bytes.
 */
export async function dirSize(dir) {
  let total = 0
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) total += await dirSize(target)
    else {
      try {
        total += (await fsp.stat(target)).size
      } catch {
        // A concurrent prune removed the file; size accounting can skip it.
      }
    }
  }
  return total
}

/**
 * List case directories oldest-first with their modification time.
 * @param {string} casesDir - cases root.
 * @returns {Promise<Array<{name: string, mtimeMs: number}>>} entries.
 */
export async function listCaseDirs(casesDir) {
  let entries
  try {
    entries = await fsp.readdir(casesDir, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const target = path.join(casesDir, entry.name)
    try {
      found.push({ name: entry.name, mtimeMs: (await fsp.stat(target)).mtimeMs })
    } catch {
      // Vanished between readdir and stat; nothing to prune.
    }
  }
  return found.sort((a, b) => a.mtimeMs - b.mtimeMs)
}

/**
 * Remove a directory tree, ignoring failures.
 * @param {string} dir - directory.
 * @returns {Promise<void>} completion.
 */
export async function removeDir(dir) {
  try {
    await fsp.rm(dir, { recursive: true, force: true })
  } catch {
    // Pruning is best-effort; the next sweep retries.
  }
}

/** Re-exported for callers that only need the synchronous variant. */
export { fs }