/**
 * dsh-alicoupon — host half.
 *
 * 读阿里云 BSS `DescribeCoupon`（只读）拿代金券余额，把结果缓存在宿主侧，
 * 并通过 DSH Web 服务器的一个只读路由暴露给浏览器半边：
 *
 *   GET  /plugins/dsh-alicoupon/state     当前快照（命中缓存则不打阿里云）
 *   POST /plugins/dsh-alicoupon/refresh   强制刷新后返回
 *   GET  /plugins/dsh-alicoupon/config    当前生效的配置 + 凭据是否就绪
 *   POST /plugins/dsh-alicoupon/config    改 label / refreshMinutes 并落盘
 *   GET  /plugins/dsh-alicoupon/credentials   凭据状态（每个 ref 的 configured / source / writable）
 *   POST /plugins/dsh-alicoupon/credentials   把 AK/Secret 写进 DSH 凭据库（或清除）
 *
 * 为什么数据要绕宿主一圈：AK/Secret 存在宿主进程的凭据库里（浏览器读不到），
 * 而且 business.aliyuncs.com 不接受浏览器跨域调用。凭据只用于本地签名，
 * 不会出现在发给浏览器的响应里（响应只有余额、面值、到期日、以及凭据是否就绪）。
 */
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_CREDENTIAL_REFS, fetchCoupons, summarizeCoupons } from './aliyun-coupon.js'
import { trace } from './debug.js'

export const name = 'dsh-alicoupon'

/** 必须有的宿主能力；缺任何一个就让本插件停在 pending（例如纯终端界面）。 */
export const inject = ['webServer', 'credentials']

/** 路由前缀，浏览器半边按同一个常量拼 URL。 */
export const ROUTE_PREFIX = '/plugins/dsh-alicoupon'

const DEFAULT_REFRESH_MINUTES = 1

/** 从界面改过的配置落盘在这里；profile 的 `cordis.patch.yml` 只提供初始值。 */
export const CONFIG_FILE =
  process.env.DSH_ALICOUPON_CONFIG ?? join(homedir(), '.dsh', 'storages', 'dsh-alicoupon', 'config.json')

const MAX_LABEL = 40
const MIN_REFRESH_MINUTES = 1
const MAX_REFRESH_MINUTES = 1440

/** 凭据三个槽位的角色名（同时是 `POST /credentials` 的字段名）。 */
export const CREDENTIAL_ROLES = ['accessKeyId', 'accessKeySecret', 'securityToken']
const MAX_CREDENTIAL_LENGTH = 512
/** 阿里云 AK/Secret/Token 都是可打印 ASCII，不含空格；带别的字符一定是贴错了。 */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/

/**
 * 只接受白名单字段，其余一律丢掉——`POST /config` 是这个插件里能写东西的地方之一
 * （另一处是 `POST /credentials`，那条只往凭据库写），
 * 而且它们都兼着「把宿主当本地服务的任何网页都能打」的暴露面。
 */
export function sanitizeConfigPatch(input) {
  const patch = {}
  if (input === null || typeof input !== 'object') return patch
  if (typeof input.label === 'string') {
    const label = input.label.trim()
    if (label !== '' && label.length <= MAX_LABEL) patch.label = label
  }
  if (input.refreshMinutes !== undefined) {
    const minutes = Number(input.refreshMinutes)
    if (Number.isFinite(minutes) && minutes >= MIN_REFRESH_MINUTES && minutes <= MAX_REFRESH_MINUTES) {
      patch.refreshMinutes = Math.round(minutes)
    }
  }
  return patch
}

/**
 * 校验 `POST /credentials` 的请求体：**全有或全无**——只要有一个字段不合法就整条拒绝，
 * 免得出现「AK 写进去了、Secret 没写」这种半截状态。
 *
 * - 留空的字段表示「不改」，所以空字符串在这里等于没写（清空要走 `clear`）。
 * - `clear: ['accessKeyId']` 明确表达「把这个 ref 从凭据库删掉」。
 */
export function validateCredentialInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '请求体必须是 JSON 对象' }
  }
  const patch = {}
  for (const role of CREDENTIAL_ROLES) {
    const raw = input[role]
    if (raw === undefined || raw === null) continue
    if (typeof raw !== 'string') return { ok: false, error: `${role} 必须是字符串` }
    const value = raw.trim()
    if (value === '') continue
    if (value.length > MAX_CREDENTIAL_LENGTH) {
      return { ok: false, error: `${role} 太长了（上限 ${MAX_CREDENTIAL_LENGTH} 字符）` }
    }
    if (!PRINTABLE_ASCII.test(value)) {
      return { ok: false, error: `${role} 含有空格或不可打印字符——请检查是不是多贴了引号/换行` }
    }
    patch[role] = value
  }
  const clear = []
  if (input.clear !== undefined) {
    if (!Array.isArray(input.clear)) return { ok: false, error: 'clear 必须是数组' }
    for (const role of input.clear) {
      if (!CREDENTIAL_ROLES.includes(role)) return { ok: false, error: `clear 里有未知字段：${String(role)}` }
      if (patch[role] !== undefined) return { ok: false, error: `同一字段既在写又在清：${role}` }
      if (!clear.includes(role)) clear.push(role)
    }
  }
  if (Object.keys(patch).length === 0 && clear.length === 0) {
    return { ok: false, error: `没有要改的内容（可写 ${CREDENTIAL_ROLES.join(' / ')}，或用 clear 清除）` }
  }
  return { ok: true, patch, clear }
}

async function readConfigFile() {
  try {
    return sanitizeConfigPatch(JSON.parse(await readFile(CONFIG_FILE, 'utf8')))
  } catch (error) {
    if (error?.code !== 'ENOENT') trace(`config: read ${CONFIG_FILE} failed: ${error?.message ?? error}`)
    return {}
  }
}

async function writeConfigFile(patch) {
  await mkdir(dirname(CONFIG_FILE), { recursive: true })
  const tmp = `${CONFIG_FILE}.tmp`
  await writeFile(tmp, `${JSON.stringify(patch, null, 2)}\n`, 'utf8')
  await rename(tmp, CONFIG_FILE)
}

/** 读请求体，带大小上限（防止本地网页往这里灌数据）。 */
function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`请求体超过 ${limit} 字节`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function normalizeConfig(config) {
  const raw = config ?? {}
  const positive = (value, fallback) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
  const refs = raw.credentialRefs ?? {}
  const ref = (key) => (typeof refs[key] === 'string' && refs[key] !== '' ? refs[key] : DEFAULT_CREDENTIAL_REFS[key])
  return {
    label: typeof raw.label === 'string' && raw.label !== '' ? raw.label : '阿里云代金券',
    refreshMinutes: positive(raw.refreshMinutes, DEFAULT_REFRESH_MINUTES),
    timeoutMs: positive(raw.timeoutMs, 15000),
    credentialRefs: {
      accessKeyId: ref('accessKeyId'),
      accessKeySecret: ref('accessKeySecret'),
      securityToken: ref('securityToken'),
    },
    // 只给测试用：把网络请求换掉，`test/host.test.mjs` 靠它离线跑「凭据齐了之后」的分支。
    fetchImpl: typeof raw.fetchImpl === 'function' ? raw.fetchImpl : undefined,
  }
}

/** 一次余额查询的结果快照。`label` 是短标签（给侧边栏那一行用），`title` 是带到期日的长文案（给悬停说明用）。 */
function snapshot({ status, label, title, unit, remaining, maxBudget, count, expiresAt, message, now }) {
  return { status, label, title, unit, remaining, maxBudget, count, expiresAt, message, updatedAt: now }
}

export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  const base = { ...settings }
  let configSource = 'profile'
  const ttlMs = () => settings.refreshMinutes * 60_000

  /** @type {ReturnType<typeof snapshot> | null} */
  let cached = null
  let inflight = null
  /** 排障计数：浏览器半边每 60 秒会来取一次 /state，其它工具（curl/PowerShell）也会。 */
  let clientHits = 0
  let otherHits = 0
  /**
   * 浏览器半个插件的「运行到哪一步」信标（见 lib/client.js 的 report）。桌面 App 里
   * 看不到渲染进程的 console，这份日志就是唯一的现场：apply 有没有跑、slots 拿没拿到、
   * 槽位注册成没成、第一次 /state 是成功还是报错。
   */
  const clientLog = []
  const CLIENT_LOG_FILE = join(dirname(CONFIG_FILE), 'client.log')
  // 这份日志只用于排障：超过 512 KB 就在启动时清一次，免得年复一年地长下去。
  stat(CLIENT_LOG_FILE)
    .then((info) => (info.size > 512 * 1024 ? writeFile(CLIENT_LOG_FILE, '') : undefined))
    .catch(() => {})

  /** 记一条浏览器半边的信标：内存里留最近 40 条，同时追加到 client.log（重启也不丢）。 */
  function recordClientReport(raw) {
    let entry
    try {
      const parsed = JSON.parse(raw)
      entry = {
        at: typeof parsed.at === 'string' ? parsed.at : new Date().toISOString(),
        event: String(parsed.event ?? 'unknown').slice(0, 40),
        detail: parsed.detail === undefined ? null : parsed.detail,
      }
    } catch {
      entry = { at: new Date().toISOString(), event: 'raw', detail: String(raw).slice(0, 200) }
    }
    clientLog.push(entry)
    if (clientLog.length > 40) clientLog.shift()
    trace(`client: ${JSON.stringify(entry)}`)
    // 目录可能还不存在（用户没动过配置时 storages 里没有这个包），先建再追加。
    mkdir(dirname(CLIENT_LOG_FILE), { recursive: true })
      .then(() => appendFile(CLIENT_LOG_FILE, `${JSON.stringify(entry)}\n`))
      .catch((error) => {
        trace(`client: log write failed: ${error?.message ?? error}`)
      })
  }

  /** 每次操作都重新解析凭据（凭据换了不用重启插件）。 */
  async function resolveCredentials() {
    const read = async (ref) => {
      try {
        const resolved = await ctx.credentials.resolve(ref)
        if (resolved !== undefined && resolved.value !== '') return resolved.value
      } catch (error) {
        trace(`credentials: resolve(${ref}) failed: ${error?.message ?? error}`)
      }
      const fromEnv = process.env[ref]
      return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : undefined
    }
    const accessKeyId = await read(settings.credentialRefs.accessKeyId)
    const accessKeySecret = await read(settings.credentialRefs.accessKeySecret)
    const securityToken = await read(settings.credentialRefs.securityToken)
    return { accessKeyId, accessKeySecret, securityToken }
  }

  /**
   * 给配置界面用：告诉用户「凭据还没填」「该填哪几个名字」，以及每一项能不能由插件写入。
   *
   * `describe` 会说明这个 ref 现在是从哪一层来的（凭据库 / 环境变量）以及可不可写——
   * 被环境变量（或 profile 的 project-env）遮蔽的 ref 是只读的，插件写进去也不会生效，
   * 所以界面必须在**写之前**就把这件事说清楚，而不是等 set 报错。
   */
  async function credentialStatus() {
    const credentials = await resolveCredentials()
    const values = {
      accessKeyId: credentials.accessKeyId,
      accessKeySecret: credentials.accessKeySecret,
      securityToken: credentials.securityToken,
    }
    const describe = typeof ctx.credentials?.describe === 'function' ? ctx.credentials.describe.bind(ctx.credentials) : null
    const refs = []
    for (const role of CREDENTIAL_ROLES) {
      const ref = settings.credentialRefs[role]
      const configured = values[role] !== undefined
      const entry = { role, ref, configured, required: role !== 'securityToken', source: null, writable: null }
      if (describe !== null) {
        try {
          const info = await describe(ref)
          if (info !== null && typeof info === 'object') {
            entry.source = typeof info.source === 'string' ? info.source : null
            entry.writable = typeof info.writable === 'boolean' ? info.writable : null
          }
        } catch (error) {
          trace(`credentials: describe(${ref}) failed: ${error?.message ?? error}`)
        }
      }
      refs.push(entry)
    }
    const missing = refs.filter((entry) => entry.required && !entry.configured).map((entry) => entry.ref)
    return {
      configured: missing.length === 0,
      missing,
      refs,
      writable: typeof ctx.credentials?.set === 'function',
    }
  }

  /** 把界面填的 AK/Secret/Token 写进 DSH 凭据库；一项一项做，失败只影响那一项。 */
  async function saveCredentials({ patch, clear }) {
    const results = []
    const canWrite = typeof ctx.credentials?.set === 'function'
    for (const role of CREDENTIAL_ROLES) {
      const ref = settings.credentialRefs[role]
      const value = patch[role]
      const clearing = clear.includes(role)
      if (value === undefined && !clearing) continue
      if (!canWrite) {
        results.push({ role, ref, ok: false, action: clearing ? 'cleared' : 'saved', error: '当前 DSH 版本的凭据服务不支持写入' })
        continue
      }
      try {
        if (clearing) {
          if (typeof ctx.credentials.unset === 'function') await ctx.credentials.unset(ref)
          else {
            results.push({ role, ref, ok: false, action: 'cleared', error: '当前 DSH 版本的凭据服务不支持删除' })
            continue
          }
          results.push({ role, ref, ok: true, action: 'cleared' })
        } else {
          await ctx.credentials.set(ref, value)
          results.push({ role, ref, ok: true, action: 'saved' })
        }
      } catch (error) {
        results.push({ role, ref, ok: false, action: clearing ? 'cleared' : 'saved', error: error?.message ?? String(error) })
      }
    }
    return results
  }

  function publicConfig() {
    return {
      label: settings.label,
      refreshMinutes: settings.refreshMinutes,
      timeoutMs: settings.timeoutMs,
      credentialRefs: { ...settings.credentialRefs },
    }
  }

  /**
   * 落盘 + 当场生效：改 label 或 refreshMinutes 不需要重启 App。
   * 写文件的是合并后的结果（不是单个 patch），这样界面改过一次之后就自成一份配置。
   */
  async function updateConfig(patch) {
    const next = { label: settings.label, refreshMinutes: settings.refreshMinutes, ...patch }
    const stored = { label: next.label, refreshMinutes: next.refreshMinutes }
    await writeConfigFile(stored)
    Object.assign(settings, stored)
    configSource = 'file'
    trace(`config: applied ${JSON.stringify(stored)} -> ${CONFIG_FILE}`)
    cached = null
    return load({ force: true })
  }

  async function load({ force = false } = {}) {
    const now = Date.now()
    if (!force && cached !== null && now - cached.updatedAt < ttlMs()) return cached
    if (inflight !== null) return inflight
    inflight = (async () => {
      try {
        const credentials = await resolveCredentials()
        if (credentials.accessKeyId === undefined || credentials.accessKeySecret === undefined) {
          const missing = [
            credentials.accessKeyId === undefined ? settings.credentialRefs.accessKeyId : null,
            credentials.accessKeySecret === undefined ? settings.credentialRefs.accessKeySecret : null,
          ].filter(v => v !== null).join(' / ')
          trace('query: no credentials')
          cached = snapshot({
            status: 'unconfigured',
            label: settings.label,
            title: `${settings.label} · 未配置凭据`,
            unit: 'CNY',
            remaining: null,
            maxBudget: null,
            count: 0,
            expiresAt: null,
            message: `未找到凭据 ${missing}（存进 DSH 凭据库或设为环境变量）`,
            now: Date.now(),
          })
          return cached
        }
        const coupon = await fetchCoupons({
          ...credentials,
          timeoutMs: settings.timeoutMs,
          fetchImpl: settings.fetchImpl,
          onTrace: trace,
        })
        const summary = summarizeCoupons(coupon, { label: settings.label })
        trace(`query: ok ${summary.remaining}/${summary.maxBudget} ${summary.label}`)
        cached = snapshot({
          status: 'ok',
          label: settings.label,
          title: summary.label,
          unit: summary.unit,
          remaining: summary.remaining,
          maxBudget: summary.maxBudget,
          count: summary.count,
          expiresAt: summary.expiresAt ?? null,
          message: '',
          now: Date.now(),
        })
        return cached
      } catch (error) {
        const message = error?.message ?? String(error)
        trace(`query: failed ${message}`)
        // 把上一次成功的数据留着，同时标记为过期：界面能显示旧值并说明查询失败。
        cached = snapshot({
          status: 'error',
          label: cached?.label ?? settings.label,
          title: `${cached?.label ?? settings.label} · 查询失败`,
          unit: cached?.unit ?? 'CNY',
          remaining: cached?.remaining ?? null,
          maxBudget: cached?.maxBudget ?? null,
          count: cached?.count ?? 0,
          expiresAt: cached?.expiresAt ?? null,
          message,
          now: Date.now(),
        })
        return cached
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  const send = (res, status, body) => {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  /**
   * 预检：浏览器半边跟宿主不同源（桌面 App 的页面是 `dsh-app://app`），
   * 而 `POST` 带 `content-type: application/json` 属于「非简单请求」，浏览器会先发 OPTIONS。
   * 之前这里对 OPTIONS 回 405，等于把面板的保存按钮全禁掉了——必须显式放行。
   */
  const preflight = (res) => {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
      'cache-control': 'no-store',
    })
    res.end()
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      const leaf = path.slice(ROUTE_PREFIX.length)
      // 排障用：浏览器 fetch 一定带 sec-fetch-mode / origin，命令行工具通常不带。
      const fromBrowser = typeof req.headers['sec-fetch-mode'] === 'string' || typeof req.headers.origin === 'string'
      if (fromBrowser) clientHits += 1
      else otherHits += 1
      const withDiagnostics = (state) => ({
        ...state,
        config: publicConfig(),
        diagnostics: { clientHits, otherHits, refreshMinutes: settings.refreshMinutes, clientLog },
      })
      try {
        if (req.method === 'OPTIONS') {
          preflight(res)
          return
        }
        if (leaf === '/state' || leaf === '') {
          send(res, 200, withDiagnostics(await load()))
          return
        }
        if (leaf === '/refresh') {
          send(res, 200, withDiagnostics(await load({ force: true })))
          return
        }
        if (leaf === '/config') {
          if (req.method === 'GET') {
            send(res, 200, {
              ok: true,
              config: publicConfig(),
              source: configSource,
              file: CONFIG_FILE,
              credentials: await credentialStatus(),
              bounds: { maxLabel: MAX_LABEL, minRefreshMinutes: MIN_REFRESH_MINUTES, maxRefreshMinutes: MAX_REFRESH_MINUTES },
            })
            return
          }
          if (req.method === 'POST') {
            const patch = sanitizeConfigPatch(JSON.parse(await readBody(req)))
            if (Object.keys(patch).length === 0) {
              send(res, 400, { ok: false, error: `没有可用的字段（label 1-${MAX_LABEL} 字，refreshMinutes ${MIN_REFRESH_MINUTES}-${MAX_REFRESH_MINUTES}）` })
              return
            }
            const state = await updateConfig(patch)
            send(res, 200, { ok: true, config: publicConfig(), state: withDiagnostics(state) })
            return
          }
          send(res, 405, { ok: false, error: '只支持 GET / POST' })
          return
        }
        if (leaf === '/credentials') {
          if (req.method === 'GET') {
            send(res, 200, { ok: true, credentials: await credentialStatus() })
            return
          }
          if (req.method === 'POST') {
            const parsed = validateCredentialInput(JSON.parse(await readBody(req, 4096)))
            if (!parsed.ok) {
              send(res, 400, { ok: false, error: parsed.error })
              return
            }
            const results = await saveCredentials(parsed)
            // 写完立刻查一次：界面能当场看到「凭据就绪 ✓」或者阿里云返回的原话（AK 错了、没权限…）。
            const state = await load({ force: true })
            send(res, 200, {
              ok: results.every((entry) => entry.ok),
              results,
              credentials: await credentialStatus(),
              state: withDiagnostics(state),
            })
            return
          }
          send(res, 405, { ok: false, error: '只支持 GET / POST' })
          return
        }
        if (leaf === '/debug') {
          if (req.method !== 'POST') {
            send(res, 405, { ok: false, error: '只支持 POST' })
            return
          }
          const raw = await readBody(req, 2048)
          recordClientReport(raw)
          send(res, 204, { ok: true })
          return
        }
        send(res, 404, { error: 'not found' })
      } catch (error) {
        send(res, 500, { ok: false, error: error?.message ?? String(error) })
      }
    },
  }), 'dsh-alicoupon: state route')

  // 宿主自己的定时刷新：每 30 秒看一眼缓存是否过期（`refreshMinutes` 可以随时被界面改掉，
  // 所以这里不缓存 ttl，也不重建定时器）。浏览器半边一挂上就有值。
  ctx.effect(() => {
    const timer = setInterval(() => { load().catch(() => {}) }, 30_000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'dsh-alicoupon: refresh timer')

  // 界面改过的值优先于 profile 的 cordis.patch.yml（文件是用户显式改的，更近一层）。
  readConfigFile().then((patch) => {
    if (Object.keys(patch).length === 0) return
    Object.assign(settings, patch)
    configSource = 'file'
    trace(`config: file override ${JSON.stringify(patch)}`)
    load({ force: true }).catch(() => {})
  })

  // 先跑一次，避免第一次打开界面时是空白。
  load({ force: true }).catch(() => {})
  trace(`host applied (route ${ROUTE_PREFIX}, every ${settings.refreshMinutes}min, base ${JSON.stringify(base)})`)
}