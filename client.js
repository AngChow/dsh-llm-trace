/**
 * 模型请求落盘 —— 设置页（Client 半区，浏览器）。
 *
 * 只注册一个 `settings.plugins.tab` 页签（与「自选行情」「任务完成通知」同一位置），
 * 数据全部走 Host 的 `/api/llm-trace` 路由，因此不依赖浏览器的配置表单服务：
 * 少一个可选服务，就少一种静默待命的失败模式。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-llm-trace',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const CHANNEL = '/api/llm-trace'
    const NS = 'settings.llmTrace'

    const zh = {
      'meta.title': '模型请求落盘',
      'meta.description': '把每次模型调用的输入与请求明细写到磁盘，便于事后检查内容审核中断的原因。',
      'switch.on': '正在采集',
      'switch.off': '未采集',
      'switch.enable': '打开采集',
      'switch.disable': '关闭采集',
      'field.dir': '落盘目录',
      'field.mode': '采集模式',
      'field.cases': '已落盘 case',
      'field.size': '占用空间',
      'field.last': '最近一次',
      'field.wire': 'wire 捕获',
      'value.none': '（无）',
      'value.on': '开',
      'value.off': '关',
      'action.refresh': '刷新',
      'action.prune': '清理过期',
      'status.loading': '读取中…',
      'hint.enabled': '已开启：下一次模型调用会按模式落盘。撞上内容审核中断后，用 llm_trace show latest 直接看那次请求。',
      'hint.disabled': '当前关闭。需要排查时打开它，跑一次会话，再关闭即可——不会长期占盘。',
    }

    const en = {
      'meta.title': 'Model request trace',
      'meta.description': 'Write each model call\u2019s input and wire details to disk so a content-moderation interruption can be inspected afterwards.',
      'switch.on': 'Recording',
      'switch.off': 'Not recording',
      'switch.enable': 'Start recording',
      'switch.disable': 'Stop recording',
      'field.dir': 'Output directory',
      'field.mode': 'Mode',
      'field.cases': 'Captured cases',
      'field.size': 'On disk',
      'field.last': 'Latest',
      'field.wire': 'Wire capture',
      'value.none': '(none)',
      'value.on': 'on',
      'value.off': 'off',
      'action.refresh': 'Refresh',
      'action.prune': 'Prune expired',
      'status.loading': 'Loading…',
      'hint.enabled': 'Recording: the next model call is written according to the mode. After a moderation interruption, run llm_trace show latest.',
      'hint.disabled': 'Currently off. Turn it on when you need to inspect a session, then turn it off again.',
    }

    /**
     * Call the Host route.
     * @param {string} method - RPC method name.
     * @param {object} [extra] - additional payload.
     * @returns {Promise<any>} the answer value.
     */
    async function rpc(method, extra) {
      const response = await fetch(CHANNEL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, ...extra }),
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
        throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
      }
      return payload.value
    }

    const page = { display: 'flex', flexDirection: 'column', gap: '16px', padding: '4px 2px 12px' }
    const header = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }
    const heading = { fontSize: '15px', lineHeight: '22px', color: 'var(--dsw-alias-label-primary, #1f2329)' }
    const sub = { marginTop: '4px', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #646a73)' }
    const card = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '16px',
      padding: '14px 16px',
      border: '1px solid var(--dsw-alias-border-l2, rgba(31, 35, 41, 0.12))',
      borderRadius: '10px',
      background: 'var(--dsw-alias-bg-primary, #ffffff)',
    }
    const label = { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-primary, #1f2329)' }
    const hint = { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #646a73)' }
    const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px 16px' }
    const cell = { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #646a73)' }
    const cellValue = {
      marginLeft: '6px',
      color: 'var(--dsw-alias-label-primary, #1f2329)',
      wordBreak: 'break-all',
    }
    const button = {
      padding: '5px 12px',
      fontSize: '12px',
      lineHeight: '18px',
      borderRadius: '8px',
      border: '1px solid var(--dsw-alias-border-l2, rgba(31, 35, 41, 0.15))',
      background: 'var(--dsw-alias-bg-primary, #ffffff)',
      color: 'var(--dsw-alias-label-primary, #1f2329)',
      cursor: 'pointer',
    }
    const track = wide => ({
      position: 'relative',
      display: 'inline-flex',
      alignItems: 'center',
      flex: '0 0 auto',
      width: '40px',
      height: '22px',
      padding: '2px',
      border: '1px solid var(--dsw-alias-border-l2, rgba(31, 35, 41, 0.15))',
      borderRadius: '999px',
      background: wide ? 'var(--dsw-alias-brand-primary, #3370ff)' : 'var(--dsw-alias-bg-secondary, #f2f3f5)',
      cursor: 'pointer',
      transition: 'background 120ms ease',
    })
    const knob = wide => ({
      display: 'block',
      width: '18px',
      height: '18px',
      borderRadius: '50%',
      background: '#ffffff',
      boxShadow: '0 1px 2px rgba(0, 0, 0, 0.2)',
      transform: wide ? 'translateX(18px)' : 'translateX(0)',
      transition: 'transform 120ms ease',
    })

    /**
     * Render the settings page.
     * @param {object} props - localized translator.
     * @returns {object} React element.
     */
    function SettingsPage({ t }) {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(async () => {
        try {
          setState(await rpc('state'))
          setError(null)
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        }
      }, [])

      React.useEffect(() => {
        void load()
        const timer = setInterval(() => { void load() }, 4000)
        return () => { clearInterval(timer) }
      }, [load])

      const apply = async (method, extra) => {
        setBusy(true)
        try {
          setState(await rpc(method, extra))
          setError(null)
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }

      const active = state !== null && state.enabled === true
      const ready = state !== null

      const fields = ready ? [
        ['field.dir', state.dir],
        ['field.mode', state.mode],
        ['field.cases', String(state.cases)],
        ['field.size', `${state.totalMiB} MiB`],
        ['field.last', state.lastCase ?? t('value.none')],
        ['field.wire', state.captureWire ? t('value.on') : t('value.off')],
      ] : []

      return h('div', { style: page },
        h('div', { style: header },
          h('div', null,
            h('div', { style: heading }, t('meta.title')),
            h('div', { style: sub }, t('meta.description')),
          ),
          h('div', { style: { display: 'flex', gap: '8px', flex: '0 0 auto' } },
            h('button', { type: 'button', style: button, disabled: busy, onClick: () => { void load() } }, t('action.refresh')),
            h('button', { type: 'button', style: button, disabled: busy, onClick: () => { void apply('prune') } }, t('action.prune')),
          ),
        ),
        h('div', { style: card },
          h('div', null,
            h('div', { style: label }, active ? t('switch.on') : (ready ? t('switch.off') : t('status.loading'))),
            h('div', { style: hint }, active ? t('hint.enabled') : t('hint.disabled')),
          ),
          h('button', {
            type: 'button',
            role: 'switch',
            'aria-checked': active,
            'aria-label': active ? t('switch.disable') : t('switch.enable'),
            disabled: !ready || busy,
            onClick: () => { void apply('set-enabled', { enabled: !active }) },
            style: {
              ...track(active),
              opacity: !ready || busy ? 0.5 : 1,
              cursor: !ready || busy ? 'not-allowed' : 'pointer',
            },
          }, h('span', { style: knob(active) })),
        ),
        error === null ? null : h('div', { style: { ...hint, color: 'var(--dsw-alias-label-warning, #d46b08)' } }, `调用失败：${error}`),
        ready ? h('div', { style: grid }, fields.map(([key, value]) => h('div', { key, style: cell },
          `${t(key)}:`,
          h('span', { style: cellValue }, value),
        ))) : null,
      )
    }

    /**
     * Register the locale namespace and return a translator.
     * @param {object} ctx - browser plugin context.
     * @returns {{t: (key: string) => string, disposeRegister: (() => void) | null}} translator.
     */
    function makeTranslator(ctx) {
      try {
        if (ctx.locale?.register && ctx.locale?.bind) {
          const disposeRegister = ctx.locale.register(NS, { zh, en })
          const bound = ctx.locale.bind(NS)
          const t = (key) => {
            const translated = bound(key)
            return typeof translated === 'string' && translated.length > 0 ? translated : (zh[key] ?? key)
          }
          return { t, disposeRegister: typeof disposeRegister === 'function' ? disposeRegister : null }
        }
      } catch {
        // Fall through to the static table.
      }
      return { t: (key) => zh[key] ?? key, disposeRegister: null }
    }

    return {
      // 声明门控：不声明就直接访问 ctx.slots / ctx.locale 会抛错，client entry 变 failed。
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          const { t, disposeRegister } = makeTranslator(ctx)
          if (disposeRegister !== null) ctx.effect(() => disposeRegister, 'llm-trace: locale')
          ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register(
            { name: 'settings.plugins.tab', id: 'llm-trace', order: 51, label: () => t('meta.title') },
            () => h(SettingsPage, { t }),
          ))
          console.error('[llm-trace] settings tab registered')
        } catch (error) {
          // 宿主 renderer 只报 "failed"，原因不外露；这条会进崩溃报告。
          console.error(`[llm-trace] APPLY THREW: ${String(error?.stack ?? error)}`)
          throw error
        }
      },
    }
  },
})