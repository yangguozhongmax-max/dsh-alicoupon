/**
 * `scripts/doctor.mjs` 的测试：在一个临时 home 里造出各种「装好了 / 没装好」的 profile，
 * 断言体检结论对得上。不联网（只有带 `port` 时才会 fetch，这里不传）。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { inspect, render } from '../scripts/doctor.mjs'

const REF_AK = 'ALIBABA_CLOUD_ACCESS_KEY_ID'
const REF_SK = 'ALIBABA_CLOUD_ACCESS_KEY_SECRET'

let home = ''

/** 造一个 profile：bundles 里含/不含插件、node_modules 里挂/不挂、插件文件全不全。 */
async function makeProfile(name, { bundle = true, mounted = true, complete = true, credentials = true } = {}) {
  const profileDir = join(home, '.dsh', 'profiles', name)
  await mkdir(join(profileDir, 'node_modules'), { recursive: true })
  await writeFile(
    join(profileDir, 'package.json'),
    JSON.stringify({ name: `dsh-profile-${name}`, dsh: { profile: { bundles: bundle ? ['@deepseek-ai/dsh-base', 'dsh-alicoupon'] : ['@deepseek-ai/dsh-base'] } } }, null, 2),
  )
  await writeFile(join(profileDir, 'cordis.patch.yml'), bundle ? '# patch\n- id: alicoupon\n  name: "dsh-alicoupon"\n' : '# patch\n[]\n')
  if (mounted) {
    const pluginDir = join(profileDir, 'node_modules', 'dsh-alicoupon')
    await mkdir(join(pluginDir, 'lib'), { recursive: true })
    for (const relative of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml']) {
      if (!complete && relative === 'lib/client.js') continue
      await writeFile(join(pluginDir, relative), '// stub\n')
    }
  }
  if (credentials) {
    await mkdir(join(home, '.dsh'), { recursive: true })
    await writeFile(join(home, '.dsh', '.credentials.yaml'), `refs:\n  ${REF_AK}: LTAI-fake\n  ${REF_SK}: fake-secret\n`)
  }
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-alicoupon-doctor-'))
})

after(async () => {
  await rm(home, { recursive: true, force: true })
})

test('体检：装好的 profile 应当全绿（依赖没列只是提醒）', async () => {
  await makeProfile('desktop')
  const result = await inspect({ home, profile: 'desktop', env: {} })
  assert.equal(result.counts.error, 0, JSON.stringify(result.checks, null, 2))
  assert.ok(result.checks.some(check => check.title.includes('符号链接') || check.title.includes('目录')))
  assert.ok(result.checks.some(check => check.title === 'dsh.profile.bundles 里有这个插件'))
  assert.ok(result.checks.some(check => check.level === 'warn' && check.title.includes('dependencies')))
  assert.ok(result.checks.some(check => check.title === '凭据库里有 AK/Secret 的 ref'))
  assert.ok(render(result).includes('0 项问题'))
})

test('体检：bundles 里没写 → error，并提示用 link-into-profile 补', async () => {
  await makeProfile('web', { bundle: false })
  const result = await inspect({ home, profile: 'web', env: {} })
  assert.equal(result.counts.error, 1)
  const failure = result.checks.find(check => check.level === 'error')
  assert.equal(failure.title, 'dsh.profile.bundles 里没有这个插件')
  assert.ok(failure.detail.includes('link-into-profile.mjs web'))
})

test('体检：插件文件缺一个 → error 指到具体路径', async () => {
  await makeProfile('broken', { complete: false })
  const result = await inspect({ home, profile: 'broken', env: {} })
  const failure = result.checks.find(check => check.level === 'error')
  assert.ok(failure.title.includes('lib/client.js'), JSON.stringify(result.checks, null, 2))
})

test('体检：profile 不存在 → 列出已有的', async () => {
  const result = await inspect({ home, profile: 'nope', env: {} })
  const failure = result.checks.find(check => check.level === 'error')
  assert.equal(failure.title, 'profile「nope」不存在')
  assert.ok(failure.detail.includes('desktop') && failure.detail.includes('web'))
})

test('体检：没有凭据库 → 提醒，但不是「插件没装好」之外的 error', async () => {
  const lonely = await mkdtemp(join(tmpdir(), 'dsh-alicoupon-doctor-empty-'))
  try {
    await mkdir(join(lonely, '.dsh', 'profiles'), { recursive: true })
    const result = await inspect({ home: lonely, profile: 'desktop', env: {} })
    assert.equal(result.counts.error, 1, 'profiles 目录是空的，应当报一个 error')
    assert.equal(result.checks.find(check => check.level === 'error').title, 'profiles 目录里没有可用的 profile')
    assert.ok(result.checks.some(check => check.level === 'warn' && check.title === '没有凭据库文件'))
  } finally {
    await rm(lonely, { recursive: true, force: true })
  }
})

test('体检：环境变量会遮蔽凭据库 → 提醒里说清', async () => {
  await makeProfile('envprofile')
  const result = await inspect({ home, profile: 'envprofile', env: { [REF_AK]: 'from-env' } })
  assert.ok(result.checks.some(check => check.level === 'warn' && check.title.includes(REF_AK) && check.detail.includes('遮蔽')))
})