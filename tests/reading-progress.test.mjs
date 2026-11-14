/**
 * M5 02：已缓存正文的阅读进度。
 *
 * 三层各有各的判据，互不替代：
 *   ① 纯函数：比例 ↔ 位置的边界（内容不足一屏、越界、NaN）与**内容标识**的语义；
 *   ② 存储：进度按 (itemId, 内容标识) 存，版本对不上就当没有；条目删除/缓存淘汰要连带清掉；
 *   ③ 端点：article 回包里带内容标识与进度、saveReadingProgress 的边界与夹取。
 *
 * 为什么内容标识要单独测：它是**两条分支必须给出同一个值**的东西（缓存命中 vs 刚抓完），
 * 只挂抽取器修订号的话「同一修订号下正文变了」就识别不出来 —— 那正是本票要修的东西。
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
import { contentVersionOf, EXTRACTOR_REVISION } from '../lib/article.js'
import { clampReadingRatio } from '../lib/shared.js'
import { readingRatioOf, restoreTopFor } from '../lib/list-scroll.js'

const ROUND = '2026-10-11T09:00:00.000Z'
const FEED_ID = 'https://feed0.example.com/atom.xml'

/** 一套真实的库 + 一条带缓存的条目（正文 revision 用当前抽取器版本，才会命中缓存分支）。 */
function freshArticleStore(tag) {
  const dir = mkdtempSync(join(tmpdir(), 'rss-progress-' + tag + '-'))
  const configPath = join(dir, 'config.json')
  writeConfigFile(configPath, { version: 1, feeds: { [FEED_ID]: { url: FEED_ID, title: '源' } } })
  const db = openDatabase(':memory:')
  migrateSchema(db)
  const store = createSqliteStore(db, configPath)
  return { store, db, dir, configPath }
}

const cachedItem = (overrides = {}) => ({
  feedId: FEED_ID, title: '标题', link: 'https://site.example/a', fetchedAt: ROUND, starred: false,
  article: { fetchedAt: ROUND, revision: EXTRACTOR_REVISION, title: '正文标题', blocks: [{ kind: 'p', text: '正文' }] },
  ...overrides,
})

/* ============================ ① 纯函数 ============================ */

test('clampReadingRatio：只留 [0,1] 的有限数，认不出的一律当 0', () => {
  assert.equal(clampReadingRatio(0.42), 0.42)
  assert.equal(clampReadingRatio(0), 0)
  assert.equal(clampReadingRatio(-1), 0)
  assert.equal(clampReadingRatio(1.5), 1)
  assert.equal(clampReadingRatio(Number.NaN), 0)
  assert.equal(clampReadingRatio(Number.POSITIVE_INFINITY), 0)
  assert.equal(clampReadingRatio('0.5'), 0) // 字符串不是数：宁可回顶部，也不猜
  assert.equal(clampReadingRatio(undefined), 0)
})

test('readingRatioOf / restoreTopFor：内容不足一屏时为 0，越界一律夹住', () => {
  // 3000 高、300 视口 ⇒ 可滚 2700；滚到 1350 = 一半
  assert.equal(readingRatioOf(1350, 3000, 300), 0.5)
  assert.equal(readingRatioOf(0, 3000, 300), 0)
  assert.equal(readingRatioOf(9999, 3000, 300), 1, '滚过头也只记 1')
  assert.equal(readingRatioOf(10, 300, 300), 0, '内容不足一屏 ⇒ 没有「读到哪儿」')

  assert.equal(restoreTopFor(0.5, 3000, 300), 1350)
  assert.equal(restoreTopFor(0.5, 600, 300), 150, '恢复时内容更矮（图片还没进场）⇒ 按新的高度算')
  assert.equal(restoreTopFor(9, 3000, 300), 2700, '比例越界必须夹住（库是用户数据）')
  assert.equal(restoreTopFor(0.5, 200, 300), 0, '内容不足一屏 ⇒ 停在顶部，不许给负数')
  assert.equal(restoreTopFor(Number.NaN, 3000, 300), 0)
})

test('contentVersionOf：同一修订号下正文变了，标识也必须变', () => {
  const a = [{ kind: 'p', text: '甲' }]
  const b = [{ kind: 'p', text: '乙' }]
  assert.equal(contentVersionOf(3, a), contentVersionOf(3, a), '同一份内容必须给出同一个标识（否则进度永远恢复不了）')
  assert.notEqual(contentVersionOf(3, a), contentVersionOf(3, b), '同一修订号、不同正文 ⇒ 必须是两个版本')
  assert.notEqual(contentVersionOf(3, a), contentVersionOf(4, a), '抽取器升级 ⇒ 换一个版本')
  assert.ok(contentVersionOf(3, a).startsWith('3:'), '修订号要在标识里（便于排查「这份进度是哪一代抽取器写的」）')
  assert.equal(contentVersionOf(3, undefined), contentVersionOf(3, []), '没有块（老缓存）按空块算')
})

/* ============================ ② 存储 ============================ */

test('阅读进度：按 (itemId, 内容标识) 存读，版本对不上就当没有', async () => {
  const { store, db, dir } = freshArticleStore('roundtrip')
  try {
    await store.saveItem('a', cachedItem())
    assert.equal(store.readingProgress('a', '3:xxx'), undefined, '没记过 ⇒ 没有进度')

    await store.saveReadingProgress('a', '3:xxx', 0.42)
    assert.deepEqual(store.readingProgress('a', '3:xxx'), { ratio: 0.42 })
    // 正文换了（版本不同）⇒ 旧位置不许沿用
    assert.equal(store.readingProgress('a', '3:yyy'), undefined, '版本对不上必须当没有进度')
    assert.equal(store.readingProgress('b', '3:xxx'), undefined, '别的条目没有进度')
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('阅读进度：写入即夹取，条目不存在一律拒绝', async () => {
  const { store, db, dir } = freshArticleStore('clamp')
  try {
    await store.saveItem('a', cachedItem())
    await store.saveReadingProgress('a', 'v1', 1.7)
    assert.deepEqual(store.readingProgress('a', 'v1'), { ratio: 1 }, '库里的比例不能越界')
    await store.saveReadingProgress('a', 'v1', Number.NaN)
    assert.deepEqual(store.readingProgress('a', 'v1'), { ratio: 0 }, '认不出的比例按 0（回顶部），不编造')

    await assert.rejects(() => store.saveReadingProgress('ghost', 'v1', 0.5), /不在库里/,
      '写一次不等于创建：孤儿进度行没人读，还会在清理时变成谜团')
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('阅读进度：删条目连带删进度（两条路径都清）', async () => {
  const { store, db, dir } = freshArticleStore('delete')
  try {
    await store.saveItem('a', cachedItem())
    await store.saveItem('b', cachedItem())
    await store.saveReadingProgress('a', 'v1', 0.5)
    await store.saveReadingProgress('b', 'v1', 0.5)
    await store.deleteItem('a')
    assert.equal(store.readingProgress('a', 'v1'), undefined, '条目删了，进度必须一起走')
    // 缓存淘汰路径（refresh 的 capArticleCache 走它）：条目还在，进度清掉
    await store.clearReadingProgress('b')
    assert.deepEqual(store.readingProgress('b', 'v1'), undefined)
    assert.equal(store.item('b') !== undefined, true, '清进度不许动条目本身')
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('v2→v3 升级：只加 reading_progress 表，旧数据一行不动', async () => {
  // 造一个**真实 v2 库**：先建到当前版本，再摘掉 v3 那张表并把版本章退回 2 —— 形状与 M5 02 之前的库一致
  const dir = mkdtempSync(join(tmpdir(), 'rss-progress-v2-'))
  try {
    const db = openDatabase(join(dir, 'rss.db'))
    migrateSchema(db)
    db.exec('DROP TABLE reading_progress')
    db.exec('PRAGMA user_version = 2')
    db.prepare('INSERT INTO items (id, feed_id, title, link, fetched_at, starred) VALUES (?, ?, ?, ?, ?, 0)')
      .run('old-1', FEED_ID, '老条目', 'https://site.example/old', ROUND)
    db.close()

    const reopened = openDatabase(join(dir, 'rss.db'))
    try {
      migrateSchema(reopened)
      assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION)
      const row = reopened.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reading_progress'").get()
      assert.ok(row !== undefined, 'v3 的表必须补上')
      assert.equal(reopened.prepare('SELECT title FROM items WHERE id = ?').get('old-1').title, '老条目', '旧条目原样保留')
      migrateSchema(reopened) // 幂等
      assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION)
    } finally {
      reopened.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ============================ ③ 端点 ============================ */

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

test('article 端点：回包带内容标识与已存进度（命中缓存那条路径）', async () => {
  const { store, db, dir } = freshArticleStore('endpoint')
  try {
    await store.saveItem('a', cachedItem())
    const dispatch = makeDispatch(store)
    const version = contentVersionOf(EXTRACTOR_REVISION, cachedItem().article.blocks)

    const first = await dispatch('article', { itemId: 'a' })
    assert.equal(first.ok, true)
    assert.equal(first.value.contentVersion, version, '内容标识必须与块列表同源')
    assert.equal(first.value.progress, undefined, '没记过进度 ⇒ 不带这个字段（客户端据此从顶部开始）')

    const saved = await dispatch('saveReadingProgress', { itemId: 'a', contentVersion: version, ratio: 0.25 })
    assert.deepEqual(saved, { ok: true, value: { ratio: 0.25 } })

    const second = await dispatch('article', { itemId: 'a' })
    assert.equal(second.value.progress, 0.25, '再打开同一版缓存必须带回进度')
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('saveReadingProgress 端点：缺参数 / 未知条目响亮失败，比例越界被夹住', async () => {
  const { store, db, dir } = freshArticleStore('endpoint-bad')
  try {
    await store.saveItem('a', cachedItem())
    const dispatch = makeDispatch(store)

    const missing = await dispatch('saveReadingProgress', { itemId: 'a' })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'bad-request')

    const ghost = await dispatch('saveReadingProgress', { itemId: 'ghost', contentVersion: 'v1', ratio: 0.5 })
    assert.equal(ghost.ok, false)
    assert.equal(ghost.error.code, 'not-found')

    const clamped = await dispatch('saveReadingProgress', { itemId: 'a', contentVersion: 'v1', ratio: 5 })
    assert.deepEqual(clamped, { ok: true, value: { ratio: 1 } }, '越界在这里就夹住，别等读侧')
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})
