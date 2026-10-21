/**
 * dsh-alicoupon — browser half.
 *
 * 在侧边栏底部（`sidebar.footer.action`，和 dsh-cost-meter 的余额行同一个槽位）
 * 渲染一行代金券余额：`阿里云代金券  ¥286.18 / ¥300`。
 *
 * 数据来自宿主半边的只读路由：
 *   GET  /plugins/dsh-alicoupon/state     快照（宿主按 refreshMinutes 缓存，不打阿里云）
 *   POST /plugins/dsh-alicoupon/refresh   点一下 / 回车，强制刷新
 *
 * 刷新节奏：挂载即取一次 → 每 60 秒取一次 → 页面重新可见 / 窗口聚焦时各取一次 →
 * 点那行立即取一次。失败后自动退避到 5 分钟一次，避免宿主机票一直报错刷屏。
 *
 * 缩窄成 56px 导轨时只显示金额（和 cost-meter 的余额行一样）；宿主半个插件不在、
 * 或路由没挂上时显示「查询失败」而不是静默消失。
 */
window.__ModuleLoader__.load({
  id: 'dsh-alicoupon',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React

    /** Tooltip 来自 DSH 的 UI 基础件；拿不到就退化成没有悬停说明（不抛错）。 */
    let Tooltip = null
    try {
      Tooltip = require('@deepseek-ai/dsh-client-ui-primitives').Tooltip ?? null
    } catch {
      Tooltip = null
    }

    const PACKAGE = 'dsh-alicoupon'
    const ROUTE_PREFIX = '/plugins/dsh-alicoupon'
    const STATE_URL = `${ROUTE_PREFIX}/state`
    const REFRESH_URL = `${ROUTE_PREFIX}/refresh`
    const POLL_MS = 60_000
    const BACKOFF_MS = 300_000
    /**
     * 每次请求都换一个唯一的 query，避免被中间层（Electron 自定义协议 dsh-app://
     * 的响应缓存、任何代理）按 URL 缓存住，导致数字停在打开页面那一刻。
     */
    const bust = () => `?_=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const STYLE_ID = 'dsh-alicoupon/client.css'

    /** 行距/内边距/圆角对齐 cost-meter 的 `.cm-foot`，看起来才像原生的。 */
    const CSS = `
.dsa-row{display:flex;align-items:center;gap:6px;height:32px;padding:0 8px;border-radius:8px;
  min-width:0;max-width:100%;box-sizing:border-box;font-size:12px;line-height:1;
  white-space:nowrap;overflow:hidden;cursor:pointer;color:var(--dsw-alias-label-secondary,#4b5563);
  font-variant-numeric:tabular-nums}
.dsa-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsa-row:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#2563eb);outline-offset:1px}
.dsa-row[data-rail="true"]{width:100%;padding:0;justify-content:center;gap:0;
  font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1b1c1f)}
.dsa-row[data-status="error"],.dsa-row[data-status="unconfigured"]{color:var(--dsw-alias-state-warning-primary,#b45309)}
.dsa-row[data-busy="true"]{opacity:.6}
.dsa-label{min-width:0;overflow:hidden;text-overflow:ellipsis}
.dsa-amount{flex:none;font-weight:600}
.dsa-total{flex:none;opacity:.65}
`
    function ensureStyle() {
      if (typeof document === 'undefined' || document.head === undefined) return
      const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`)
      if (existing !== null && existing.textContent === CSS) return
      const tag = existing ?? document.createElement('style')
      tag.dataset.plugin = PACKAGE
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      if (existing === null) document.head.appendChild(tag)
    }

    const SYMBOLS = { CNY: '¥', USD: '$', EUR: '€', JPY: '¥' }

    function money(value, unit, digits) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      const symbol = SYMBOLS[unit] ?? (typeof unit === 'string' && unit !== '' ? `${unit} ` : '')
      const places = typeof digits === 'number' ? digits : Math.abs(value) >= 1000 ? 0 : 2
      return `${symbol}${value.toFixed(places)}`
    }

    function stamp(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
      try {
        return new Date(ms).toLocaleTimeString()
      } catch {
        return ''
      }
    }

    function tooltipOf(state) {
      if (state === null) return '正在查询代金券余额…'
      if (state.status !== 'ok') {
        return `${state.title ?? state.label ?? '阿里云代金券'}\n${state.message ?? '查询失败'}\n点击立即重试`
      }
      const lines = [state.title ?? state.label ?? '阿里云代金券']
      lines.push(`剩余 ${money(state.remaining, state.unit)} / 面值 ${money(state.maxBudget, state.unit)}`)
      if (typeof state.count === 'number' && state.count > 0) lines.push(`可用券 ${state.count} 张`)
      lines.push(`更新于 ${stamp(state.updatedAt)} · 点击立即刷新`)
      return lines.join('\n')
    }

    function CouponRow(props) {
      const wide = props?.wide !== false
      const [state, setState] = useState(null)
      const [busy, setBusy] = useState(false)
      const nextAllowed = useRef(0)

      const pull = useCallback(async (force) => {
        setBusy(true)
        try {
          const response = await fetch(`${force === true ? REFRESH_URL : STATE_URL}${bust()}`, {
            cache: 'no-store',
            method: force === true ? 'POST' : 'GET',
          })
          if (!response.ok) throw new Error(`宿主路由返回 HTTP ${response.status}`)
          const next = await response.json()
          nextAllowed.current = next.status === 'ok' ? 0 : Date.now() + BACKOFF_MS
          setState(next)
        } catch (error) {
          nextAllowed.current = Date.now() + BACKOFF_MS
          setState({
            status: 'error',
            label: '阿里云代金券',
            title: '阿里云代金券 · 查询失败',
            unit: 'CNY',
            remaining: null,
            maxBudget: null,
            count: 0,
            message: `读不到宿主状态：${error?.message ?? error}`,
            updatedAt: Date.now(),
          })
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => {
        ensureStyle()
        pull(false)
        const timer = window.setInterval(() => {
          // 故意不看 document.hidden：Electron 里 visibilityState 有时一直是 hidden，
          // 一旦跳过就再也不会自己刷新。这里只是读宿主的内存快照，60 秒一次没有代价。
          if (Date.now() < nextAllowed.current) return
          pull(false)
        }, POLL_MS)
        const onWake = () => {
          if (document.visibilityState === 'visible') pull(false)
        }
        document.addEventListener('visibilitychange', onWake)
        window.addEventListener('focus', onWake)
        return () => {
          window.clearInterval(timer)
          document.removeEventListener('visibilitychange', onWake)
          window.removeEventListener('focus', onWake)
        }
      }, [pull])

      const status = state?.status ?? 'loading'
      const failed = status === 'error' || status === 'unconfigured'
      const label = state?.label ?? '阿里云代金券'
      const unit = state?.unit ?? 'CNY'
      const compact = !wide ? money(state?.remaining, unit, 0) : ''

      const children = []
      if (!wide) {
        children.push(React.createElement('span', { key: 'rail' }, failed ? '⚠' : status === 'loading' ? '…' : compact))
      } else {
        children.push(
          React.createElement(
            'span',
            { className: 'dsa-label', key: 'label' },
            status === 'unconfigured' ? `${label} · 待配置` : status === 'error' ? `${label} · 查询失败` : label,
          ),
        )
        if (!failed) {
          children.push(React.createElement('span', { className: 'dsa-amount', key: 'amount' }, money(state?.remaining, unit)))
          // 面值、张数、更新时间都留在悬停说明里，行里只放「标签 + 余额」，和 cost-meter 的余额行一致。
        }
      }

      const row = React.createElement(
        'div',
        {
          className: 'dsa-row',
          'data-status': status,
          'data-rail': wide ? 'false' : 'true',
          'data-busy': busy ? 'true' : 'false',
          role: 'button',
          tabIndex: 0,
          'aria-label': tooltipOf(state),
          onClick: () => { if (!busy) pull(true) },
          onKeyDown: (event) => {
            if ((event.key === 'Enter' || event.key === ' ') && !busy) {
              event.preventDefault()
              pull(true)
            }
          },
        },
        children,
      )

      if (Tooltip === null) return React.createElement('div', { title: tooltipOf(state) }, row)
      return React.createElement(
        Tooltip,
        {
          label: React.createElement('span', { style: { whiteSpace: 'pre-line' } }, tooltipOf(state)),
          side: 'right',
          delayMs: 300,
        },
        row,
      )
    }

    function apply(ctx) {
      ensureStyle()
      ctx.effect(
        () => ctx.slots.register({ name: 'sidebar.footer.action', id: PACKAGE, order: -1 }, CouponRow),
        'dsh-alicoupon: coupon row',
      )
    }

    exports.name = PACKAGE
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})