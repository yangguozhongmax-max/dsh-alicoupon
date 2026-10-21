import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  describeFailure,
  extractCoupons,
  fetchCoupons,
  isUsable,
  signRequest,
  summarizeCoupons,
} from '../lib/aliyun-coupon.js'

const coupon = (over = {}) => ({
  CouponId: 'c1',
  CouponName: '测试券',
  Status: 'Available',
  Amount: 300,
  RemainAmount: 287.54,
  Currency: 'CNY',
  StartTime: '2026-10-21T00:00:00Z',
  EndTime: '2027-10-20T15:59:59Z',
  ...over,
})

test('isUsable：剩余金额为 0 或已过期都算不可用', () => {
  const now = Date.parse('2026-10-21T00:00:00Z')
  assert.equal(isUsable(coupon(), now), true)
  assert.equal(isUsable(coupon({ RemainAmount: 0 }), now), false)
  assert.equal(isUsable(coupon({ EndTime: '2020-01-01T00:00:00Z' }), now), false)
  // 没给到期时间时只看余额
  assert.equal(isUsable(coupon({ EndTime: undefined }), now), true)
})

test('summarizeCoupons：金额汇总全部可用券，到期日取面值最大那张', () => {
  const now = Date.parse('2026-10-21T00:00:00Z')
  const summary = summarizeCoupons([
    coupon(),
    coupon({ CouponId: 'c2', Amount: 10, RemainAmount: 10, EndTime: '2026-12-31T00:00:00Z' }),
    coupon({ CouponId: 'c3', Amount: 50, RemainAmount: 0 }),
  ], { label: '千问学生券', now })
  assert.equal(summary.remaining, 297.54)
  assert.equal(summary.maxBudget, 310)
  assert.equal(summary.expiresAt, '2027-10-20')
  assert.equal(summary.label, '千问学生券 · 2027-10-20 到期')
  assert.equal(summary.unit, 'CNY')
  assert.equal(summary.count, 2)
})

test('summarizeCoupons：一张券都没有 / 全都用完，抛的文案不同', () => {
  assert.throws(() => summarizeCoupons([]), /没有代金券/)
  assert.throws(() => summarizeCoupons([coupon({ RemainAmount: 0 })]), /用完或过期/)
})

test('extractCoupons：兼容三种响应形状', () => {
  assert.deepEqual(extractCoupons({ Data: [coupon()] }).length, 1)
  assert.deepEqual(extractCoupons({ Data: { Coupons: [coupon()] } }).length, 1)
  assert.deepEqual(extractCoupons({ Coupons: [coupon()] }).length, 1)
  assert.deepEqual(extractCoupons({}), [])
})

test('describeFailure：把常见错误码翻成人话', () => {
  assert.match(describeFailure(404, ['InvalidAccessKeyId.NotFound', 'Specified access key is not found.']), /AccessKey ID 无效/)
  assert.match(describeFailure(400, ['SignatureDoesNotMatch', '']), /Secret 不正确/)
  assert.match(describeFailure(403, ['Forbidden', '']), /bss:DescribeCoupon/)
  assert.match(describeFailure(500, []), /HTTP 500/)
})

test('signRequest：签名头齐全且 Authorization 形状正确', () => {
  const { headers } = signRequest({
    accessKeyId: 'LTAI-test',
    accessKeySecret: 'secret',
    queryString: 'CurrentPage=1&PageSize=100',
  })
  assert.equal(headers['x-acs-action'], 'DescribeCoupon')
  assert.equal(headers['x-acs-version'], '2023-09-30')
  assert.match(headers['x-acs-date'], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  assert.match(headers.Authorization, /^ACS3-HMAC-SHA256 Credential=LTAI-test,SignedHeaders=.*,Signature=[0-9a-f]{64}$/)
  // 每次签名的 nonce 与签名都不同
  const second = signRequest({ accessKeyId: 'LTAI-test', accessKeySecret: 'secret', queryString: 'CurrentPage=1&PageSize=100' })
  assert.notEqual(second.headers.Authorization, headers.Authorization)
})

test('fetchCoupons：满页时翻页，第二页不满就停', async () => {
  const pages = []
  const fetchImpl = async (url, init) => {
    const page = new URL(url).searchParams.get('CurrentPage')
    pages.push(page)
    assert.equal(init.method, 'POST')
    assert.match(init.headers.Authorization, /ACS3-HMAC-SHA256/)
    const batch = page === '1'
      ? Array.from({ length: 100 }, (_, index) => coupon({ CouponId: `c${index}` }))
      : [coupon({ CouponId: 'last' })]
    return { ok: true, status: 200, json: async () => ({ Code: 'Success', Data: { Coupons: batch, TotalCount: 101 } }) }
  }
  const coupons = await fetchCoupons({ accessKeyId: 'a', accessKeySecret: 'b', fetchImpl })
  assert.deepEqual(pages, ['1', '2'])
  assert.equal(coupons.length, 101)
})

test('fetchCoupons：HTTP 失败按阿里云的 Code 报错', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 404,
    json: async () => ({ Code: 'InvalidAccessKeyId.NotFound', Message: 'Specified access key is not found.' }),
  })
  await assert.rejects(
    () => fetchCoupons({ accessKeyId: 'a', accessKeySecret: 'b', fetchImpl }),
    /AccessKey ID 无效或已被删除/,
  )
})

test('fetchCoupons：Success=false 时提示补权限', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ Success: false, Code: 'NoPermission', Message: 'not authorized' }),
  })
  await assert.rejects(
    () => fetchCoupons({ accessKeyId: 'a', accessKeySecret: 'b', fetchImpl }),
    /bss:DescribeCoupon/,
  )
})

test('fetchCoupons：缺凭据时直接报错，不发请求', async () => {
  let called = 0
  await assert.rejects(
    () => fetchCoupons({ accessKeyId: '', accessKeySecret: '', fetchImpl: async () => { called += 1 } }),
    /缺少阿里云 AccessKey/,
  )
  assert.equal(called, 0)
})