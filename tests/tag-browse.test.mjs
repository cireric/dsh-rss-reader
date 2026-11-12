/**
 * M2 06：标签浏览与标签搜索的宿主判据。
 *
 * 同一个陷阱在文件夹 03 已经踩过一次：先在跨源首页截断再在客户端按标签过滤，深页标签
 * 文章会消失。这里用 maxItemsShown=2 让「先筛后限页」与「先限页后筛」产生不同结果。
 * 游标必须绑标签 **id**（不是名称）：改名后旧游标仍能续页，删除/换标签才失配。
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
import { createSearch } from '../lib/search.js'
import { Config } from '../lib/config.js'

const A = 'https://tag-a.example/feed.xml'
const B = 'https://tag-b.example/feed.xml'
const C = 'https://tag-c.example/feed.xml'
const D = 'https://tag-d.example/feed.xml'

function makeDispatch() {
  const dir = mkdtempSync(join(tmpdir(), 'rss-tag-browse-'))
  const configPath = join(dir, 'config.json')
  writeConfigFile(configPath, {
    version: 1,
    feeds: {
      [A]: { url: A, title: 'A' },
      [B]: { url: B, title: 'B' },
      [C]: { url: C, title: 'C' },
      [D]: { url: D, title: 'D' },
    },
  })
  const db = openDatabase(join(dir, 'rss.db'))
  migrateSchema(db)
  const store = createSqliteStore(db, configPath)
  const insert = db.prepare(
    'INSERT INTO items (id, feed_id, title, link, published_at, fetched_at, starred)'
    + ' VALUES (?, ?, ?, ?, ?, ?, 0)',
  )
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
  for (const [id, feedId, at] of rows) insert.run(id, feedId, '标题 ' + id, 'https://site.example/' + id, at, at)
  const dispatch = createDispatch({
    config: Config({ maxItemsShown: 2 }),
    log: () => {},
    ready: () => store,
    refreshNow: async () => false,
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
  })
  return { dir, db, store, dispatch, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('标签浏览先按 id 筛选再限页：深页文章不漏，目录保留空标签', async () => {
  const h = makeDispatch()
  try {
    const t1 = await h.store.createTag('待读')
    const t2 = await h.store.createTag('参考')
    const empty = await h.store.createTag('空标签')
    await h.store.setItemTags('c3', [t1.id])
    await h.store.setItemTags('a1', [t1.id])
    await h.store.setItemTags('b1', [t1.id])
    await h.store.setItemTags('d1', [t1.id])
    await h.store.setItemTags('c2', [t2.id])

    const first = await h.dispatch('overview', { tagId: t1.id })
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.deepEqual(first.value.items.map((item) => item.id), ['c3', 'a1'], '第一页只含标签文章且按时间倒序')
    assert.deepEqual(first.value.items[0].tagIds, [t1.id], 'ItemView 带标签 id')
    assert.ok(first.value.nextCursor, '标签有 4 条，2 条一页应当有续页')
    assert.deepEqual(first.value.tags.map((tag) => [tag.name, tag.itemCount]).sort(), [['参考', 1], ['待读', 4], ['空标签', 0]], '目录含空标签与计数')

    const second = await h.dispatch('overview', { tagId: t1.id, cursor: first.value.nextCursor })
    assert.equal(second.ok, true, JSON.stringify(second))
    assert.deepEqual(second.value.items.map((item) => item.id), ['b1', 'd1'], '第二页仍是标签成员，没有 c2')
    assert.equal(second.value.nextCursor, undefined, '标签 4 条取完即到底')

    const emptyPage = await h.dispatch('overview', { tagId: empty.id })
    assert.equal(emptyPage.ok, true)
    assert.deepEqual(emptyPage.value.items, [], '空标签不查全表')
    assert.equal(emptyPage.value.nextCursor, undefined)

    const missing = await h.dispatch('overview', { tagId: 'missing' })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'not-found', '删除/不存在标签明确 not-found')

    // 改名只换显示名：范围键是 id，旧游标继续有效。
    await h.store.renameTag(t1.id, '待读改名')
    const afterRename = await h.dispatch('overview', { tagId: t1.id, cursor: first.value.nextCursor })
    assert.equal(afterRename.ok, true, JSON.stringify(afterRename))
    assert.deepEqual(afterRename.value.items.map((item) => item.id), ['b1', 'd1'], '改名后旧游标仍绑定同一 id')
    assert.equal(afterRename.value.tags.find((tag) => tag.id === t1.id).name, '待读改名')
  } finally { h.cleanup() }
})

test('标签游标绑定 id：无范围或别的标签游标都 bad-request', async () => {
  const h = makeDispatch()
  try {
    const t1 = await h.store.createTag('甲')
    const t2 = await h.store.createTag('乙')
    await h.store.setItemTags('c3', [t1.id])
    await h.store.setItemTags('a1', [t1.id])
    await h.store.setItemTags('b1', [t1.id])
    await h.store.setItemTags('d1', [t1.id])
    const first = await h.dispatch('overview', { tagId: t1.id })
    assert.equal(typeof first.value.nextCursor, 'string')
    const unscoped = await h.dispatch('overview', { cursor: first.value.nextCursor })
    assert.equal(unscoped.ok, false)
    assert.equal(unscoped.error.code, 'bad-request')
    const otherTag = await h.dispatch('overview', { tagId: t2.id, cursor: first.value.nextCursor })
    assert.equal(otherTag.ok, false)
    assert.equal(otherTag.error.code, 'bad-request')
    const both = await h.dispatch('overview', { folder: '任意', tagId: t1.id })
    assert.equal(both.ok, false)
    assert.equal(both.error.code, 'bad-request', '文件夹与标签范围不能同时给')
  } finally { h.cleanup() }
})

test('搜索 + 标签 + 未读取交集，搜索结果也带 tagIds', async () => {
  const h = makeDispatch()
  try {
    // 换可搜索标题并造 read/unread 组合：alpha 1/2/3，t1 只挂 1/2，1 已读、2 未读。
    const db = h.db
    db.prepare("UPDATE items SET title = 'alpha one', read_at = '2026-10-12T01:00:00.000Z' WHERE id = 'c3'").run()
    db.prepare("UPDATE items SET title = 'alpha two', starred = 1, published_at = '2026-10-09T00:00:00.000Z' WHERE id = 'a1'").run()
    db.prepare("UPDATE items SET title = 'alpha three' WHERE id = 'b1'").run()
    const t1 = await h.store.createTag('待读')
    await h.store.setItemTags('c3', [t1.id])
    await h.store.setItemTags('a1', [t1.id])
    const search = createSearch(join(h.dir, 'rss.db'))
    try {
      const page = await search.run({ text: 'alpha', tagId: t1.id, read: 'unread' }, [[A, 'A'], [B, 'B'], [C, 'C'], [D, 'D']], 30)
      assert.deepEqual(page.items.map((item) => item.id), ['a1'], '标签 + 未读取交集')
      assert.deepEqual(page.items[0].tagIds, [t1.id], '搜索结果带标签 id')
      const all = await search.run({ text: 'alpha', read: 'unread' }, [[A, 'A'], [B, 'B'], [C, 'C'], [D, 'D']], 30)
      assert.deepEqual(all.items.map((item) => item.id).sort(), ['a1', 'b1'], '无标签时未读 alpha 有两条')

      // 标签还必须与来源、星标、日期取交集；这里把 a1 标星并钉在 10-09，验证条件同时生效。
      const combined = await search.run({
        text: 'alpha', tagId: t1.id, starred: true, from: '2026-10-09', to: '2026-10-09',
      }, [[A, 'A'], [B, 'B'], [C, 'C'], [D, 'D']], 30)
      assert.deepEqual(combined.items.map((item) => item.id), ['a1'], '标签 + 星标 + 日期交集')
      // Worker 的 feeds 参数就是端点按来源筛选后的标题表；直接驱动 worker 时用它表达来源范围。
      const feedA = await search.run({ text: 'alpha', tagId: t1.id }, [[A, 'A']], 30)
      assert.deepEqual(feedA.items.map((item) => item.id), ['a1'], '标签 + 来源交集')
      const feedB = await search.run({ text: 'alpha', tagId: t1.id }, [[B, 'B']], 30)
      assert.deepEqual(feedB.items, [], '标签成员不在 B 源时交集为空')
    } finally { await search.close() }
  } finally { h.cleanup() }
})
