#!/usr/bin/env node
/**
 * 命令行探针：不开 DSH，直接查一次阿里云代金券。
 * 用来确认 AK 是否正确、RAM 权限是否够、以及插件会显示什么。
 *
 * 用法：
 *   node scripts/probe.mjs                      # 读环境变量 ALIBABA_CLOUD_ACCESS_KEY_ID / _SECRET
 *   node scripts/probe.mjs <AccessKeyId> <Secret> [SecurityToken]
 *   node scripts/probe.mjs --raw                # 额外打印每一张券的原始字段
 *   node scripts/probe.mjs --trace              # 打印请求过程（排查签名/分页问题）
 *   node scripts/probe.mjs --label 千问学生券
 */
import { fetchCoupons, summarizeCoupons } from '../lib/aliyun-coupon.js'

const argv = process.argv.slice(2)
const raw = argv.includes('--raw')
const trace = argv.includes('--trace')
const labelIndex = argv.indexOf('--label')
const label = labelIndex === -1 ? '阿里云代金券' : argv[labelIndex + 1]
const positional = argv.filter((arg, index) => !arg.startsWith('--') && index !== labelIndex + 1)
const [argId, argSecret, argToken] = positional

const accessKeyId = argId ?? process.env.ALIBABA_CLOUD_ACCESS_KEY_ID ?? ''
const accessKeySecret = argSecret ?? process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET ?? ''
const securityToken = argToken ?? process.env.ALIBABA_CLOUD_SECURITY_TOKEN ?? ''

if (!accessKeyId || !accessKeySecret) {
  console.error('缺少 AccessKey：请设 ALIBABA_CLOUD_ACCESS_KEY_ID / _SECRET，或作为参数传入。')
  process.exit(2)
}

try {
  const coupons = await fetchCoupons({
    accessKeyId,
    accessKeySecret,
    securityToken,
    onTrace: trace ? line => console.error(`· ${line}`) : undefined,
  })
  const summary = summarizeCoupons(coupons, { label })
  console.log(JSON.stringify(summary, null, 2))
  console.error(`\n共 ${coupons.length} 张券，其中可用 ${summary.count} 张。`)
  if (raw) {
    console.log('\n--- 原始券列表 ---')
    for (const coupon of coupons) {
      console.log(JSON.stringify({
        CouponId: coupon?.CouponId,
        CouponName: coupon?.CouponName,
        Status: coupon?.Status,
        Amount: coupon?.Amount,
        RemainAmount: coupon?.RemainAmount,
        Currency: coupon?.Currency,
        StartTime: coupon?.StartTime,
        EndTime: coupon?.EndTime,
      }))
    }
  }
} catch (error) {
  console.error(`查询失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}