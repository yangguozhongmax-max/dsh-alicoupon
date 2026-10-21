/**
 * 宿主半边的离线自测：用假的 cordis ctx 驱动真实的路由处理器。
 *
 * 覆盖：无凭据时不联网、`/state` 带上 config、`GET /config` 报缺哪些凭据、
 * `POST /config` 落盘并当场生效、非法 patch 被拒、`/credentials` 写入/清除的校验与效果。
 * 全程不碰阿里云（凭据齐了之后用假的 fetch 顶掉），也不碰 DSH。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

const CREDENTIAL_ENV = [
  'ALIBABA_CLOUD_ACCESS_KEY_ID',
  'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
  'ALIBABA_CLOUD_SECURITY_TOKEN',
]

let dir = ''
let configFile = ''
let route = null
let apply = null
let ROUTE_PREFIX = ''
let timer = null
/** 假凭据库：`ref -> value`，加上调用流水，用来断言插件到底写了什么。 */
const store = new Map()
const credentialCalls = []
/** 假阿里云响应：一张 300 面值、剩 286.18 的可用券。 */
const fakeCouponResponse = {
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
let fetchCalls = 0
const fakeFetch = async () => {
  fetchCalls += 1
  return { ok: true, status: 200, json: async () => fakeCouponResponse }
}

/** 只实现插件真正用到的那几个 ctx 成员。 */
function fakeContext() {
  return {
    credentials: {
      resolve: async (ref) => (store.has(ref) ? { value: store.get(ref), source: 'file' } : undefined),
      describe: async (ref) => ({ configured: store.has(ref), source: store.has(ref) ? 'file' : 'none', writable: true }),
      set: async (ref, value) => {
        credentialCalls.push({ op: 'set', ref, value })
        store.set(ref, value)
      },
      unset: async (ref) => {
        credentialCalls.push({ op: 'unset', ref })
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
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
}

function call(method, url, body) {
  return new Promise((resolve, reject) => {
    const req = new Readable({ read() {} })
    req.method = method
    req.url = url
    req.headers = { 'sec-fetch-mode': 'cors' }
    const res = {
      statusCode: 0,
      headers: {},
      body: '',
      writeHead(status, headers) {
        this.statusCode = status
        this.headers = headers
      },
      end(text) {
        this.body = text
        resolve(this)
      },
    }
    const done = Promise.resolve(route.handler(req, res))
    done.catch(reject)
    if (body === undefined) req.push(null)
    else req.push(typeof body === 'string' ? body : JSON.stringify(body))
    if (body !== undefined) req.push(null)
    // handler 是 async：等它 settle 后再解析 res（end 已 resolve，重复 resolve 无害）。
    done.then(() => {
      if (res.statusCode === 0) reject(new Error('handler 既没写响应也没抛错'))
    })
  })
}

const json = (res) => JSON.parse(res.body)

before(async () => {
  for (const key of CREDENTIAL_ENV) delete process.env[key]
  dir = await mkdtemp(join(tmpdir(), 'dsh-alicoupon-test-'))
  configFile = join(dir, 'config.json')
  process.env.DSH_ALICOUPON_CONFIG = configFile
  const mod = await import('../lib/index.js')
  apply = mod.apply
  ROUTE_PREFIX = mod.ROUTE_PREFIX
  process.env.DSH_ALICOUPON_TRACE = join(dir, 'trace.log')
})

after(async () => {
  if (timer !== null) clearInterval(timer)
  delete process.env.DSH_ALICOUPON_CONFIG
  delete process.env.DSH_ALICOUPON_TRACE
  await rm(dir, { recursive: true, force: true })
})

test('挂上路由后：没凭据也不联网，state 里带上生效配置', async () => {
  apply(fakeContext(), { label: '测试券', refreshMinutes: 5, fetchImpl: fakeFetch })
  assert.notEqual(route, null, '应当注册了一个 prefix 路由')
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, ROUTE_PREFIX)

  const state = json(await call('GET', `${ROUTE_PREFIX}/state`))
  assert.equal(state.status, 'unconfigured')
  assert.equal(state.label, '测试券')
  assert.equal(state.remaining, null)
  assert.deepEqual(state.config, {
    label: '测试券',
    refreshMinutes: 5,
    timeoutMs: 15000,
    credentialRefs: {
      accessKeyId: 'ALIBABA_CLOUD_ACCESS_KEY_ID',
      accessKeySecret: 'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
      securityToken: 'ALIBABA_CLOUD_SECURITY_TOKEN',
    },
  })
  assert.equal(state.diagnostics.clientHits, 1)
})

test('GET /config：报出缺哪两个凭据、配置来源与落盘路径', async () => {
  const body = json(await call('GET', `${ROUTE_PREFIX}/config`))
  assert.equal(body.ok, true)
  assert.equal(body.config.label, '测试券')
  assert.equal(body.source, 'profile')
  assert.equal(body.file, configFile)
  assert.equal(body.credentials.configured, false)
  assert.deepEqual(body.credentials.missing, ['ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET'])
  assert.equal(body.bounds.maxRefreshMinutes, 1440)
})

test('POST /config：落盘 + 当场生效（下一次 state 就是新值）', async () => {
  const saved = json(await call('POST', `${ROUTE_PREFIX}/config`, { label: '千问学生券', refreshMinutes: 7 }))
  assert.equal(saved.ok, true)
  assert.equal(saved.config.label, '千问学生券')
  assert.equal(saved.config.refreshMinutes, 7)

  const onDisk = JSON.parse(await readFile(configFile, 'utf8'))
  assert.deepEqual(onDisk, { label: '千问学生券', refreshMinutes: 7 })

  const state = json(await call('GET', `${ROUTE_PREFIX}/state`))
  assert.equal(state.label, '千问学生券')
  assert.equal(state.config.refreshMinutes, 7)
  assert.equal(state.diagnostics.refreshMinutes, 7)
  const config = json(await call('GET', `${ROUTE_PREFIX}/config`))
  assert.equal(config.source, 'file')
})

test('POST /config：非法或空 patch 被拒，且不动磁盘上的配置', async () => {
  const empty = await call('POST', `${ROUTE_PREFIX}/config`, {})
  assert.equal(empty.statusCode, 400)
  assert.equal(json(empty).ok, false)

  const sneaky = await call('POST', `${ROUTE_PREFIX}/config`, { credentialRefs: { accessKeyId: 'x' }, timeoutMs: 1 })
  assert.equal(sneaky.statusCode, 400)

  const outOfRange = await call('POST', `${ROUTE_PREFIX}/config`, { refreshMinutes: 0 })
  assert.equal(outOfRange.statusCode, 400)

  const onDisk = JSON.parse(await readFile(configFile, 'utf8'))
  assert.deepEqual(onDisk, { label: '千问学生券', refreshMinutes: 7 })
})

test('未知路径 404，错方法 405', async () => {
  assert.equal((await call('GET', `${ROUTE_PREFIX}/nope`)).statusCode, 404)
  assert.equal((await call('PUT', `${ROUTE_PREFIX}/config`, { label: 'x' })).statusCode, 405)
})

test('GET /credentials：逐项报「配没配、从哪来、能不能写」', async () => {
  const body = json(await call('GET', `${ROUTE_PREFIX}/credentials`))
  assert.equal(body.ok, true)
  assert.equal(body.credentials.configured, false)
  assert.equal(body.credentials.writable, true)
  assert.deepEqual(
    body.credentials.refs.map((entry) => entry.role),
    ['accessKeyId', 'accessKeySecret', 'securityToken'],
  )
  assert.equal(body.credentials.refs[0].ref, 'ALIBABA_CLOUD_ACCESS_KEY_ID')
  assert.equal(body.credentials.refs[0].configured, false)
  assert.equal(body.credentials.refs[0].required, true)
  assert.equal(body.credentials.refs[2].required, false, 'Security Token 是可选的')
})

test('POST /credentials：写进凭据库后立刻查一次阿里云（假 fetch），state 直接变 ok', async () => {
  const before = fetchCalls
  const res = await call('POST', `${ROUTE_PREFIX}/credentials`, {
    accessKeyId: 'LTAI-test',
    accessKeySecret: 'secret-test',
  })
  assert.equal(res.statusCode, 200)
  const body = json(res)
  assert.equal(body.ok, true)
  assert.deepEqual(
    body.results.map((entry) => `${entry.role}:${entry.action}:${entry.ok}`),
    ['accessKeyId:saved:true', 'accessKeySecret:saved:true'],
  )
  assert.equal(store.get('ALIBABA_CLOUD_ACCESS_KEY_ID'), 'LTAI-test')
  assert.equal(credentialCalls.filter((entry) => entry.op === 'set').length, 2)
  assert.equal(fetchCalls, before + 1, '写完要立刻查一次，界面才能当场看到结果')
  assert.equal(body.state.status, 'ok')
  assert.equal(body.state.remaining, 286.18)
  assert.equal(body.state.maxBudget, 300)
  assert.equal(body.state.count, 1)
  assert.equal(body.state.expiresAt, '2027-10-20')
  assert.equal(body.credentials.configured, true)
  assert.deepEqual(body.credentials.missing, [])
})

test('POST /credentials：空/非法输入整条拒绝，且一个字节都不写', async () => {
  assert.equal((await call('POST', `${ROUTE_PREFIX}/credentials`, {})).statusCode, 400)
  const spaced = await call('POST', `${ROUTE_PREFIX}/credentials`, { accessKeySecret: 'has space' })
  assert.equal(spaced.statusCode, 400)
  assert.equal(json(spaced).ok, false)
  assert.equal((await call('POST', `${ROUTE_PREFIX}/credentials`, { clear: ['nope'] })).statusCode, 400)
  assert.equal(
    (await call('POST', `${ROUTE_PREFIX}/credentials`, { accessKeyId: 'x', clear: ['accessKeyId'] })).statusCode,
    400,
  )
  assert.equal((await call('POST', `${ROUTE_PREFIX}/credentials`, { accessKeyId: 'x'.repeat(600) })).statusCode, 400)
  assert.equal(store.get('ALIBABA_CLOUD_ACCESS_KEY_ID'), 'LTAI-test', '被拒的请求不该改到已有值')
  assert.equal(store.get('ALIBABA_CLOUD_ACCESS_KEY_SECRET'), 'secret-test')
  assert.equal((await call('PUT', `${ROUTE_PREFIX}/credentials`, {})).statusCode, 405)
})

test('POST /credentials：clear 把 ref 从凭据库删掉，state 回到未配置', async () => {
  const body = json(await call('POST', `${ROUTE_PREFIX}/credentials`, { clear: ['accessKeyId', 'accessKeySecret'] }))
  assert.deepEqual(
    body.results.map((entry) => `${entry.role}:${entry.action}:${entry.ok}`),
    ['accessKeyId:cleared:true', 'accessKeySecret:cleared:true'],
  )
  assert.equal(store.has('ALIBABA_CLOUD_ACCESS_KEY_ID'), false)
  assert.equal(body.state.status, 'unconfigured')
  assert.deepEqual(body.credentials.missing, ['ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET'])
})