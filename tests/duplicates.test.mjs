/**
 * M5 03：跨源重复提示的判据。
 *
 * 三条来自票据的边界，各有各的用例，**互不替代**：
 *   ① 同源条目不算（那是 identity-repair 的活）；
 *   ② 缺链接不算（空链接会把不相干的文章连成一组）；
 *   ③ 仅标题相同不算（标题相似是线索，不是同一份原文的证据）。
 * 另外两条是工程约束：跨页也要能找到别的来源；单源已读/星标不影响其他源。
 *
 * 归一化的每个边界都配一条**可追溯样本**（下面的表就是这个规则的说明书）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase, migrateSchema, SCHEMA_VERSION } from '../lib/storage/db.js'
import { createSqliteStore } from '../lib/store-sqlite.js'
import { writeConfigFile } from '../lib/storage/config-file.js'
import { createDispatch } from '../lib/endpoints.js'
import { Config } from '../lib/config.js'
import { duplicateHintsOf, linkKeyOf } from '../lib/duplicates.js'

const ROUND = '2026-10-11T09:00:00.000Z'
const FEED_A = 'https://a.example/feed.xml'
const FEED_B = 'https://b.example/feed.xml'

/* ============================ ① 归一化样本 ============================ */

test('linkKeyOf：归一化的每一个边界都有一条固定样本（改规则必须同时改这张表）', () => {
  const same = [
    ['https://example.com/a', 'https://example.com/a', '原样'],
    ['https://example.com/a/', 'https://example.com/a', '末尾斜杠'],
    ['https://example.com/a#section-2', 'https://example.com/a', '锚点（同一篇）'],
    ['https://example.com/a?utm_source=weibo&utm_medium=social', 'https://example.com/a', 'utm_* 全丢'],
    ['https://example.com/a?b=1&a=2', 'https://example.com/a?a=2&b=1', '参数顺序无关'],
    ['  https://example.com/a  ', 'https://example.com/a', '两端空白'],
    ['https://EXAMPLE.com/a', 'https://example.com/a', '主机大小写（URL 规范）'],
    ['https://example.com:443/a', 'https://example.com/a', '默认端口'],
    ['https://example.com/a?fbclid=xyz&spm=1.2', 'https://example.com/a', '分享追踪参数'],
  ]
  for (const [input, expected, why] of same) {
    assert.equal(linkKeyOf(input), expected, why + '：' + input)
  }
  const different = [
    ['https://example.com/a', 'http://example.com/a', 'http 与 https 视为不同（更激进的归并要等样本）'],
    ['https://example.com/A', 'https://example.com/a', '路径大小写是两篇文章（真实站点很常见）'],
    ['https://www.example.com/a', 'https://example.com/a', '不去 www（保守）'],
    ['https://example.com/a?id=1', 'https://example.com/a?id=2', '查询参数有语义（?p=123 常常就是文章 id）'],
    ['https://example.com/a', 'https://example.com/b', '路径不同'],
  ]
  for (const [a, b, why] of different) {
    assert.notEqual(linkKeyOf(a), linkKeyOf(b), why)
  }
  // 不参与判定的一律给空串：空、纯空白、非 http(s)、解析不出
  for (const bad of ['', '   ', 'javascript:alert(1)', 'mailto:x@example.com', 'not a url', '/relative/path']) {
    assert.equal(linkKeyOf(bad), '', '不参与判定：' + JSON.stringify(bad))
  }
})

/* ============================ ② 分组规则 ============================ */

const row = (over = {}) => ({ id: 'x', feedId: FEED_A, title: '标题', link: 'https://example.com/a', ...over })

test('duplicateHintsOf：跨源同链接才算；同源、缺链接、仅标题相同都不算', () => {
  const visible = [row({ id: 'a1' })]
  // 跨源同链接（带追踪参数）⇒ 算
  assert.deepEqual(
    duplicateHintsOf(visible, [row({ id: 'a1' }), row({ id: 'b1', feedId: FEED_B, link: 'https://example.com/a/?utm_source=x' })]),
    [{ itemId: 'a1', others: [{ itemId: 'b1', feedId: FEED_B, title: '标题', link: 'https://example.com/a/?utm_source=x' }] }])

  // 同源 ⇒ 不算（identity-repair 的地盘）
  assert.deepEqual(duplicateHintsOf(visible, [row({ id: 'a1' }), row({ id: 'a2' })]), [])

  // 缺链接 ⇒ 不算（空链接会把不相干的文章连成一组）
  assert.deepEqual(
    duplicateHintsOf([row({ id: 'a1', link: '' })], [row({ id: 'a1', link: '' }), row({ id: 'b1', feedId: FEED_B, link: '' })]),
    [])

  // 仅标题相同 ⇒ 不算（链接不同就是不同原文）
  assert.deepEqual(
    duplicateHintsOf(visible, [row({ id: 'a1' }), row({ id: 'b1', feedId: FEED_B, link: 'https://example.com/other', title: '标题' })]),
    [])
})

test('duplicateHintsOf：同一组里有多个别的源时全部列出，且不把自己算进去', () => {
  const hints = duplicateHintsOf(
    [row({ id: 'a1' })],
    [row({ id: 'a1' }), row({ id: 'b1', feedId: FEED_B }), row({ id: 'c1', feedId: 'https://c.example/feed.xml' })],
  )
  assert.equal(hints.length, 1)
  assert.deepEqual(hints[0].others.map((other) => other.itemId).sort(), ['b1', 'c1'])
})

/* ============================ ③ 存储：派生列 ============================ */

function freshStore(tag) {
  const dir = mkdtempSync(join(tmpdir(), 'rss-dupes-' + tag + '-'))
  const configPath = join(dir, 'config.json')
  writeConfigFile(configPath, { version: 1, feeds: { [FEED_A]: { url: FEED_A, title: '源 A' }, [FEED_B]: { url: FEED_B, title: '源 B' } } })
  const db = openDatabase(':memory:')
  migrateSchema(db)
  return { store: createSqliteStore(db, configPath), db, dir, configPath }
}

const item = (id, feedId, link, over = {}) => ({ feedId, title: '标题 ' + id, link, fetchedAt: ROUND, starred: false, ...over })

test('itemsByLinkKeys：写入时就落 link_key，批量查按它走', async () => {
  const { store, db, dir } = freshStore('store')
  try {
    await store.saveItem('a1', item('a1', FEED_A, 'https://example.com/a?utm_source=weibo'))
    await store.saveItem('b1', item('b1', FEED_B, 'https://example.com/a/#top'))
    await store.saveItem('c1', item('c1', FEED_A, 'https://example.com/c'))
    const found = store.itemsByLinkKeys([linkKeyOf('https://example.com/a')])
    assert.deepEqual(found.map((r) => r.id).sort(), ['a1', 'b1'], '同一个链接键的两条都要命中（跨源）')
    assert.deepEqual(store.itemsByLinkKeys([]), [], '空键集不发查询')
    assert.deepEqual(store.itemsByLinkKeys(['']), [], '空串不是键')
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('v2→v4 升级：只加表与派生列，旧数据一行不动、link_key 回填到位（M5 03 的派生列）', async () => {
  // 造一个**真实 v2 库**：先建到当前版本，再把 v3/v4 加的东西拆掉、版本章退回 2 ——
  // 形状与 M5 02 之前的库一致（少 reading_progress 表、items 少 link_key 列）。
  const dir = mkdtempSync(join(tmpdir(), 'rss-progress-v2-'))
  try {
    const db = openDatabase(join(dir, 'rss.db'))
    migrateSchema(db)
    db.exec('DROP TABLE reading_progress')
    db.exec('DROP INDEX i3')
    db.exec('ALTER TABLE items DROP COLUMN link_key')
    db.exec('PRAGMA user_version = 2')
    db.prepare('INSERT INTO items (id, feed_id, title, link, fetched_at, starred) VALUES (?, ?, ?, ?, ?, 0)')
      .run('old-1', FEED_A, '老条目', 'https://site.example/old?utm_source=x#top', ROUND)
    db.close()

    const reopened = openDatabase(join(dir, 'rss.db'))
    try {
      migrateSchema(reopened)
      assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION)
      const row = reopened.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reading_progress'").get()
      assert.ok(row !== undefined, 'v3 的进度表必须补上')
      assert.equal(reopened.prepare('SELECT title FROM items WHERE id = ?').get('old-1').title, '老条目', '旧条目原样保留')
      // v4 的派生列必须**在同一事务里回填**：空值意味着跨源提示对老条目静默失效
      assert.equal(reopened.prepare('SELECT link_key FROM items WHERE id = ?').get('old-1').link_key,
        'https://site.example/old', 'link_key 必须是归一化之后的键（去掉 utm/fragment）')
      migrateSchema(reopened) // 幂等
      assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION)
    } finally {
      reopened.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ============================ ④ 端点：跨页 + 不串状态 ============================ */

function makeDispatch(store) {
  return createDispatch({
    config: Config({}),
    log: () => {},
    ready: () => store,
    refreshNow: async () => ({ outcome: 'not-ready', attempted: 0, total: 0 }),
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
  })
}

test('duplicateHints 端点：候选来自别的页、别的源；同源那条不报；读/星标互不影响', async () => {
  const { store, db, dir } = freshStore('endpoint')
  try {
    // a1 在「第一页」，b1 在「第二页」（fetchedAt 更早），c1 与 a1 同源
    await store.saveItem('a1', item('a1', FEED_A, 'https://example.com/a'))
    await store.saveItem('b1', item('b1', FEED_B, 'https://example.com/a/?utm_source=x', { fetchedAt: '2026-10-01T00:00:00.000Z' }))
    await store.saveItem('c1', item('c1', FEED_A, 'https://example.com/a#dup'))
    const dispatch = makeDispatch(store)

    const result = await dispatch('duplicateHints', { itemIds: ['a1'] })
    assert.equal(result.ok, true)
    assert.equal(result.value.hints.length, 1, 'a1 应当有提示')
    assert.deepEqual(result.value.hints[0].others.map((other) => other.itemId), ['b1'],
      '同源的 c1 不算；b1 虽然不在这一页，也必须被找到（跨页验收）')
    assert.equal(result.value.hints[0].others[0].feedTitle, '源 B', '源标题由宿主补，客户端不必再查订阅表')

    // 单源已读/星标不影响其他源：只动 a1，b1 的记录与未读账原样
    await store.updateItem('a1', (current) => ({ ...current, readAt: ROUND, starred: true }))
    const after = await dispatch('duplicateHints', { itemIds: ['b1'] })
    assert.equal(after.value.hints[0].others[0].itemId, 'a1', '反向提示仍在（提示是双向的，不改任何状态）')
    const b1 = store.item('b1')
    assert.equal(b1.readAt, undefined, 'a1 标读不该把 b1 也标读')
    assert.equal(b1.starred, false, 'a1 加星不该把 b1 也加星')
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('duplicateHints 端点：空入参、未知 id、超长入参都不炸', async () => {
  const { store, db, dir } = freshStore('endpoint-bad')
  try {
    const dispatch = makeDispatch(store)
    assert.deepEqual(await dispatch('duplicateHints', {}), { ok: true, value: { hints: [] } })
    assert.deepEqual(await dispatch('duplicateHints', { itemIds: ['ghost'] }), { ok: true, value: { hints: [] } })
    const many = Array.from({ length: 300 }, (_, index) => 'ghost-' + index)
    assert.deepEqual(await dispatch('duplicateHints', { itemIds: many }), { ok: true, value: { hints: [] } },
      '超过 200 条只截断，不报错（提示是附加信息，不该让面板红一次）')
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})
