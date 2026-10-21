/**
 * 集成测试：**真实宿主路由 + 真实客户端 bundle**，中间用内存桥接，不联网、不开浏览器、不碰 DSH。
 *
 * 为什么值得单独一个文件：单测只能证明「各自那一半」对，证明不了两半对得上——
 * 上一版就栽在这类地方（客户端 POST 带 JSON 会触发 CORS 预检，而宿主对 OPTIONS 回 405）。
 * 这里跑的是完整链路：
 *
 *   客户端那一行/面板 → fetch → 宿主 HTTP 路由 → DSH 凭据服务（假）→ 阿里云（假）
 *
 * 所以它能验：字段名、URL 形状、JSON 编码、预检、写凭据之后「立刻查一次」的结果回显。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

const REFS = ['ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET', 'ALIBABA_CLOUD_SECURITY_TOKEN']
const ROUTE_PREFIX = '/plugins/dsh-alicoupon'

let dir = ''
let route = null
const cleanups = []
/** 假 DSH 凭据库：ref -> 明文。 */
const store = new Map()
let aliyunCalls = 0
/** 客户端 bundle 每次 `load()` 都会被这里接住。 */
let captured = []

const couponPayload = {
  Success: true,
  Data: {
    Coupons: [
      {
        CouponId: 923417750032,
        Status: 'AVAILABLE',
        Amount: '300',
        RemainAmount: '286.1843441024',
        Currency: 'CNY',
        StartTime: '2026-10-20T15:00Z',
        EndTime: '2027-10-20T15:00Z',
      },
    ],
    TotalCount: 1,
  },
}

before(async () => {
  for (const key of REFS) delete process.env[key]
  dir = await mkdtemp(join(tmpdir(), 'dsh-alicoupon-integration-'))
  process.env.DSH_ALICOUPON_CONFIG = join(dir, 'config.json')
  process.env.DSH_ALICOUPON_TRACE = join(dir, 'trace.log')
  // 浏览器全局：客户端那一行会用到 setInterval / addEventListener，但测试里不需要真的定时器。
  globalThis.window = {
    __ModuleLoader__: { load: (spec) => captured.push(spec) },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn) => setTimeout(fn, 0),
    addEventListener: () => {},
    removeEventListener: () => {},
    focus: () => {},
    innerWidth: 1280,
    innerHeight: 800,
  }
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener: () => {},
    removeEventListener: () => {},
    body: {},
  }
  const host = await import('../lib/index.js')
  host.apply(
    {
      credentials: {
        resolve: async (ref) => (store.has(ref) ? { value: store.get(ref), source: 'file' } : undefined),
        describe: async (ref) => ({ configured: store.has(ref), source: store.has(ref) ? 'file' : 'none', writable: true }),
        set: async (ref, value) => {
          store.set(ref, value)
        },
        unset: async (ref) => {
          store.delete(ref)
        },
      },
      webServer: {
        register: (registered) => {
          route = registered
          return () => {
            route = null
          }
        },
      },
      effect: (fn) => {
        const cleanup = fn()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
        return () => {}
      },
    },
    {
      label: '千问学生券',
      refreshMinutes: 1,
      fetchImpl: async () => {
        aliyunCalls += 1
        return { ok: true, status: 200, json: async () => couponPayload }
      },
    },
  )
  assert.notEqual(route, null, '宿主应当注册了路由')
})

after(async () => {
  for (const cleanup of cleanups) cleanup()
  delete process.env.DSH_ALICOUPON_CONFIG
  delete process.env.DSH_ALICOUPON_TRACE
  await rm(dir, { recursive: true, force: true })
})

/** 把客户端的 fetch 接到真实宿主路由上：请求/响应都按 Node http 的形状造。 */
function bridgeFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(String(url), 'http://127.0.0.1')
    const req = new Readable({ read() {} })
    req.method = options.method ?? 'GET'
    req.url = `${parsed.pathname}${parsed.search}`
    req.headers = { 'sec-fetch-mode': 'cors', origin: 'dsh-app://app', ...(options.headers ?? {}) }
    const res = {
      statusCode: 0,
      headers: {},
      body: '',
      writeHead(status, headers) {
        this.statusCode = status
        this.headers = headers
      },
      end(text) {
        // 注意：`text` 必须闭包捕获——返回的响应对象上没有 `body` 字段，
        // 用 `this.body` 会 JSON.parse(undefined)（这个坑第一次跑就踩了）。
        const body = text ?? ''
        resolve({
          ok: this.statusCode >= 200 && this.statusCode < 300,
          status: this.statusCode,
          headers: this.headers,
          async json() {
            return JSON.parse(body)
          },
          async text() {
            return body
          },
        })
      },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
    if (options.body !== undefined && options.body !== null && options.body !== '') req.push(options.body)
    req.push(null)
  })
}

/** 绕过客户端直接问宿主（断言用）。 */
const askHost = async (path, options) => (await bridgeFetch(`${ROUTE_PREFIX}${path}`, options)).json()

/**
 * 极简 React：真的会跑 `useState` / `useEffect`，所以能在 Node 里把组件挂起来，
 * 让 effect 里的 fetch 走完整条链路，再看重新渲染后的树。
 * 不支持「渲染子树」——组件函数只由 `mount` 显式调用一次，够这一层用了。
 */
function createReact() {
  const hooks = new Map()
  const instances = new Map()
  const dirty = new Set()
  const pendingEffects = []
  let current = null

  const createElement = (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat().filter((child) => child !== null && child !== undefined && child !== false),
  })

  const slot = (initial) => {
    const key = `${current.id}#${current.cursor++}`
    let entry = hooks.get(key)
    if (entry === undefined) {
      entry = {
        value: typeof initial === 'function' ? initial() : initial,
        mounted: false,
        deps: undefined,
        cleanup: undefined,
        effect: undefined,
      }
      hooks.set(key, entry)
    }
    return entry
  }

  const sameDeps = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))

  const run = (id) => {
    const instance = instances.get(id)
    current = { id, cursor: 0 }
    try {
      instance.tree = instance.render()
    } finally {
      current = null
    }
    return instance.tree
  }

  const React = {
    createElement,
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const id = current.id
      const entry = slot(initial)
      const set = (next) => {
        const value = typeof next === 'function' ? next(entry.value) : next
        if (Object.is(value, entry.value)) return
        entry.value = value
        dirty.add(id)
      }
      return [entry.value, set]
    },
    useEffect(effect, deps) {
      const id = current.id
      const entry = slot(undefined)
      entry.effect = effect
      const changed = !entry.mounted || deps === undefined || !sameDeps(entry.deps, deps)
      entry.deps = deps
      if (changed) pendingEffects.push({ id, entry })
    },
    useCallback: (fn) => fn,
    useRef(initial) {
      return slot({ current: initial }).value
    },
  }

  /** 挂载 = 清掉这个 id 之前的 hook 状态（换一个 id 就是一次全新的挂载）。 */
  const mount = (id, render) => {
    for (const key of [...hooks.keys()]) {
      if (key.startsWith(`${id}#`)) hooks.delete(key)
    }
    instances.set(id, { render, tree: null })
    return run(id)
  }

  const tree = (id) => instances.get(id)?.tree ?? null

  /** 跑完排队的 effect、做完 setState 引起的重渲染，直到没有新动静（最多 20 轮）。 */
  const flush = async (rounds = 20) => {
    for (let round = 0; round < rounds; round += 1) {
      const ids = [...dirty]
      dirty.clear()
      for (const id of ids) run(id)
      const effects = pendingEffects.splice(0)
      for (const { entry } of effects) {
        if (typeof entry.cleanup === 'function') entry.cleanup()
        const cleanup = await entry.effect()
        entry.cleanup = typeof cleanup === 'function' ? cleanup : undefined
        entry.mounted = true
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (ids.length === 0 && effects.length === 0 && dirty.size === 0 && pendingEffects.length === 0) break
    }
  }

  return { React, mount, flush, tree }
}

function walk(node, visit) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
    return
  }
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function findByClass(node, className) {
  let found = null
  walk(node, (candidate) => {
    if (found === null && candidate.props?.className === className) found = candidate
  })
  return found
}

function findById(node, id) {
  let found = null
  walk(node, (candidate) => {
    if (found === null && candidate.props?.id === id) found = candidate
  })
  return found
}

function findByText(node, text) {
  let found = null
  walk(node, (candidate) => {
    if (found === null && (candidate.children ?? []).includes(text)) found = candidate
  })
  return found
}

const textOf = (node) => JSON.stringify(node)

/** 把真实客户端 bundle 载进来（假 __ModuleLoader__），require 只给 mini React。 */
async function loadClient() {
  captured = []
  const react = createReact()
  const url = new URL('../lib/client.js', import.meta.url)
  await import(`${url.href}?integration=${Date.now()}${captured.length}`)
  assert.equal(captured.length, 1, '应当正好 load 一次')
  const exports = captured[0].factory((id) => {
    if (id === 'react') return react.React
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Tooltip: null }
    // 拿不到 react-dom：走「没有 portal 就内联渲染」的兜底分支。
    throw new Error(`集成测试里不该 require(${id})`)
  })
  return { exports, react }
}

/** 假 cordis 客户端 ctx：只要 slots（effect 直接执行，inject 立即回调）。 */
function clientContext(registered) {
  const ctx = {
    effect: (fn) => {
      const cleanup = fn()
      return typeof cleanup === 'function' ? cleanup : () => {}
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, Component) => {
        registered.push({ options, Component })
        return () => {}
      },
    },
  }
  ctx.inject = (_deps, callback) => callback(ctx)
  return ctx
}

test('集成：那一行读的是真实宿主路由（没凭据时显示「待配置」）', async () => {
  const registered = []
  const { exports, react } = await loadClient()
  exports.apply(clientContext(registered))
  const Row = registered.find((entry) => entry.options.name === 'sidebar.footer.action').Component

  const originalFetch = globalThis.fetch
  globalThis.fetch = bridgeFetch
  try {
    react.mount('row-1', () => Row({ wide: true }))
    await react.flush()
    const row = findByClass(react.tree('row-1'), 'dsa-row')
    assert.notEqual(row, null, '应当有那一行')
    const text = textOf(row)
    assert.ok(text.includes('千问学生券'), `标签来自宿主的 config.label：${text.slice(0, 300)}`)
    assert.ok(text.includes('待配置'), '没凭据时行上写「待配置」而不是悄悄消失')
    assert.equal(aliyunCalls, 0, '没凭据就不该打阿里云')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('集成：面板写凭据 → 真实宿主落库 + 立刻查阿里云 → 那一行显示出余额', async () => {
  const registered = []
  const { exports, react } = await loadClient()
  exports.apply(clientContext(registered))
  const Panel = exports.__components.ConfigPanel
  const Row = registered.find((entry) => entry.options.name === 'sidebar.footer.action').Component

  const originalFetch = globalThis.fetch
  globalThis.fetch = bridgeFetch
  try {
    // 面板从真实 `/config` 读状态。
    react.mount('panel', () => Panel({ embedded: true }))
    await react.flush()
    let root = findByClass(react.tree('panel'), 'dsa-panel')
    assert.notEqual(root, null, '面板应当渲染出来')
    assert.ok(
      textOf(root).includes('未找到凭据：ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET'),
      '状态行要说清缺哪两项',
    )

    let save = findByText(root, '保存凭据')
    assert.notEqual(save, null, '有「保存凭据」按钮')
    assert.equal(save.props.disabled, false, '宿主说可写，按钮应当可用')

    // 用户输入：假 React 里 setState 会触发重渲染，所以要再 flush 一次。
    findById(root, 'dsa-ak-input').props.onChange({ target: { value: 'LTAI-integration' } })
    findById(root, 'dsa-sk-input').props.onChange({ target: { value: 'secret-integration' } })
    await react.flush()
    root = findByClass(react.tree('panel'), 'dsa-panel')

    const callsBefore = aliyunCalls
    await findByText(root, '保存凭据').props.onClick()
    await react.flush()
    root = findByClass(react.tree('panel'), 'dsa-panel')
    const panelText = textOf(root)

    assert.equal(store.get('ALIBABA_CLOUD_ACCESS_KEY_ID'), 'LTAI-integration', 'AK 应当写进凭据库')
    assert.equal(store.get('ALIBABA_CLOUD_ACCESS_KEY_SECRET'), 'secret-integration', 'Secret 应当写进凭据库')
    assert.equal(aliyunCalls, callsBefore + 1, '写完立刻查一次阿里云')
    assert.ok(panelText.includes('ALIBABA_CLOUD_ACCESS_KEY_ID：已保存'), `面板要回显逐项结果：${panelText.slice(0, 500)}`)
    assert.ok(panelText.includes('阿里云返回正常 ✓'), '面板要回显阿里云那边的结果')
    assert.ok(panelText.includes('凭据已就绪 ✓'), '状态行应当变成已就绪')
    assert.ok(panelText.includes('已配置（来源 file）'), '状态行要说明值来自哪一层')

    // 再挂一次那一行（相当于面板保存后行自己的刷新）：它读真实 `/state`，应当显示余额。
    react.mount('row-2', () => Row({ wide: true }))
    await react.flush()
    const rowText = textOf(findByClass(react.tree('row-2'), 'dsa-row'))
    assert.ok(rowText.includes('千问学生券'), `行上是配置的标签：${rowText.slice(0, 300)}`)
    assert.ok(rowText.includes('¥286.18'), `行上应当有真实宿主的余额：${rowText.slice(0, 400)}`)

    const state = await askHost('/state')
    assert.equal(state.status, 'ok')
    assert.equal(state.remaining, 286.18)
    assert.equal(state.maxBudget, 300)
    assert.equal(state.expiresAt, '2027-10-20')
  } finally {
    globalThis.fetch = originalFetch
    store.clear()
    aliyunCalls = 0
  }
})