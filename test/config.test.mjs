import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONFIG_FILE, sanitizeConfigPatch } from '../lib/index.js'

test('sanitizeConfigPatch：只放行 label 与 refreshMinutes', () => {
  assert.deepEqual(sanitizeConfigPatch({ label: '千问学生券', refreshMinutes: 5 }), {
    label: '千问学生券',
    refreshMinutes: 5,
  })
  // 别的字段一律丢掉——这是插件里唯一能写东西的端点，不能让它顺手改凭据 ref 之类。
  assert.deepEqual(sanitizeConfigPatch({ credentialRefs: { accessKeyId: 'x' }, timeoutMs: 1 }), {})
  assert.deepEqual(sanitizeConfigPatch(null), {})
  assert.deepEqual(sanitizeConfigPatch('nope'), {})
})

test('sanitizeConfigPatch：label 去空格、非空、限长', () => {
  assert.deepEqual(sanitizeConfigPatch({ label: '  阿里云代金券  ' }), { label: '阿里云代金券' })
  assert.deepEqual(sanitizeConfigPatch({ label: '   ' }), {})
  assert.deepEqual(sanitizeConfigPatch({ label: 42 }), {})
  assert.deepEqual(sanitizeConfigPatch({ label: 'x'.repeat(41) }), {})
  assert.deepEqual(sanitizeConfigPatch({ label: 'x'.repeat(40) }), { label: 'x'.repeat(40) })
})

test('sanitizeConfigPatch：refreshMinutes 取整并夹在 1..1440', () => {
  assert.deepEqual(sanitizeConfigPatch({ refreshMinutes: 1 }), { refreshMinutes: 1 })
  assert.deepEqual(sanitizeConfigPatch({ refreshMinutes: '15' }), { refreshMinutes: 15 })
  assert.deepEqual(sanitizeConfigPatch({ refreshMinutes: 2.6 }), { refreshMinutes: 3 })
  assert.deepEqual(sanitizeConfigPatch({ refreshMinutes: 0 }), {})
  assert.deepEqual(sanitizeConfigPatch({ refreshMinutes: 1441 }), {})
  assert.deepEqual(sanitizeConfigPatch({ refreshMinutes: Number.NaN }), {})
  assert.deepEqual(sanitizeConfigPatch({ refreshMinutes: Infinity }), {})
})

test('配置文件路径可以被环境变量顶掉（便于测试与多 profile 隔离）', () => {
  assert.equal(typeof CONFIG_FILE, 'string')
  assert.ok(CONFIG_FILE.endsWith('config.json'), CONFIG_FILE)
  if (process.env.DSH_ALICOUPON_CONFIG !== undefined) {
    assert.equal(CONFIG_FILE, process.env.DSH_ALICOUPON_CONFIG)
  } else {
    assert.ok(CONFIG_FILE.includes('dsh-alicoupon'), CONFIG_FILE)
  }
})