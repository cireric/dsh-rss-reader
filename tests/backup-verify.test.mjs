/**
 * M5 04 的校验器判据：**拒绝恢复必须是显式的**。
 *
 * 这个文件只测一件事：`scripts/verify-backup.mjs` 对「好的副本」说可以、对四类坏副本逐一说不，
 * 并且**绝不改输入**（损坏副本不许把好数据覆盖掉 —— 第一步就是别碰它）。
 *
 * 为什么用真进程而不是把 main() 导出来调：它是个 CLI，退出码与 stderr 就是运维看到的东西；
 * 把实现 import 进来测，测的是「我以为的入口」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase, migrateSchema, SCHEMA_VERSION } from '../lib/storage/db.js'
import { writeConfigFile } from '../lib/storage/config-file.js'

const SCRIPT = new URL('../scripts/verify-backup.mjs', import.meta.url).pathname
const ROUND = '2026-10-11T09:00:00.000Z'
const FEED = 'https://a.example/feed.xml'

/** 造一份「像真的」备份目录：真库（含一条条目）+ 真 config.json。 */
function makeBackup(tag, { feeds = { [FEED]: { url: FEED, title: '源 A' } }, items = 1 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rss-backup-' + tag + '-'))
  const db = openDatabase(join(dir, 'rss.db'))
  migrateSchema(db)
  const insert = db.prepare('INSERT INTO items (id, feed_id, title, link, fetched_at, starred) VALUES (?, ?, ?, ?, ?, 0)')
  for (let i = 0; i < items; i += 1) insert.run('item-' + i, FEED, '标题 ' + i, 'https://a.example/' + i, ROUND)
  db.close()
  writeConfigFile(join(dir, 'config.json'), { version: 1, feeds })
  return dir
}

const verify = (dir) => spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' })
const hashOf = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

test('好副本：四类必查项全过，退出码 0，且一个字节都没改', () => {
  const dir = makeBackup('ok')
  try {
    const before = hashOf(join(dir, 'rss.db'))
    const result = verify(dir)
    assert.equal(result.status, 0, '应当判定可以恢复，实际 stderr：' + result.stderr)
    assert.match(result.stdout, /integrity_check = ok/)
    assert.match(result.stdout, /库版本 \d+（本版支持 1\.\.\d+/)  // 版本号由 db.ts 的 SCHEMA_VERSION 决定，这里只钉「报告了版本与支持区间」
    assert.match(result.stdout, /订阅 1 条/)
    assert.match(result.stdout, /可以恢复/)
    assert.equal(hashOf(join(dir, 'rss.db')), before, '校验器是只读的：库文件哈希不许变')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('缺文件：rss.db 不在就把「缺什么」说清楚', () => {
  const dir = makeBackup('missing-db')
  try {
    rmSync(join(dir, 'rss.db'))
    const result = verify(dir)
    assert.equal(result.status, 2, '缺库必须拒绝恢复')
    assert.match(result.stderr, /rss\.db 缺失/)
    assert.match(result.stderr, /原数据未做任何改动/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('缺文件：config.json 不在也必须拒绝（空订阅等于「订阅全没了」）', () => {
  const dir = makeBackup('missing-config')
  try {
    rmSync(join(dir, 'config.json'))
    const result = verify(dir)
    assert.equal(result.status, 2)
    assert.match(result.stderr, /config\.json 缺失|订阅/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('损坏副本：截断/垃圾字节的库必须响亮失败，而不是被当成空库', () => {
  const dir = makeBackup('corrupt')
  try {
    writeFileSync(join(dir, 'rss.db'), 'this is not a sqlite file\n'.repeat(20))
    const result = verify(dir)
    assert.equal(result.status, 2)
    // 具体落在哪一步取决于 SQLite 什么时候碰坏页：打开时或第一次查询时，两者都必须变成「拒绝恢复」
    assert.match(result.stderr, /打不开|integrity_check|读不出来/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('能打开但页结构坏了：必须由 integrity_check 拦住（损坏不都在打开时现形）', () => {
  // 手工翻坏第 3 页中间的字节：文件头完好 ⇒ 打得开、版本号也读得出来，只有完整性检查看得见。
  // 少了这道检查，「半截拷贝但头部完好」的副本会被当成好备份恢复进去。
  const dir = makeBackup('badpage', { items: 500 })
  try {
    // 从第 2 页开始翻坏三页：页 1（文件头 + user_version）保持完好 ⇒ 打得开、版本读得出，
    // 只有 integrity_check 看得见（实测：只翻一页会落进空闲区，什么也测不出来）
    const fd = openSync(join(dir, 'rss.db'), 'r+')
    writeSync(fd, Buffer.alloc(12288, 0x41), 0, 12288, 4096)
    closeSync(fd)
    const result = verify(dir)
    assert.equal(result.status, 2, '页结构坏了必须拒绝恢复')
    assert.match(result.stderr, /integrity_check 不通过/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('未知版本：比当前版本新的库拒绝恢复（那是别的插件版本写的）', () => {
  const dir = makeBackup('future')
  try {
    const db = new DatabaseSync(join(dir, 'rss.db'))
    db.exec('PRAGMA user_version = 99')
    db.close()
    const result = verify(dir)
    assert.equal(result.status, 2)
    assert.match(result.stderr, /格式版本是 99/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('订阅丢了：库里有条目但 config.json 没有订阅 ⇒ 拒绝（与装载路径同一条判据）', () => {
  const dir = makeBackup('no-feeds', { feeds: {} })
  try {
    const result = verify(dir)
    assert.equal(result.status, 2)
    assert.match(result.stderr, /订阅副本丢了/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('空订阅 + 空库是合法的（新装用户也能备份/恢复）', () => {
  const dir = makeBackup('empty', { feeds: {}, items: 0 })
  try {
    const result = verify(dir)
    assert.equal(result.status, 0, '没有任何条目时，空订阅不算「订阅丢了」：' + result.stderr)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('用法错误：不给目录时打印用法并退出 2（不误判为「可以恢复」）', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /用法/)
})


test('P2-4 config.json 里的 feed 记录不合 FeedRecord ⇒ 拒绝恢复（与装载路径同一条判据）', () => {
  const dir = makeBackup('bad-feed')
  try {
    // writeConfigFile 会在写侧校验，所以这里必须直接写原始 JSON（模拟被别的写入者改坏的副本）
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 1, feeds: { [FEED]: { title: 5 } } }, null, 2))
    const result = verify(dir)
    assert.equal(result.status, 2, '不可装载的 config.json 不许判「可以恢复」：' + result.stderr)
    assert.match(result.stderr, /不能装载/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
