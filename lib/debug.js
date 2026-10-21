/**
 * 可选诊断日志。
 *
 * 默认什么都不写（公开插件不该往别人硬盘上乱扔文件）。排查问题时可设：
 *   DSH_ALICOUPON_TRACE=C:\path\to\alicoupon.log
 * 每进程最多 60 行、文件超过 256KB 时清空重来，避免日志无限增长。
 */
import fs from 'node:fs'

const TRACE_FILE = process.env.DSH_ALICOUPON_TRACE ?? ''
let budget = TRACE_FILE === '' ? 0 : 60

export const traceEnabled = TRACE_FILE !== ''

export function trace(line) {
  if (budget <= 0) return
  budget -= 1
  try {
    if (fs.existsSync(TRACE_FILE) && fs.statSync(TRACE_FILE).size > 262144) fs.writeFileSync(TRACE_FILE, '')
    fs.appendFileSync(TRACE_FILE, `${new Date().toISOString()} ${line}\n`)
  } catch {
    budget = 0
  }
}