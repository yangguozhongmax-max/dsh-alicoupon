#!/usr/bin/env node
/**
 * 把本包挂进某个 DSH profile。
 *
 * 为什么需要它：桌面 App 独占自己的 profile，`dsh plugin --profile desktop add …` 会被 CLI 拒绝，
 * 而 App 内的插件市场又只能装市场里有的包。开发时最省事的做法就是手工挂载——
 * 这个脚本把「放 node_modules + 写进 dsh.profile.bundles」两件事做完，并且幂等。
 *
 *   node scripts/link-into-profile.mjs                # 默认 desktop，目录联接（Windows 免管理员）
 *   node scripts/link-into-profile.mjs web            # 指定 profile
 *   node scripts/link-into-profile.mjs desktop --copy # 复制而不是联接（没权限建联接时用）
 *   node scripts/link-into-profile.mjs desktop --unlink
 *   node scripts/link-into-profile.mjs desktop --dry   # 只看会做什么
 *
 * 改完要**重启 App**：热重载不会重新 import 已经加载过的宿主模块。
 */
import { cp, lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-alicoupon'
const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profilesDir = join(homedir(), '.dsh', 'profiles')

const args = process.argv.slice(2)
const flags = new Set(args.filter((arg) => arg.startsWith('--')))
const positional = args.filter((arg) => !arg.startsWith('--'))
const profile = positional[0] ?? 'desktop'
const dry = flags.has('--dry')
const unlink = flags.has('--unlink')
const copy = flags.has('--copy')

const say = (message) => console.log(`${dry ? '[dry] ' : ''}${message}`)

const profileDir = join(profilesDir, profile)
if (!existsSync(profileDir)) {
  const known = existsSync(profilesDir)
    ? (await readdir(profilesDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
        .map((entry) => entry.name)
        .join(', ') || '（一个都没有）'
    : '（一个都没有）'
  console.error(`找不到 profile 目录：${profileDir}\n已有的 profile：${known}`)
  process.exit(2)
}

const target = join(profileDir, 'node_modules', PACKAGE_NAME)
const manifestPath = join(profileDir, 'package.json')
const backupPath = `${manifestPath}.${PACKAGE_NAME}.bak`

const readManifest = async () => JSON.parse(await readFile(manifestPath, 'utf8'))

/** 已有的挂载点可能是联接、符号链接、普通目录或根本不存在。 */
const describeTarget = async () => {
  try {
    const info = await lstat(target)
    if (info.isSymbolicLink()) return 'link'
    if (info.isDirectory()) return 'dir'
    return 'other'
  } catch {
    return 'missing'
  }
}

const removeTarget = async () => {
  const kind = await describeTarget()
  if (kind === 'missing') return false
  // 只删联接本身，不跟着删到源码目录里去（rm 对符号链接/联接就是删链接）。
  await rm(target, { recursive: kind === 'dir', force: true })
  return true
}

if (unlink) {
  say(`从 ${manifestPath} 的 dsh.profile.bundles 里去掉 "${PACKAGE_NAME}"，并删掉 ${target}`)
  if (!dry) {
    if (await removeTarget()) console.log(`已删除挂载点 ${target}`)
    const manifest = await readManifest()
    const bundles = manifest?.dsh?.profile?.bundles
    if (Array.isArray(bundles) && bundles.includes(PACKAGE_NAME)) {
      await writeFile(backupPath, await readFile(manifestPath, 'utf8'))
      manifest.dsh.profile.bundles = bundles.filter((name) => name !== PACKAGE_NAME)
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      console.log(`已从 dsh.profile.bundles 移除（备份 ${backupPath}）`)
    }
  }
  process.exit(0)
}

if (!existsSync(join(PACKAGE_DIR, 'cordis.patch.yml')) || !existsSync(join(PACKAGE_DIR, 'lib', 'index.js'))) {
  console.error(`这不像本包的目录：${PACKAGE_DIR}（缺 cordis.patch.yml 或 lib/index.js）`)
  process.exit(2)
}

say(`profile：${profileDir}`)
say(`挂载点：${target}（现状：${await describeTarget()}）`)
say(copy ? '方式：复制' : `方式：目录联接 → ${PACKAGE_DIR}`)

const manifest = await readManifest()
if (manifest?.dsh?.profile === undefined) {
  console.error(`${manifestPath} 里没有 dsh.profile 字段——这不是一个 DSH profile 的 package.json？`)
  process.exit(2)
}
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
const alreadyListed = bundles.includes(PACKAGE_NAME)
say(`dsh.profile.bundles：${alreadyListed ? '已包含' : `将追加 "${PACKAGE_NAME}"`}`)

if (!dry) {
  await mkdir(join(profileDir, 'node_modules'), { recursive: true })
  const removed = await removeTarget()
  if (removed) console.log(`（覆盖了原有的挂载点）`)
  if (copy) {
    await cp(PACKAGE_DIR, target, {
      recursive: true,
      filter: (source) => !/(\\|\/)(node_modules|\.git)(\\|\/|$)/.test(`${source}\\`),
    })
    console.log(`已复制到 ${target}`)
  } else {
    try {
      await symlink(PACKAGE_DIR, target, process.platform === 'win32' ? 'junction' : 'dir')
      console.log(`已建立${process.platform === 'win32' ? '目录联接' : '符号链接'} ${target} -> ${PACKAGE_DIR}`)
    } catch (error) {
      console.error(`建链接失败：${error?.message ?? error}\n试试加 --copy（复制一份过去）。`)
      process.exit(1)
    }
  }
  if (!alreadyListed) {
    await writeFile(backupPath, await readFile(manifestPath, 'utf8'))
    manifest.dsh.profile.bundles = [...bundles, PACKAGE_NAME]
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`已把 "${PACKAGE_NAME}" 写进 dsh.profile.bundles（备份 ${backupPath}）`)
  }
}

console.log(dry ? '（dry run，什么都没改）' : '完成。请重启 DSH（桌面 App 请完全退出再打开）：热重载不会重新 import 已加载的宿主模块。')