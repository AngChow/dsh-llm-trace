/**
 * The `llm_trace` Host tool.
 *
 * Reads only what the bundle already wrote, so every action works while the
 * switch is off. Output is capped: the model gets a summary, the user gets the
 * files.
 *
 * @module @local/dsh-llm-trace/lib/tool
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { dirSize, listCaseDirs } from './io.js'

/** Largest tool result returned to the model. */
const RESULT_CAP = 24_000

/**
 * Cap a tool result, marking the cut.
 * @param {string} text - rendered result.
 * @returns {string} capped text.
 */
function cap(text) {
  const value = String(text ?? '')
  return value.length <= RESULT_CAP ? value : `${value.slice(0, RESULT_CAP)}\n…[truncated]`
}

/**
 * Read the tail of the shared index file.
 * @param {string} file - index path.
 * @param {number} limit - maximum rows.
 * @returns {Promise<object[]>} parsed rows, oldest first.
 */
async function readIndex(file, limit) {
  let raw
  try {
    raw = await fsp.readFile(file, 'utf8')
  } catch {
    return []
  }
  const lines = raw.split('\n').filter(line => line.trim() !== '')
  const rows = []
  for (const line of lines.slice(-limit)) {
    try { rows.push(JSON.parse(line)) } catch { /* a partial trailing line is ignored */ }
  }
  return rows
}

/**
 * Locate one case directory.
 * @param {string} casesDir - cases root.
 * @param {string} target - case name or `latest`.
 * @returns {Promise<{name: string, dir: string}|null>} the resolved case.
 */
async function resolveCase(casesDir, target) {
  const wanted = String(target ?? 'latest').trim()
  if (wanted === '' || wanted === 'latest') {
    const dirs = await listCaseDirs(casesDir)
    const last = dirs.at(-1)
    return last === undefined ? null : { name: last.name, dir: path.join(casesDir, last.name) }
  }
  try {
    const stat = await fsp.stat(path.join(casesDir, wanted))
    return stat.isDirectory() ? { name: wanted, dir: path.join(casesDir, wanted) } : null
  } catch {
    return null
  }
}

/**
 * Summarize the largest messages of one captured request.
 * @param {object} request - captured request document.
 * @param {number} limit - how many messages to list.
 * @returns {string[]} summary lines.
 */
function messageSummary(request, limit) {
  const messages = Array.isArray(request?.messages) ? request.messages : []
  const sized = messages.map((message, index) => {
    const blocks = Array.isArray(message?.content) ? message.content : []
    let chars = 0
    let head = ''
    for (const block of blocks) {
      if (typeof block?.text === 'string') {
        chars += block.text.length
        if (head === '') head = block.text
      } else if (typeof block?.arguments === 'string') {
        chars += block.arguments.length
      } else if (block?.content !== undefined) {
        chars += JSON.stringify(block.content).length
      }
    }
    return { index, role: String(message?.role ?? '?'), chars, head: head.replace(/\s+/g, ' ').slice(0, 100) }
  })
  return sized
    .sort((a, b) => b.chars - a.chars)
    .slice(0, limit)
    .map(item => `  [${item.index}] ${item.role} ${item.chars} chars — ${item.head}`)
}

/**
 * Build the tool executor over one plugin state facade.
 * @param {object} api - bundle facade.
 * @returns {(args: object) => Promise<string>} executor.
 */
export function createToolHandler(api) {
  return async function execute(args) {
    const action = String(args?.action ?? 'status').trim().toLowerCase()
    if (action === 'enable' || action === 'disable') {
      const outcome = await api.setEnabled(action === 'enable')
      return cap(outcome)
    }
    if (action === 'status') {
      const enabled = api.enabled()
      const root = api.root()
      let exists = false
      try { exists = (await fsp.stat(root)).isDirectory() } catch { /* absent root simply reports false */ }
      const casesDir = path.join(root, 'cases')
      const dirs = await listCaseDirs(casesDir)
      const total = exists ? await dirSize(casesDir) : 0
      const lines = [
        `开关: ${enabled ? '已开启' : '已关闭'}`,
        `目录: ${root}`,
        `模式: ${api.config().mode}`,
        `已存在: ${exists ? '是' : '否'}`,
        `case 数: ${dirs.length}`,
        `占用: ${(total / 1048576).toFixed(2)} MiB`,
        `最近 case: ${dirs.at(-1)?.name ?? '（无）'}`,
        `wire 捕获: ${api.config().captureWire === true ? '开' : '关'}`,
        `客户端注册: ${{ registered: '已进入 boot graph', absent: '未进入 boot graph', unknown: '未知（无 clientModules 服务）' }[api.clientState?.() ?? 'unknown']}`,
      ]
      return cap(lines.join('\n'))
    }
    if (action === 'list') {
      const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(200, Number(args.limit))) : 15
      const rows = await readIndex(path.join(api.root(), 'index.jsonl'), limit)
      if (rows.length === 0) return '还没有采集到 case。'
      const lines = rows.map((row) => {
        const code = row.outcome?.kind === 'error' ? `${row.outcome.code ?? 'ERROR'} ${row.httpStatus ?? ''}`.trim() : String(row.outcome?.kind ?? '?')
        return `${row.time}  ${row.model}  t${row.turn}-s${row.step}  ${code}  ${row.messages} msgs / ${row.chars} chars  → ${row.case}`
      })
      return cap(lines.join('\n'))
    }
    if (action === 'show') {
      const found = await resolveCase(path.join(api.root(), 'cases'), args?.target)
      if (found === null) return `没有找到 case：${String(args?.target ?? 'latest')}`
      const lines = [`case: ${found.name}`, `目录: ${found.dir}`]
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(found.dir, 'meta.json'), 'utf8'))
        lines.push(`时间: ${meta.time}  provider=${meta.provider} model=${meta.model}`)
        lines.push(`位置: session=${meta.key?.sessionId} turn=${meta.key?.turn} step=${meta.key?.step} attempt=${meta.key?.attempt}`)
        lines.push(`规模: ${meta.request?.messages} 条消息 / ${meta.request?.chars} 字符 / ${meta.request?.tools} 个工具`)
        lines.push(`结果: ${JSON.stringify(meta.outcome)}`)
        if (meta.usage !== undefined) lines.push(`用量: ${JSON.stringify(meta.usage)}`)
      } catch {
        lines.push('meta.json 读取失败')
      }
      try {
        const request = JSON.parse(await fsp.readFile(path.join(found.dir, 'request.json'), 'utf8'))
        lines.push('最大的几条消息:')
        lines.push(...messageSummary(request, 8))
      } catch {
        lines.push('request.json 读取失败')
      }
      for (const name of ['wire.response.txt', 'wire.headers.json']) {
        try {
          const text = await fsp.readFile(path.join(found.dir, name), 'utf8')
          lines.push(`--- ${name} ---`)
          lines.push(text.slice(0, 4000))
        } catch {
          // Optional file absent for this case.
        }
      }
      return cap(lines.join('\n'))
    }
    if (action === 'grep') {
      const pattern = String(args?.pattern ?? '')
      if (pattern === '') return 'grep 需要提供 pattern。'
      const found = await resolveCase(path.join(api.root(), 'cases'), args?.target)
      if (found === null) return `没有找到 case：${String(args?.target ?? 'latest')}`
      let text
      try {
        text = await fsp.readFile(path.join(found.dir, 'request.txt'), 'utf8')
      } catch {
        return 'request.txt 不存在。'
      }
      const needle = pattern.toLowerCase()
      const lines = text.split('\n')
      const hits = []
      let header = '?'
      lines.forEach((line, index) => {
        if (line.startsWith('### [')) header = line
        if (hits.length < 40 && line.toLowerCase().includes(needle)) {
          hits.push(`  ${found.name}:${index + 1}  ${header}  ${line.replace(/\s+/g, ' ').slice(0, 140)}`)
        }
      })
      if (hits.length === 0) return `在 ${found.name} 里没有找到 ${pattern}`
      return cap([`在 ${found.name} 里命中 ${hits.length} 处（最多列 40）:`, ...hits].join('\n'))
    }
    if (action === 'prune') {
      return cap(await api.prune(true))
    }
    return `未知 action：${action}（可用：status / list / show / grep / enable / disable / prune）`
  }
}