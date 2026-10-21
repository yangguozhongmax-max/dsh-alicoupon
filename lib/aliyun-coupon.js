/**
 * 阿里云代金券（优惠券）只读查询核心 —— 纯函数 + 一次 HTTP 调用，不依赖 DSH。
 *
 * 数据来源：BSS OpenAPI `DescribeCoupon`（版本 2023-09-30，网关 `business.aliyuncs.com`），
 * 走 ACS3-HMAC-SHA256 签名，与阿里云「账户余额 / 资金账户可用金」接口同一套 RAM 凭据。
 * 需要的权限只有一个读操作：`bss:DescribeCoupon`（系统策略 `AliyunBSSReadOnlyAccess`
 * 里的 `bss:Describe*` 已经覆盖）。
 *
 * 这里刻意不 import 任何宿主模块：方便单测、也方便当命令行工具用（见 scripts/probe.mjs）。
 */
import { createHash, createHmac, randomUUID } from 'node:crypto'

export const COUPON_HOST = 'business.aliyuncs.com'
export const COUPON_ENDPOINT = `https://${COUPON_HOST}/`
/** 实测可用的 action 名；阿里云文档里也有复数写法，故允许覆盖。 */
export const COUPON_ACTION = 'DescribeCoupon'
export const COUPON_VERSION = '2023-09-30'

/** 默认从这三个凭据引用取 RAM 只读 AK；`*_SECURITY_TOKEN` 只有 STS 临时凭据才需要。 */
export const DEFAULT_CREDENTIAL_REFS = Object.freeze({
  accessKeyId: 'ALIBABA_CLOUD_ACCESS_KEY_ID',
  accessKeySecret: 'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
  securityToken: 'ALIBABA_CLOUD_SECURITY_TOKEN',
})

const sha256 = value => createHash('sha256').update(value).digest('hex')

/** ACS3 规范要求的 RFC3986 百分号编码（encodeURIComponent 少转义了 !'()*）。 */
const encode = value => encodeURIComponent(String(value))
  .replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)

const canonicalQuery = query => Object.keys(query).sort()
  .map(key => `${encode(key)}=${encode(query[key])}`).join('&')

const round2 = value => Math.round(value * 100) / 100

/**
 * 生成一次 ACS3-HMAC-SHA256 签名请求头。
 * `x-acs-date` 与 `x-acs-signature-nonce` 每次都不同，所以**重试必须重新签名**。
 */
export function signRequest({ accessKeyId, accessKeySecret, securityToken, queryString, action = COUPON_ACTION, version = COUPON_VERSION, host = COUPON_HOST }) {
  const body = ''
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    host,
    'x-acs-action': action,
    'x-acs-content-sha256': sha256(body),
    'x-acs-date': new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    'x-acs-signature-nonce': randomUUID(),
    'x-acs-version': version,
  }
  if (securityToken) headers['x-acs-security-token'] = securityToken
  const keys = Object.keys(headers).sort()
  const signedHeaders = keys.join(';')
  const canonicalHeaders = keys.map(key => `${key}:${headers[key].trim()}\n`).join('')
  const canonical = ['POST', '/', queryString, canonicalHeaders, signedHeaders, sha256(body)].join('\n')
  const signature = createHmac('sha256', accessKeySecret)
    .update(`ACS3-HMAC-SHA256\n${sha256(canonical)}`)
    .digest('hex')
  headers.Authorization = `ACS3-HMAC-SHA256 Credential=${accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`
  headers.Accept = 'application/json'
  return { headers }
}

/** 把阿里云的 Code/Message 翻成一眼能看懂、且能指导下一步的中文提示。 */
export function describeFailure(status, detail) {
  const code = typeof detail?.[0] === 'string' ? detail[0] : ''
  const text = typeof detail?.[1] === 'string' ? detail[1] : ''
  if (/SignatureDoesNotMatch/i.test(code)) return '签名校验失败：AccessKey Secret 不正确'
  if (/InvalidAccessKeyId/i.test(code)) return 'AccessKey ID 无效或已被删除'
  if (/Forbidden|NoPermission|NotAuthorized|NoAccess/i.test(code) || status === 401 || status === 403) {
    return `权限不足：给该 RAM 用户授予 bss:DescribeCoupon${code === '' ? '' : `（${code}）`}`
  }
  if (/Throttling/i.test(code)) return '阿里云接口限流，稍后自动重试'
  const tail = [code, text].filter(part => part !== '').join(' ')
  return `阿里云返回 HTTP ${status}${tail === '' ? '' : `：${tail}`}`
}

/** 响应体里券数组的位置：`Data` 直接是数组、`Data.Coupons`、`Coupons` 都见过。 */
export function extractCoupons(data) {
  const payload = data?.Data
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.Coupons)) return payload.Coupons
  if (Array.isArray(data?.Coupons)) return data.Coupons
  return []
}

const amountOf = coupon => {
  const remain = Number(coupon?.RemainAmount)
  return Number.isFinite(remain) ? remain : 0
}

/** 券是否还可用：剩余金额 > 0，且（若给了到期时间）还没过期。 */
export function isUsable(coupon, now = Date.now()) {
  if (amountOf(coupon) <= 0) return false
  const end = Date.parse(coupon?.EndTime ?? '')
  return !Number.isFinite(end) || end > now
}

/**
 * 汇总可用券：金额按**全部可用券**相加，到期日取里面**面值最大**那张的
 * （学生券这种「一张主券 + 若干小额赠券」的场景下，这条最贴近人的直觉）。
 *
 * @returns `{ label, unit, remaining, maxBudget, spend, count, expiresAt, coupons }`
 * @throws 没有可用券时抛错（文案区分「一张都没有」与「都用完/过期了」）。
 */
export function summarizeCoupons(coupons, { label = '阿里云代金券', now = Date.now() } = {}) {
  const list = Array.isArray(coupons) ? coupons : []
  const usable = list.filter(coupon => isUsable(coupon, now))
  if (usable.length === 0) {
    throw new Error(list.length === 0 ? '该阿里云账号下没有代金券' : '名下代金券均已用完或过期')
  }
  const biggest = [...usable].sort((a, b) => (Number(b.Amount) || 0) - (Number(a.Amount) || 0))[0]
  const remaining = round2(usable.reduce((sum, coupon) => sum + amountOf(coupon), 0))
  const face = round2(usable.reduce((sum, coupon) => sum + (Number(coupon.Amount) || 0), 0))
  const expiresAt = typeof biggest.EndTime === 'string' && biggest.EndTime.length >= 10
    ? biggest.EndTime.slice(0, 10)
    : ''
  return {
    label: expiresAt === '' ? label : `${label} · ${expiresAt} 到期`,
    unit: typeof biggest.Currency === 'string' && biggest.Currency !== '' ? biggest.Currency : 'CNY',
    remaining,
    maxBudget: face > 0 ? face : null,
    spend: null,
    count: usable.length,
    expiresAt,
  }
}

/** 分页拉取账号下全部代金券（`DescribeCoupon` 一页最多 100 条）。 */
export async function fetchCoupons({
  accessKeyId,
  accessKeySecret,
  securityToken,
  pageSize = 100,
  maxPages = 5,
  action = COUPON_ACTION,
  version = COUPON_VERSION,
  host = COUPON_HOST,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  signal,
  onTrace = () => {},
} = {}) {
  if (!accessKeyId || !accessKeySecret) throw new Error('缺少阿里云 AccessKey ID / Secret')
  const coupons = []
  for (let page = 1; page <= maxPages; page += 1) {
    const queryString = canonicalQuery({ CurrentPage: String(page), PageSize: String(pageSize) })
    const { headers } = signRequest({ accessKeyId, accessKeySecret, securityToken, queryString, action, version, host })
    onTrace(`request page=${page} action=${action}`)
    const response = await fetchImpl(`https://${host}/?${queryString}`, {
      method: 'POST',
      headers,
      body: '',
      redirect: 'manual',
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    }).catch(error => {
      throw new Error(`阿里云代金券查询网络失败：${error instanceof Error ? error.message : String(error)}`)
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      if (payload !== null && (typeof payload?.Code !== 'string' || payload.Code === '')) {
        // 有些错误响应体是 JSON 但没有 Code，仍按状态码报错。
        throw new Error(`阿里云返回 HTTP ${response.status}`)
      }
      const detail = [payload?.Code, payload?.Message].filter(part => typeof part === 'string' && part !== '')
      onTrace(`http ${response.status} ${detail.join(' ')}`)
      throw new Error(describeFailure(response.status, detail))
    }
    if (payload === null) throw new Error('阿里云代金券响应不是合法 JSON')
    if ((typeof payload.Code === 'string' && payload.Code !== 'Success' && payload.Code !== '200') || payload.Success === false) {
      const detail = [payload.Code, payload.Message].filter(part => typeof part === 'string' && part !== '').join(' ')
      throw new Error(`阿里云拒绝查询${detail === '' ? '' : `（${detail}）`}：确认 RAM 策略含 bss:DescribeCoupon`)
    }
    const batch = extractCoupons(payload)
    coupons.push(...batch)
    const total = Number(payload?.Data?.TotalCount ?? payload?.TotalCount ?? Number.NaN)
    if (batch.length < pageSize) break
    if (Number.isFinite(total) && coupons.length >= total) break
  }
  return coupons
}