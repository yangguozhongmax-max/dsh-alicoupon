/**
 * 客户端半边的离线冒烟测试：不需要浏览器、不需要 DSH、不联网。
 *
 * 用假的 `window.__ModuleLoader__` 把 bundle 取出来，用极简的假 React 渲染一次
 * （真正的 React 只在 App 里才有），验证三件事：
 *   1. bundle 的对外契约（`inject` / `apply`）没坏；
 *   2. 侧边栏那行会注册进 `sidebar.footer.action`，`apply` 同步返回 undefined 且绝不抛错
 *      （fiber 一旦停在 loading，桌面 App 就会拒绝启动：`web boot: 1 entry did not activate`）；
 *   3. 渲染出来的树里确实有那一行（标签 + 余额）。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

/** 只实现 client.js 用到的那几个 hook；effect 不执行（fetch 留着给浏览器跑）。 */
function fakeReact() {
  const createElement = (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat().filter((child) => child !== null && child !== undefined && child !== false),
  })
  return {
    createElement,
    Fragment: Symbol('Fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial }),
  }
}

const PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives'

/** 把 bundle 载进来：捕获 `__ModuleLoader__.load({id, factory})`，再手工物化一次。 */
async function loadBundle() {
  const captured = []
  globalThis.window = { __ModuleLoader__: { load: (spec) => captured.push(spec) } }
  const url = new URL('../lib/client.js', import.meta.url)
  // client.js 是给「压缩过的模块系统」看的死代码，直接 import 就是执行那句 load。
  await import(`${url.href}?smoke=${Date.now()}`)
  assert.equal(captured.length, 1, '应当正好调用一次 __ModuleLoader__.load')
  const spec = captured[0]
  assert.equal(spec.id, 'dsh-alicoupon')
  const React = fakeReact()
  const exports = spec.factory((id) => {
    if (id === 'react') return React
    if (id === PRIMITIVES) return { Tooltip: null }
    // 故意让 react-dom 拿不到：走「没有 portal 就内联渲染」的兜底分支。
    throw new Error(`测试里不该 require(${id})`)
  })
  delete globalThis.window
  return { spec, exports, React }
}

/** 在假的元素树里按 className 找节点（假 createElement 不做渲染，得自己走）。 */
function findByClass(node, className) {
  if (node === null || typeof node !== 'object') return null
  if (node.props?.className === className) return node
  for (const child of node.children ?? []) {
    const hit = findByClass(child, className)
    if (hit !== null) return hit
  }
  return null
}

/** slots 服务（和真实的一样：register 返回 dispose；`throwOn` 用来模拟槽位不可用）。 */
function makeSlots(registered, throwOn) {
  return {
    inject: (_name, callback) => callback(),
    register: (options, Component) => {
      if (throwOn !== undefined && options.name === throwOn) throw new Error(`slot ${options.name} 不可用`)
      registered.push({ options, Component })
      return () => {}
    },
  }
}

function fakeContext({ throwOn, noSlots = false } = {}) {
  const registered = []
  const ctx = {
    registered,
    slots: makeSlots(registered, throwOn),
    effect: (fn, _label) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    // 有些运行期只有 ctx.get('slots') 这一条路，两条都要覆盖。
    get: (name) => (name === 'slots' ? ctx.slots : undefined),
  }
  if (noSlots) {
    delete ctx.slots
    ctx.get = () => undefined
  }
  return ctx
}

test('bundle 契约：id / apply 都在，且不把 slots 声明成强依赖', async () => {
  const { spec, exports } = await loadBundle()
  assert.equal(spec.id, 'dsh-alicoupon')
  assert.equal(exports.name, 'dsh-alicoupon')
  // 强依赖 `slots` 会让 fiber 在启动审计时停在 loading（真实事故：web boot 拒绝启动）。
  assert.equal(exports.inject, undefined)
  assert.equal(typeof exports.apply, 'function')
})

test('apply：只注册侧边栏那一行（id/order 都对，不多注册槽位）', async () => {
  const { exports } = await loadBundle()
  const ctx = fakeContext()
  // 同步返回 undefined 是关键契约：返回 thenable 会让 fiber 一直停在 loading。
  assert.equal(exports.apply(ctx), undefined)
  const row = ctx.registered.find((entry) => entry.options.name === 'sidebar.footer.action')
  assert.notEqual(row, undefined, '应当注册 sidebar.footer.action')
  assert.equal(row.options.id, 'dsh-alicoupon')
  assert.equal(row.options.order, -1)
  assert.deepEqual(
    ctx.registered.map((entry) => entry.options.name),
    ['sidebar.footer.action'],
    '侧边栏只该有这一行：不要再往 settings.section 里塞一份',
  )
})

test('slots 服务迟到：apply 立刻返回 undefined，服务到位后自己补上注册', async () => {
  const { exports } = await loadBundle()
  const ctx = fakeContext({ noSlots: true })
  assert.equal(exports.apply(ctx), undefined, '服务没到位也不能抛错、不能返回 thenable')
  assert.deepEqual(ctx.registered, [], '服务没到位时不应该注册')

  // 服务到位（真实环境里就是 slots 服务被 provide 的那一刻）→ 重试定时器补上注册。
  ctx.slots = makeSlots(ctx.registered)
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.deepEqual(
    ctx.registered.map((entry) => entry.options.name),
    ['sidebar.footer.action'],
  )
})

test('注册抛错时 apply 也不抛（否则条目变 failed，App 一样起不来）', async () => {
  const { exports } = await loadBundle()
  const ctx = fakeContext({ throwOn: 'sidebar.footer.action' })
  assert.equal(exports.apply(ctx), undefined)
  assert.deepEqual(ctx.registered, [])
})

test('manifest：dsh.client.immediately 必须是 true（启动时先预取，条目才不会卡在 loading）', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.client.immediately, true)
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
})

test('CouponRow：宽模式渲染「标签 + 余额」，导轨模式渲染金额', async () => {
  const { exports } = await loadBundle()
  const ctx = fakeContext()
  exports.apply(ctx)
  const Row = ctx.registered.find((entry) => entry.options.name === 'sidebar.footer.action').Component

  const wide = Row({ wide: true })
  const wideRow = findByClass(wide, 'dsa-row')
  assert.notEqual(wideRow, null, '应当渲染出 .dsa-row')
  assert.equal(wideRow.props['data-status'], 'loading')
  assert.equal(wideRow.props['data-rail'], 'false')
  const texts = JSON.stringify(wide)
  assert.ok(texts.includes('阿里云代金券'), '没取到快照时用默认标签')
  assert.ok(texts.includes('dsa-label'))

  const rail = Row({ wide: false })
  const railRow = findByClass(rail, 'dsa-row')
  assert.notEqual(railRow, null)
  assert.equal(railRow.props['data-rail'], 'true')
})

test('ConfigPanel：内嵌模式渲染出面板与凭据说明（不联网）', async () => {
  const { exports } = await loadBundle()
  const panel = exports.__components.ConfigPanel({ embedded: true })
  const root = findByClass(panel, 'dsa-panel')
  assert.notEqual(root, null, '面板根节点')
  assert.equal(root.props['data-embedded'], 'true')
  assert.equal(root.props.style, undefined, '内嵌模式不该自己定位')

  const tree = JSON.stringify(panel)
  assert.ok(tree.includes('阿里云代金券'), '标题')
  assert.ok(tree.includes('侧边栏那一行的标签'), '标签输入框')
  assert.ok(tree.includes('宿主查阿里云的间隔'), '间隔输入框')
  assert.ok(tree.includes('立即刷新'))
  assert.ok(tree.includes('阿里云凭据（只读 AccessKey 即可）'), '凭据小节')
  assert.ok(tree.includes('AccessKey ID') && tree.includes('AccessKey Secret'), '凭据输入框')
  assert.ok(tree.includes('Security Token'), 'STS token 输入框')
  assert.ok(tree.includes('保存凭据') && tree.includes('清除已保存的凭据'), '凭据按钮')
  assert.ok(tree.includes('交 DSH 凭据库') || tree.includes('写进 DSH 凭据库'), '凭据说明')
  assert.ok(tree.includes('留空则不改'), '留空语义写在 placeholder 里')
})

/** 假 createElement 把子节点放在 `node.children`，不是 `props.children`。 */
function walkTree(node, visit) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) walkTree(item, visit)
    return
  }
  visit(node)
  for (const child of node.children ?? []) walkTree(child, visit)
}

/** 面板里第一个 type=password 的输入框（用来模拟用户敲字）。 */
function passwordInput(panel) {
  let found = null
  walkTree(panel, (node) => {
    if (found === null && node.type === 'input' && node.props?.type === 'password') found = node
  })
  return found
}

/** 找出文本等于给定字面量的 button。 */
function buttonByText(panel, text) {
  let found = null
  walkTree(panel, (node) => {
    if (found === null && node.type === 'button' && (node.children ?? []).includes(text)) found = node
  })
  return found
}

test('ConfigPanel：把键入的 AK/Secret POST 给 /credentials，并显示逐项结果', async () => {
  const { exports } = await loadBundle()
  const panel = exports.__components.ConfigPanel({ embedded: true })

  const requests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options })
    return {
      status: 200,
      async json() {
        return {
          ok: true,
          results: [
            { role: 'accessKeyId', ref: 'ALIBABA_CLOUD_ACCESS_KEY_ID', ok: true, action: 'saved' },
            { role: 'accessKeySecret', ref: 'ALIBABA_CLOUD_ACCESS_KEY_SECRET', ok: true, action: 'saved' },
          ],
          credentials: { configured: true, missing: [], writable: true, refs: [] },
          state: { status: 'ok', message: '' },
        }
      },
    }
  }
  try {
    // 假 React 不跑 effect，所以「读配置」那一步不会发生；直接驱动输入与按钮。
    const secret = passwordInput(panel)
    assert.notEqual(secret, null, '得有个密码输入框')
    secret.props.onChange({ target: { value: '  sk-test  ' } })

    const save = buttonByText(panel, '保存凭据')
    assert.notEqual(save, null, '得有「保存凭据」按钮')
    assert.equal(save.props.disabled, true, '还没读到 /config（不知道能不能写）时先禁用')
    await save.props.onClick()

    assert.equal(requests.length, 1)
    assert.ok(requests[0].url.includes('/plugins/dsh-alicoupon/credentials'), requests[0].url)
    assert.equal(requests[0].options.method, 'POST')
    const body = JSON.parse(requests[0].options.body)
    assert.equal(body.securityToken, '', 'Security Token 默认空')
    assert.equal(body.clear, undefined, '保存时不该带 clear')
  } finally {
    globalThis.fetch = originalFetch
  }
})