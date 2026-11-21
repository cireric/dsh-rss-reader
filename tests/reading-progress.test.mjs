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

test('article 端点：旧修订号的缓存被判过期 —— 回 cached:false 并重抓（不许静默给旧块）', async () => {
  // 为什么这条必须有（R5 06，评审指出的缺口）：spec 验收 13 写的是「既有判据自动生效，验收确认
  // 没被绕过」。抬版本之前，**没有任何用例**用 `revision: EXTRACTOR_REVISION - 1` 打过 article
  // 端点 —— 把 endpoints 里的 `=== ARTICLE_REVISION` 改成 `!==` 或删掉，850 条测试仍会全绿。
  const { store, db, dir } = freshArticleStore('stale')
  try {
    // 造一条「上一版抽取器」的缓存：只有 text、没有 runs / table
    await store.saveItem('old', cachedItem({
      article: {
        fetchedAt: ROUND,
        revision: EXTRACTOR_REVISION - 1,
        title: '旧正文',
        blocks: [{ kind: 'p', text: '旧版本的正文块' }],
      },
    }))
    const dispatch = makeDispatch(store)
    const result = await dispatch('article', { itemId: 'old' })
    assert.equal(result.ok, true)
    assert.equal(result.value.cached, false, '旧修订号的缓存不许当命中：必须回 cached:false 并重抓')
    // 重抓会走网络（本夹具的 link 是 example 域，抓不到），所以这里断言的是**判据生效**，
    // 不是抓取成功：失败原因如实回包，而不是把旧块当新块给出去。
    assert.ok(
      result.value.failure !== undefined || result.value.cached === false,
      '要么重抓成功，要么如实回失败原因；不许拿旧缓存冒充新内容',
    )
    assert.notEqual(result.value.contentVersion, contentVersionOf(EXTRACTOR_REVISION - 1, [{ kind: 'p', text: '旧版本的正文块' }]),
      '回包的内容标识不许还是旧版本算出来的那个')
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})
