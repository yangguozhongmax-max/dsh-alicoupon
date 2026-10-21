#!/usr/bin/env node
/**
 * 体检脚本：一条命令看清「装没装上、行有没有数据」。
 *
 *   node scripts/doctor.mjs                          # 默认看桌面 profile（Electron）
 *   node scripts/doctor.mjs --profile web
 *   node scripts/doctor.mjs --port 50989             # 顺带问一次活着的宿主路由
 *   node scripts/doctor.mjs --json                   # 给脚本/CI 的机器可读输出
 *
 * 只读：不写任何文件、不改 profile、不碰凭据内容（只检查 ref 名字在不在，从不打印值）。
 * 退出码 0 = 没发现硬问题，1 = 有 error 级发现（warn 不影响退出码）。
 *
 * `inspect()` 是纯函数式入口（测试直接 import 它，不用起子进程）。
 */
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PACKAGE_NAME = 'dsh-alicoupon'
export const ROUTE_PREFIX = '/plugins/dsh-alicoupon'
export const CREDENTIAL_REFS = ['ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET', 'ALIBABA_CLOUD_SECURITY_TOKEN']

/**
 * @param {{home?: string, profile?: string, port?: number, env?: Record<string, string|undefined>}} options
 * @returns {Promise<{profile: string, profileDir: string, home: string, counts: {ok: number, warn: number, error: number}, checks: {level: string, title: string, detail: string}[]}>}
 */
export async function inspect(options = {}) {
  const home = options.home ?? homedir()
  const profile = options.profile ?? 'desktop'
  const port = Number(options.port ?? 0)
  const env = options.env ?? process.env
  const checks = []
  const add = (level, title, detail = '') => checks.push({ level, title, detail })
  const profileDir = join(home, '.dsh', 'profiles', profile)

  const finish = () => {
    const counts = { ok: 0, warn: 0, error: 0 }
    for (const check of checks) counts[check.level] += 1
    return { profile, profileDir, home, counts, checks }
  }

  let names = []
  try {
    const entries = await readdir(join(home, '.dsh', 'profiles'), { withFileTypes: true })
    names = entries.filter(entry => entry.isDirectory() && entry.name !== 'node_modules').map(entry => entry.name)
  } catch {
    add('error', '找不到 profiles 目录', join(home, '.dsh', 'profiles'))
  }

  if (names.length === 0) {
    add('error', 'profiles 目录里没有可用的 profile', join(home, '.dsh', 'profiles'))
  } else if (!names.includes(profile)) {
    add('error', `profile「${profile}」不存在`, `现有的：${names.join(', ')}（桌面 App 用 desktop，命令行 dsh web 用 web）`)
  } else {
    add('ok', `profile「${profile}」存在`, profileDir)
    await inspectProfileFiles({ add, profileDir, profile })
  }

  await inspectCredentials({ add, home, env })
  await inspectRoute({ add, port })
  return finish()
}

async function inspectProfileFiles({ add, profileDir, profile }) {
  const packageFile = join(profileDir, 'package.json')
  let manifest = null
  try {
    manifest = JSON.parse(await readFile(packageFile, 'utf8'))
  } catch (error) {
    add('error', '读不了 profile 的 package.json', `${packageFile}：${error?.message ?? error}`)
    return
  }

  const inDependencies = Boolean(manifest?.dependencies?.[PACKAGE_NAME] ?? manifest?.optionalDependencies?.[PACKAGE_NAME])
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  if (bundles.includes(PACKAGE_NAME)) {
    add('ok', 'dsh.profile.bundles 里有这个插件', `共 ${bundles.length} 个 bundle`)
  } else {
    add('error', 'dsh.profile.bundles 里没有这个插件', `跑 node scripts/link-into-profile.mjs ${profile} 会自动补上`)
  }
  if (!inDependencies) add('warn', 'package.json 的 dependencies 里没列这个插件', '手挂 junction / 符号链接时正常')

  const mounted = join(profileDir, 'node_modules', PACKAGE_NAME)
  try {
    const info = await lstat(mounted)
    if (info.isSymbolicLink()) {
      add('ok', '插件已挂进 node_modules（符号链接）', `→ ${await readlink(mounted)}`)
    } else if (info.isDirectory()) {
      add('ok', '插件已挂进 node_modules（目录）', mounted)
    } else {
      add('error', 'node_modules 里那一项不是目录也不是链接', mounted)
    }
    for (const relative of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml']) {
      try {
        await lstat(join(mounted, relative))
      } catch {
        add('error', `插件里缺 ${relative}`, join(mounted, relative))
      }
    }
  } catch {
    add('error', '插件没挂进 node_modules', `跑 node scripts/link-into-profile.mjs ${profile}`)
  }

  const patchFile = join(profileDir, 'cordis.patch.yml')
  try {
    const patch = await readFile(patchFile, 'utf8')
    if (patch.includes(PACKAGE_NAME)) add('ok', 'cordis.patch.yml 里有插件那一行', patchFile)
    else add('warn', 'cordis.patch.yml 里没看到插件那一行', '包自带 cordis.patch.yml，通常由 bundle 机制插入')
  } catch {
    add('warn', '没有 cordis.patch.yml', patchFile)
  }
}

async function inspectCredentials({ add, home, env }) {
  const file = join(home, '.dsh', '.credentials.yaml')
  const [ak, sk] = CREDENTIAL_REFS
  try {
    const text = await readFile(file, 'utf8')
    const found = CREDENTIAL_REFS.filter(ref => new RegExp(`^\\s*${ref}\\s*:`, 'm').test(text))
    if (found.includes(ak) && found.includes(sk)) {
      add('ok', '凭据库里有 AK/Secret 的 ref', `${file}（值未读取）`)
    } else {
      add('warn', '凭据库里缺 AK 或 Secret', `缺：${[ak, sk].filter(ref => !found.includes(ref)).join(' / ')}；可以在侧边栏那行的面板里填`)
    }
  } catch {
    add('warn', '没有凭据库文件', `${file}（可以用面板里的「保存凭据」写进去，或设环境变量）`)
  }
  for (const ref of CREDENTIAL_REFS.slice(0, 2)) {
    if (env[ref] !== undefined) add('warn', `环境变量 ${ref} 已设置`, '环境变量会遮蔽凭据库，插件改不动它')
  }
}

async function inspectRoute({ add, port }) {
  if (!(port > 0)) return
  const url = `http://127.0.0.1:${port}${ROUTE_PREFIX}/state`
  try {
    const response = await fetch(url, { cache: 'no-store' })
    const body = await response.text()
    if (response.status === 404) {
      add('warn', '路由 404：这个进程里宿主半边没加载', '宿主模块改动后要重启 App / 重启 dsh web，热重载不管用')
      return
    }
    let state = null
    try {
      state = JSON.parse(body)
    } catch {
      add('error', `路由返回了 ${response.status} 但不是 JSON`, body.slice(0, 120))
      return
    }
    const detail = [`status=${state.status}`, state.status === 'ok' ? `${state.remaining}/${state.maxBudget} ${state.unit}` : state.message]
      .filter(Boolean)
      .join('｜')
    add(
      state.status === 'ok' ? 'ok' : 'warn',
      `GET ${ROUTE_PREFIX}/state`,
      `${detail}${state.diagnostics ? `｜${JSON.stringify(state.diagnostics)}` : ''}`,
    )
  } catch (error) {
    add('warn', `连不上 ${url}`, `${error?.message ?? error}（App 没开？端口不对？用 --port 指定）`)
  }
}

export function render(result) {
  const mark = { ok: '✓', warn: '!', error: '✗' }
  const lines = [`dsh-alicoupon 体检：profile=${result.profile}  home=${result.home}`]
  for (const check of result.checks) lines.push(`${mark[check.level]} ${check.title}${check.detail ? ` —— ${check.detail}` : ''}`)
  lines.push('')
  lines.push(`${result.counts.ok} 项正常，${result.counts.warn} 项提醒，${result.counts.error} 项问题`)
  if (result.counts.error > 0) lines.push('按上面的提示修；排错表见 README「排错」。')
  return lines.join('\n')
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const argv = process.argv.slice(2)
  const flag = (name, fallback) => {
    const index = argv.indexOf(name)
    if (index === -1) return fallback
    const value = argv[index + 1]
    return value === undefined || value.startsWith('--') ? true : value
  }
  const result = await inspect({
    home: String(flag('--home', homedir())),
    profile: String(flag('--profile', 'desktop')),
    port: Number(flag('--port', '0')),
  })
  console.log(argv.includes('--json') ? JSON.stringify(result, null, 2) : render(result))
  process.exit(result.counts.error > 0 ? 1 : 0)
}