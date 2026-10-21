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
/** 跟着 package.json 的 version 走：信标里带上它，才能看出浏览器加载的是不是最新那版。 */
const BUILD = '0.1.2'
    const ROUTE_PREFIX = '/plugins/dsh-alicoupon'
    const STATE_URL = `${ROUTE_PREFIX}/state`
    const REFRESH_URL = `${ROUTE_PREFIX}/refresh`
    const CONFIG_URL = `${ROUTE_PREFIX}/config`
    const CREDENTIALS_URL = `${ROUTE_PREFIX}/credentials`
    /** 与宿主 `CREDENTIAL_ROLES` 一致：这三个字段就是写凭据时要传的名字。 */
    const CREDENTIAL_ROLES = ['accessKeyId', 'accessKeySecret', 'securityToken']
    const POLL_MS = 60_000
    const BACKOFF_MS = 300_000
    const DEBUG_URL = `${ROUTE_PREFIX}/debug`

    /**
     * 排障用的迷你信标：把「客户端到底走到哪一步」告诉宿主。宿主写进 client.log，
     * 并在 /state 的 diagnostics 里回一份。桌面 App 里看不到渲染进程的 console，
     * 没有这个就只能靠猜「是没加载、没注册、还是渲染挂了」。
     * 只在关键节点发，每条几十字节，`text/plain` 免得触发跨源预检，失败也吞掉。
     */
    let reportBudget = 16
    const report = (event, detail) => {
      if (reportBudget <= 0) return
      reportBudget -= 1
      try {
        void fetch(DEBUG_URL, {
          method: 'POST',
          cache: 'no-store',
          headers: { 'content-type': 'text/plain' },
          body: JSON.stringify({ event, detail, at: new Date().toISOString() }),
          keepalive: true,
        }).catch(() => {})
      } catch {
        /* 信标永远不该影响那一行 */
      }
    }

    /** 配置面板用 portal 挂到 body 上，免得被侧边栏的 overflow / transform 裁掉或挪位。 */
    let createPortal = null
    try {
      createPortal = require('react-dom').createPortal ?? null
    } catch {
      createPortal = null
    }
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
.dsa-panel{position:fixed;z-index:2147483000;box-sizing:border-box;padding:12px;border-radius:12px;
  border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.28));
  background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-label-primary,#1b1c1f);
  box-shadow:0 10px 30px rgba(0,0,0,.18);font-size:12px;line-height:1.5}
.dsa-panel[data-embedded="true"]{position:static;box-shadow:none;width:auto;max-width:520px}
.dsa-panel h4{margin:0 0 8px;font-size:13px;font-weight:600}
.dsa-panel label{display:block;margin:8px 0 4px;color:var(--dsw-alias-label-secondary,#4b5563)}
.dsa-panel input,.dsa-panel select{width:100%;box-sizing:border-box;padding:5px 8px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.28));
  background:var(--dsw-alias-bg-primary,transparent);color:inherit;font:inherit}
.dsa-panel .dsa-actions{display:flex;gap:8px;align-items:center;margin-top:12px}
.dsa-panel button{padding:5px 10px;border-radius:8px;cursor:pointer;font:inherit;
  border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.28));
  background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:inherit}
.dsa-panel button[data-primary="true"]{background:var(--dsw-alias-state-business-primary,#2563eb);
  border-color:transparent;color:#fff}
.dsa-panel button:disabled{opacity:.55;cursor:default}
.dsa-panel .dsa-hint{margin-top:8px;color:var(--dsw-alias-label-tertiary,#6b7280);white-space:pre-line}
.dsa-panel .dsa-warn{color:var(--dsw-alias-state-warning-primary,#b45309)}
.dsa-value{margin:4px 0 0;font-variant-numeric:tabular-nums}
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
        return `${state.title ?? state.label ?? '阿里云代金券'}\n${state.message ?? '查询失败'}\n点击这行打开配置`
      }
      const lines = [state.title ?? state.label ?? '阿里云代金券']
      lines.push(`剩余 ${money(state.remaining, state.unit)} / 面值 ${money(state.maxBudget, state.unit)}`)
      if (typeof state.count === 'number' && state.count > 0) lines.push(`可用券 ${state.count} 张`)
      lines.push(`更新于 ${stamp(state.updatedAt)}`)
      lines.push('点击这行：改标签 / 刷新间隔，或立即刷新')
      return lines.join('\n')
    }

    /** 快照里那几个数字，给人看的两三行。 */
    function valueLines(state) {
      if (state === null) return ['正在查询…']
      if (state.status !== 'ok') return [state.message ?? '查询失败']
      return [
        `剩余 ${money(state.remaining, state.unit)} / 面值 ${money(state.maxBudget, state.unit)}`,
        `${typeof state.count === 'number' && state.count > 0 ? `${state.count} 张可用` : '没有可用券'}${
          typeof state.expiresAt === 'string' && state.expiresAt !== '' ? ` · ${state.expiresAt} 到期` : ''
        }`,
        `更新于 ${stamp(state.updatedAt)}`,
      ]
    }

    /**
     * 配置面板：标签、刷新间隔（落盘到宿主的 config.json，改完立即生效）、立即刷新，
     * 以及凭据——面板可以把 AK/Secret 交给宿主写进 DSH 凭据库（宿主 `POST /credentials`），
     * 写完立刻查一次阿里云，所以「键贴错了 / 没权限」会当场看到原话。
     * 浏览器这边只是把用户输入转发给宿主，自己不保存、不落盘、也不回显。
     */
    function ConfigPanel(props) {
      const embedded = props?.embedded === true
      const panelRef = props?.panelRef ?? null
      const [info, setInfo] = useState(null)
      const [label, setLabel] = useState('')
      const [minutes, setMinutes] = useState(1)
      const [accessKeyId, setAccessKeyId] = useState('')
      const [accessKeySecret, setAccessKeySecret] = useState('')
      const [securityToken, setSecurityToken] = useState('')
      const [note, setNote] = useState('')
      const [credNote, setCredNote] = useState('')
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const response = await fetch(`${CONFIG_URL}${bust()}`, { cache: 'no-store' })
            const body = await response.json()
            if (!alive || body?.ok !== true) return
            setInfo(body)
            setLabel(body.config.label)
            setMinutes(body.config.refreshMinutes)
          } catch (error) {
            if (alive) setNote(`读不到配置：${error?.message ?? error}`)
          }
        })()
        return () => {
          alive = false
        }
      }, [])

      const notify = useCallback((text) => {
        setNote(text)
        try {
          props?.onChanged?.()
        } catch {
          /* 调用方（行）自己的状态更新失败不该影响面板 */
        }
      }, [props])

      const save = useCallback(async () => {
        setBusy(true)
        setNote('')
        try {
          const response = await fetch(`${CONFIG_URL}${bust()}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ label, refreshMinutes: Number(minutes) }),
          })
          const body = await response.json()
          if (body?.ok !== true) throw new Error(body?.error ?? `HTTP ${response.status}`)
          setInfo((prev) => (prev === null ? prev : { ...prev, config: body.config }))
          notify(`已保存（宿主每 ${body.config.refreshMinutes} 分钟查一次）`)
        } catch (error) {
          setNote(`保存失败：${error?.message ?? error}`)
        } finally {
          setBusy(false)
        }
      }, [label, minutes, notify])

      const refreshNow = useCallback(async () => {
        setBusy(true)
        setNote('')
        try {
          const response = await fetch(`${REFRESH_URL}${bust()}`, { method: 'POST', cache: 'no-store' })
          const body = await response.json()
          notify(body?.status === 'ok' ? '已向阿里云重新查询' : `刷新失败：${body?.message ?? body?.error ?? '未知原因'}`)
        } catch (error) {
          setNote(`刷新失败：${error?.message ?? error}`)
        } finally {
          setBusy(false)
        }
      }, [notify])

      /** `clear === true` 表示把凭据库里这三个 ref 删掉；否则只写填了的字段（留空 = 不动）。 */
      const saveCredentials = useCallback(async (clear) => {
        setBusy(true)
        setCredNote('')
        try {
          const body = clear
            ? { clear: CREDENTIAL_ROLES }
            : { accessKeyId, accessKeySecret, securityToken }
          const response = await fetch(`${CREDENTIALS_URL}${bust()}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          const result = await response.json()
          const results = Array.isArray(result?.results) ? result.results : null
          if (results === null) throw new Error(result?.error ?? `HTTP ${response.status}`)
          const lines = results.map((entry) =>
            entry.ok
              ? `${entry.ref}：${entry.action === 'cleared' ? '已清除' : '已保存'}`
              : `${entry.ref}：失败 —— ${entry.error ?? '未知原因'}`,
          )
          lines.push(result.state?.status === 'ok' ? '阿里云返回正常 ✓' : `阿里云那边：${result.state?.message ?? '没有结果'}`)
          setCredNote(lines.join('\n'))
          if (result.credentials !== undefined) {
            setInfo((prev) => (prev === null ? prev : { ...prev, credentials: result.credentials }))
          }
          if (!clear) {
            // 写进凭据库之后就没必要在输入框里留着密钥了。
            setAccessKeyId('')
            setAccessKeySecret('')
            setSecurityToken('')
          }
          try {
            props?.onChanged?.()
          } catch {
            /* 行自己的刷新失败不该影响面板 */
          }
        } catch (error) {
          setCredNote(`保存失败：${error?.message ?? error}`)
        } finally {
          setBusy(false)
        }
      }, [accessKeyId, accessKeySecret, securityToken, props])

      const children = [React.createElement('h4', { key: 'title' }, '阿里云代金券')]

      if (props?.state !== undefined && props?.state !== null) {
        children.push(
          React.createElement(
            'div',
            { className: 'dsa-value', key: 'values' },
            valueLines(props.state).map((line, index) => React.createElement('div', { key: `v${index}` }, line)),
          ),
        )
      }

      children.push(
        React.createElement('label', { key: 'lb-label', htmlFor: 'dsa-label-input' }, '侧边栏那一行的标签'),
        React.createElement('input', {
          key: 'label',
          id: 'dsa-label-input',
          value: label,
          maxLength: info?.bounds?.maxLabel ?? 40,
          onChange: (event) => setLabel(event.target.value),
        }),
        React.createElement('label', { key: 'lb-min', htmlFor: 'dsa-minutes-input' }, '宿主查阿里云的间隔（分钟）'),
        React.createElement('input', {
          key: 'minutes',
          id: 'dsa-minutes-input',
          type: 'number',
          min: info?.bounds?.minRefreshMinutes ?? 1,
          max: info?.bounds?.maxRefreshMinutes ?? 1440,
          value: minutes,
          onChange: (event) => setMinutes(event.target.value),
        }),
        React.createElement(
          'div',
          { className: 'dsa-actions', key: 'actions' },
          React.createElement('button', { type: 'button', 'data-primary': 'true', disabled: busy, onClick: save }, '保存'),
          React.createElement('button', { type: 'button', disabled: busy, onClick: refreshNow }, '立即刷新'),
          embedded
            ? null
            : React.createElement('button', { type: 'button', disabled: busy, onClick: () => props?.onClose?.() }, '关闭'),
        ),
      )

      const credentials = info?.credentials ?? null
      const refLines = (credentials?.refs ?? []).map((entry) => {
        const where = entry.source === null || entry.source === undefined
          ? ''
          : `（来源 ${entry.source}${entry.writable === false ? '，只读' : ''}）`
        return `${entry.role}：${entry.configured ? `已配置${where}` : '未配置'} → ${entry.ref}`
      })
      const credentialLine =
        credentials === null
          ? '正在读凭据状态…'
          : credentials.configured
            ? '凭据已就绪 ✓'
            : `未找到凭据：${(credentials.missing ?? []).join(' / ')}`
      const canWriteCredentials = credentials !== null && credentials.writable !== false
      children.push(
        React.createElement('div', { className: 'dsa-hint', key: 'credtitle' }, '阿里云凭据（只读 AccessKey 即可）'),
        ...refLines.map((line, index) => React.createElement('div', { className: 'dsa-hint', key: `ref${index}` }, line)),
        React.createElement(
          'div',
          { className: credentials !== null && credentials.configured === false ? 'dsa-hint dsa-warn' : 'dsa-hint', key: 'cred' },
          credentialLine,
        ),
        React.createElement('label', { key: 'lb-ak', htmlFor: 'dsa-ak-input' }, 'AccessKey ID'),
        React.createElement('input', {
          key: 'ak',
          id: 'dsa-ak-input',
          value: accessKeyId,
          autoComplete: 'off',
          spellCheck: false,
          placeholder: '留空则不改',
          onChange: (event) => setAccessKeyId(event.target.value),
        }),
        React.createElement('label', { key: 'lb-sk', htmlFor: 'dsa-sk-input' }, 'AccessKey Secret'),
        React.createElement('input', {
          key: 'sk',
          id: 'dsa-sk-input',
          type: 'password',
          value: accessKeySecret,
          autoComplete: 'new-password',
          spellCheck: false,
          placeholder: '留空则不改',
          onChange: (event) => setAccessKeySecret(event.target.value),
        }),
        React.createElement('label', { key: 'lb-token', htmlFor: 'dsa-token-input' }, 'Security Token（只有 STS 临时凭据才要填）'),
        React.createElement('input', {
          key: 'token',
          id: 'dsa-token-input',
          type: 'password',
          value: securityToken,
          autoComplete: 'new-password',
          spellCheck: false,
          placeholder: '留空则不改',
          onChange: (event) => setSecurityToken(event.target.value),
        }),
        React.createElement(
          'div',
          { className: 'dsa-actions', key: 'cred-actions' },
          React.createElement(
            'button',
            { type: 'button', disabled: busy || !canWriteCredentials, onClick: () => saveCredentials(false) },
            '保存凭据',
          ),
          React.createElement(
            'button',
            { type: 'button', disabled: busy || !canWriteCredentials, onClick: () => saveCredentials(true) },
            '清除已保存的凭据',
          ),
        ),
        credNote === '' ? null : React.createElement('div', { className: 'dsa-hint', key: 'crednote' }, credNote),
      )
      children.push(
        React.createElement(
          'div',
          { className: 'dsa-hint', key: 'hint' },
          [
            '保存凭据 = 交给宿主写进 DSH 凭据库（~/.dsh/.credentials.yaml 的 refs）；密钥不回显、不落在这个界面里。',
            '若某个 ref 显示「来源 环境变量，只读」，说明它被环境变量遮蔽了，插件改不动它——改环境变量或先取消遮蔽。',
            info?.file !== undefined ? `配置落盘：${info.file}（优先于 cordis.patch.yml）` : '',
            note,
          ]
            .filter((line) => typeof line === 'string' && line !== '')
            .join('\n'),
        ),
      )

      return React.createElement(
        'div',
        { className: 'dsa-panel', 'data-embedded': embedded ? 'true' : 'false', ref: panelRef, style: props?.style },
        children,
      )
    }

    /** portal 里的面板不会自动跟着那行走，位置自己算：优先贴右边；右边不够就浮到那行上方。 */
    const PANEL_WIDTH = 300
    function panelPlacement(anchor, wide) {
      try {
        const width = Math.min(PANEL_WIDTH, Math.max(200, window.innerWidth - 24))
        if (anchor === undefined || anchor === null) return { left: 12, bottom: 12, width }
        const roomRight = window.innerWidth - anchor.right
        if (roomRight > width + 16) {
          return { left: anchor.right + 8, top: Math.max(8, wide === false ? anchor.top - 60 : anchor.top - 8), width }
        }
        return {
          left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)),
          bottom: Math.max(8, window.innerHeight - anchor.top + 8),
          width,
        }
      } catch {
        return { left: 12, bottom: 12, width: 288 }
      }
    }

    function CouponRow(props) {
      const wide = props?.wide !== false
      const [state, setState] = useState(null)
      const [busy, setBusy] = useState(false)
      const [open, setOpen] = useState(false)
      const [anchor, setAnchor] = useState(null)
      const nextAllowed = useRef(0)
      const rowRef = useRef(null)
      const panelRef = useRef(null)

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
          report('state', { status: next.status, http: response.status })
        } catch (error) {
          nextAllowed.current = Date.now() + BACKOFF_MS
          report('state-error', String(error?.message ?? error))
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
        report('row-mount', { wide })
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

      /** 面板挂在 portal 上，所以位置要自己按那行的位置算：优先贴右边，位置不够就浮到上方。 */
      const toggleOpen = useCallback(() => {
        setOpen((wasOpen) => {
          if (wasOpen) return false
          try {
            const rect = rowRef.current?.getBoundingClientRect()
            if (rect !== undefined && rect !== null) {
              setAnchor({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
            }
          } catch {
            setAnchor(null)
          }
          return true
        })
      }, [])

      useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          const path = typeof event.composedPath === 'function' ? event.composedPath() : []
          if (path.includes(panelRef.current) || path.includes(rowRef.current)) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [open])

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
          ref: rowRef,
          'data-status': status,
          'data-rail': wide ? 'false' : 'true',
          'data-busy': busy ? 'true' : 'false',
          'data-open': open ? 'true' : 'false',
          role: 'button',
          tabIndex: 0,
          'aria-expanded': open ? 'true' : 'false',
          'aria-label': tooltipOf(state),
          onClick: toggleOpen,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              toggleOpen()
            }
          },
        },
        children,
      )

      const panel = open
        ? React.createElement(ConfigPanel, {
            state,
            panelRef,
            style: panelPlacement(anchor, wide),
            onClose: () => setOpen(false),
            onChanged: () => { pull(false) },
          })
        : null
      const overlay = panel === null ? null : createPortal === null ? panel : createPortal(panel, document.body)

      const wrapped = Tooltip === null
        ? React.createElement('div', { title: tooltipOf(state) }, row)
        : React.createElement(
            Tooltip,
            {
              label: React.createElement('span', { style: { whiteSpace: 'pre-line' } }, tooltipOf(state)),
              side: 'right',
              delayMs: 300,
            },
            row,
          )
      return overlay === null ? wrapped : React.createElement(React.Fragment, null, wrapped, overlay)
    }

    /**
     * 只注册一行（`sidebar.footer.action`），不碰 `settings.section`：桌面 App 的 profile
     * 把 `@deepseek-ai/dsh-client-ui-settings` 关掉了（enabled: false），设置弹窗永远不渲染，
     * 多注册一个槽位只是多一个启动期失败点。
     *
     * 三条硬约束（违反任何一条，桌面 App 要么拒绝启动，要么这一行干脆不出现）：
     * 1. `apply` 必须同步返回 `undefined`——回调返回 thenable 会让 fiber 一直停在 loading；
     * 2. `apply` 绝不抛错，也不把 `slots` 写进插件自己的 `inject`（强依赖会让条目在启动
     *    审计窗口里处于非 active 状态）；
     * 3. 注册走 `slots.inject(slot, () => slots.register(...))`：槽位只在 sidebar 条目挂载时
     *    存在，直接 `register` 会被静默丢掉；`slots` 服务本身用 `ctx.slots`（退路
     *    `ctx.get('slots')`）现取，拿不到就每 100ms 再试，最多 10 秒。
     */
    const REGISTER_OPTIONS = { name: 'sidebar.footer.action', id: PACKAGE, order: -1 }

    /** `ctx.slots` 是主路；有些运行期要用 `ctx.get('slots')` 才拿得到。 */
    function resolveSlots(ctx) {
      try {
        if (ctx !== null && ctx !== undefined && ctx.slots !== undefined && ctx.slots !== null) return ctx.slots
        if (typeof ctx?.get === 'function') return ctx.get('slots')
      } catch (error) {
        report('slots-error', String(error?.message ?? error))
      }
      return undefined
    }

    function apply(ctx) {
      const slots = resolveSlots(ctx)
      report('apply', {
        slots: slots !== undefined,
        inject: typeof ctx?.inject,
        effect: typeof ctx?.effect,
        get: typeof ctx?.get,
        build: BUILD,
      })
      try {
        ensureStyle()
      } catch (error) {
        report('style-error', String(error?.message ?? error))
      }

      const install = () => {
        const target = resolveSlots(ctx)
        if (target === undefined || typeof target.register !== 'function') return false
        // 官方契约（client-ui-sidebar 的 slots.ts:53 与 dsh-cost-meter 都这么写）：
        // `slots.inject(slot, () => slots.register(...))` 会把注册挂到「调用者」的 fiber 上，
        // 并且等槽位主人（sidebar 条目）真的挂载后再登记。直接 register 会因为槽位还没
        // 声明而被丢掉，这正是「注册成功但界面上没有」的坑。
        if (typeof target.inject === 'function') {
          target.inject(REGISTER_OPTIONS.name, () => target.register(REGISTER_OPTIONS, CouponRow))
          report('register', { ok: true, via: 'inject', order: REGISTER_OPTIONS.order })
          return true
        }
        ctx.effect(() => target.register(REGISTER_OPTIONS, CouponRow), 'dsh-alicoupon: coupon row')
        report('register', { ok: true, via: 'register', order: REGISTER_OPTIONS.order })
        return true
      }

      try {
        if (install()) return
      } catch (error) {
        report('register-error', String(error?.message ?? error))
      }
      // slots 还没就位：10 秒内每 100ms 再试一次（apply 已经同步返回，不阻塞启动审计）。
      try {
        ctx.effect(() => {
          let tries = 0
          const timer = globalThis.setInterval(() => {
            tries += 1
            try {
              if (install() || tries > 100) globalThis.clearInterval(timer)
            } catch (error) {
              report('register-error', String(error?.message ?? error))
              globalThis.clearInterval(timer)
            }
          }, 100)
          return () => globalThis.clearInterval(timer)
        }, 'dsh-alicoupon: coupon row retry')
      } catch (error) {
        report('retry-error', String(error?.message ?? error))
      }
    }

    // 只给离线测试用的内部件出口：加载器只认 `name` / `apply` / `inject`，多一个键无影响。
    exports.__components = { ConfigPanel, CouponRow }
    exports.name = PACKAGE
    exports.apply = apply
    return module.exports
  },
})