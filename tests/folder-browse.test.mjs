/**
 * M2 03：文件夹浏览的宿主判据。
 *
 * 这一层的病象是「文件夹里少了几条」：若先取跨源首页再在客户端按成员过滤，成员条目只要
 * 不在旧跨源首页里就永远看不到（首屏截断）。所以本文件用 maxItemsShown=2 的极小窗口，
 * 让「先筛后限页」与「先限页后筛」产生**可观察的不同结果**。
 *
 * 另守两条游标纪律：
 *  - 文件夹游标必须绑「文件夹名 + 当前成员」；拿无范围游标或别的文件夹游标续页要坏；
 *  - 成员被移进/移出后，旧游标必须失配，客户端只能从第一页重来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrateSchema } from '../lib/storage/db.js'
import { writeConfigFile } from '../lib/storage/config-file.js'
import { createSqliteStore } from '../lib/store-sqlite.js'
import { createDispatch } from '../lib/endpoints.js'
import { Config } from '../lib/config.js'

const A = 'https://a.example/feed.xml'
const B = 'https://b.example/feed.xml'
const C = 'https://c.example/feed.xml'
const D = 'https://d.example/feed.xml'

function makeDispatch() {
  const dir = mkdtempSync(join(tmpdir(), 'rss-folder-browse-'))
  const configPath = join(dir, 'config.json')
  writeConfigFile(configPath, {
    version: 1,
    folders: ['技术', '其他', '空的'],
    feeds: {
      [A]: { url: A, title: 'A', folder: '技术' },
      [B]: { url: B, title: 'B', folder: '技术' },
      [C]: { url: C, title: 'C' },
      [D]: { url: D, title: 'D', folder: '其他' },
    },
  })
  const db = openDatabase(':memory:')
  migrateSchema(db)
  const store = createSqliteStore(db, configPath)
  const insert = db.prepare(
    'INSERT INTO items (id, feed_id, title, link, published_at, fetched_at, starred)'
    + ' VALUES (?, ?, ?, ?, ?, ?, 0)',
  )
  // 跨源首页按 c 的最新条目开头；文件夹「技术」的条目都在其后 —— 先限页再筛会一条不漏地丢掉它们。
  const rows = [
    ['c3', C, '2026-10-12T00:00:00.000Z'],
    ['c2', C, '2026-10-11T00:00:00.000Z'],
    ['c1', C, '2026-10-10T00:00:00.000Z'],
    ['a1', A, '2026-10-09T00:00:00.000Z'],
    ['a2', A, '2026-10-08T00:00:00.000Z'],
    ['b1', B, '2026-10-07T00:00:00.000Z'],
    ['b2', B, '2026-10-06T00:00:00.000Z'],
    ['d1', D, '2026-10-05T00:00:00.000Z'],
  ]
  for (const [id, feedId, at] of rows) {
    insert.run(id, feedId, '标题 ' + id, 'https://site.example/' + id, at, at)
  }
  const dispatch = createDispatch({
    config: Config({ maxItemsShown: 2 }),
    log: () => {},
    ready: () => store,
    refreshNow: async () => false,
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
  })
  return { dispatch, store, db, dir, configPath, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('文件夹浏览先按成员筛选再限页：成员条目不会落到跨源首页之外', async () => {
  const h = makeDispatch()
  try {
    const first = await h.dispatch('overview', { folder: '技术' })
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.deepEqual(first.value.items.map((item) => item.id), ['a1', 'a2'], '第一页只含文件夹成员且按时间倒序')
    assert.ok(first.value.nextCursor, '技术文件夹有 4 条，2 条一页应当有续页')
    assert.equal(first.value.feeds.length, 4, '左栏仍要拿到全量 feeds')
    assert.deepEqual(first.value.folders.map((folder) => folder.name), ['技术', '其他', '空的'], '目录含空文件夹')
    assert.equal(first.value.unread, 8, '未读账仍是全局权威值（不是按文件夹截断后的数）')

    const second = await h.dispatch('overview', { folder: '技术', cursor: first.value.nextCursor })
    assert.equal(second.ok, true, JSON.stringify(second))
    assert.deepEqual(second.value.items.map((item) => item.id), ['b1', 'b2'], '第二页是成员的后两条，没有 c/d')
    assert.equal(second.value.nextCursor, undefined, '成员 4 条取完即到底')
  } finally { h.cleanup() }
})

test('空文件夹返回空列表与完整目录；不存在的文件夹明确 not-found', async () => {
  const h = makeDispatch()
  try {
    const empty = await h.dispatch('overview', { folder: '空的' })
    assert.equal(empty.ok, true, JSON.stringify(empty))
    assert.deepEqual(empty.value.items, [], '空文件夹不查全表')
    assert.equal(empty.value.nextCursor, undefined)
    assert.equal(empty.value.feeds.length, 4)
    assert.deepEqual(empty.value.folders.map((folder) => folder.name), ['技术', '其他', '空的'])
    assert.equal(empty.value.unread, 8, '空范围不影响全局未读账')

    const missing = await h.dispatch('overview', { folder: '不存在' })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'not-found')
  } finally { h.cleanup() }
})

test('文件夹游标绑定范围与成员：无范围/别的文件夹/成员变动后的旧游标全部 bad-request', async () => {
  const h = makeDispatch()
  try {
    const first = await h.dispatch('overview', { folder: '技术' })
    assert.equal(first.ok, true)
    const cursor = first.value.nextCursor
    assert.equal(typeof cursor, 'string')

    const unscoped = await h.dispatch('overview', { cursor })
    assert.equal(unscoped.ok, false)
    assert.equal(unscoped.error.code, 'bad-request', '无范围调用不许拿有范围游标续页')

    const otherFolder = await h.dispatch('overview', { folder: '其他', cursor })
    assert.equal(otherFolder.ok, false)
    assert.equal(otherFolder.error.code, 'bad-request', '别的文件夹同样不匹配')

    // 成员变动：b 被移出技术 ⇒ 范围键变化 ⇒ 同一文件夹的旧游标也必须失效。
    await h.store.moveFeedToFolder(B, undefined)
    const stale = await h.dispatch('overview', { folder: '技术', cursor })
    assert.equal(stale.ok, false)
    assert.equal(stale.error.code, 'bad-request', '成员变动后旧游标必须失效，绝不允许静默重排')
  } finally { h.cleanup() }
})
