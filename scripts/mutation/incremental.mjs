/**
 * 增量模式（opt-in）：`--changed` 只跑受影响的变异，`--incremental` 复用 caught 缓存。
 * gate 默认路径**完全不知道缓存存在**（判据是「这一轮真的把每条都改坏了一次」）。
 *
 * 缓存 key 的脚本版本 = **入口 + scripts/mutation/ 下全部模块**的内容哈希：拆模块之后，
 * 只哈希入口会让「改了判定逻辑但缓存还认旧结论」变成伪绿。目录枚举保证新增模块自动纳入。
 *
 * 为什么默认关：gate 的判据是「这一轮真的把每条都改坏了一次」。缓存只服务开发内环
 *（改一个文件后只重跑受影响的那几条），全量 gate 永远走完整路径（不传 --changed/--incremental）。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT } from './host.mjs'

const CACHE_PATH = path.join(ROOT, '.mutation-cache.json')
const RUNNER_DIR = fileURLToPath(new URL('./', import.meta.url))
const ENTRY_FILE = fileURLToPath(new URL('../mutation-test.mjs', import.meta.url))
/** 入口 + 本目录全部模块（排序，新增模块自动纳入）。 */
export const RUNNER_FILES = [ENTRY_FILE, ...readdirSync(RUNNER_DIR)
  .filter((name) => name.endsWith('.mjs'))
  .map((name) => path.join(RUNNER_DIR, name))].sort()

// 脚本自身进 key：判定逻辑或条目改过，旧缓存必须整体失效。
export function scriptVersion() {
  const hash = createHash('sha256')
  for (const file of RUNNER_FILES) hash.update(readFileSync(file))
  return hash.digest('hex').slice(0, 16)
}

// src/x.ts → lib/x.js；src/client/** 整体产物是单文件 lib/client.js。
export function libOfSource(file) {
  if (file.startsWith('src/client/')) return 'lib/client.js'
  const matched = /^src\/(.+)\.tsx?$/.exec(file)
  return matched === null ? undefined : 'lib/' + matched[1] + '.js'
}

// git 里的改动 → 受影响的变异。判据只有两条（用户裁决的口径）：
//   改了某个 lib 文件 → 跑该文件的全部变异；改了测试文件 → 让所有 judge 含该测试的变异失效。
// 其余（文档/AGENTS 等）不影响判据。
export function affectedPredicate(files) {
  const libFiles = new Set()
  const testFiles = new Set()
  let all = false
  for (const file of files) {
    if (file.startsWith('lib/')) libFiles.add(file)
    else if (file.startsWith('tests/')) testFiles.add(file.split('/').pop())
    else if (file.startsWith('src/')) {
      const lib = libOfSource(file)
      if (lib === undefined) all = true
      else libFiles.add(lib)
    } else if (file === 'package.json' || file === 'scripts/mutation-test.mjs' || file.startsWith('scripts/mutation/') || file === 'scripts/build.sh') all = true
  }
  return (m) => all || libFiles.has(m.file) || (m.judges ?? []).some((judge) => testFiles.has(judge))
}

export function gitChangedFiles() {
  try {
    const tracked = execSync('git diff --name-only HEAD', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const untracked = execSync('git ls-files --others --exclude-standard', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const lines = (tracked + String.fromCharCode(10) + untracked).split(String.fromCharCode(10))
    return [...new Set(lines.map((line) => line.trim()).filter(Boolean))]
  } catch (error) {
    console.error('--changed 需要可用的 git：' + error.message)
    return undefined
  }
}

function sha256OfFile(file) {
  return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : 'missing'
}

// key 至少含：变异 id / from / to / 目标文件内容 / judge 文件内容 / Node 主版本 / 脚本版本。
export function mutationCacheKey(m, version) {
  const parts = [m.id, m.file, m.from, m.to, process.versions.node.split('.')[0], version, sha256OfFile(path.join(ROOT, m.file))]
  for (const judge of [...new Set(m.judges ?? [])].sort()) parts.push(judge + ':' + sha256OfFile(path.join(ROOT, 'tests', judge)))
  return createHash('sha256').update(parts.join(String.fromCharCode(0))).digest('hex')
}

export function loadCache() {
  try {
    const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
    return raw !== null && typeof raw === 'object' && typeof raw.entries === 'object' ? raw : { entries: {} }
  } catch {
    // 缓存损坏/不存在都退回空缓存：它是加速件，不是判据（entries 为空 ⇒ 全部重跑）
    return { entries: {} }
  }
}

export function saveCache(cache) {
  // 只缓存 caught：survived / crashed / unapplied 永远重跑（它们本来就该让 gate 红）。
  writeFileSync(CACHE_PATH, JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), entries: cache.entries }, null, 2) + String.fromCharCode(10))
}
