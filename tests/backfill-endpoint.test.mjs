/**
 * R9 02：`backfillHistory` 端点（payload 声明 / 失败映射 / 在途闸门 / 回包形状）。
 *
 * 编排语义在 backfill.test.mjs 里钉；这里只钉端点的三件事：
 *   ① 坏入参在触达 store 之前就被统一信封拒掉；
 *   ② 预期失败（not-found / conflict）回带 code 的失败信封，而不是 internal；
 *   ③ 成功回包就是 spec §4.8 的报告，且正文缓存让「打开条目」不再出网。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../lib/memory-store.js'
import { createDispatch } from '../lib/endpoints.js'
import { Config } from '../lib/config.js'
import { deriveItemId } from '../lib/feed/item-id.js'

const FEED_ID = 'https://feed.example.com/atom.xml'
const ARCHIVE_URL = 'https://feed.example.com/archives.html'
const SAMPLE_LINKS = [
  'https://feed.example.com/blog/2026/11/post-a.html',
  'https://feed.example.com/blog/2026/11/post-b.html',
  'https://feed.example.com/blog/2026/11/post-c.html',
]

function makeStore(withFeed = true) {
  const store = createMemoryStore()
  if (!withFeed) return store
  store.feeds.set(FEED_ID, { url: FEED_ID, title: '示例源' })
  for (const [index, link] of SAMPLE_LINKS.entries()) {
    store.items.set('seed-' + index, {
      feedId: FEED_ID,
      title: '已有 ' + index,
      link,
      publishedAt: '2026-11-01T00:00:00.000Z',
      fetchedAt: '2026-11-01T00:00:00.000Z',
      starred: false,
    })
  }
  return store
}

function archiveStub(links) {
  return async (url) => ({
    kind: 'ok',
    body: '<html><body>' + links.map((href) => '<a href="' + href + '">文章</a>').join('') + '</body></html>',
    finalUrl: url,
  })
}

function okArticle(title, publishedAt) {
  return { kind: 'ok', title, blocks: [{ kind: 'p', text: '正文' }], frameable: true, publishedAt }
}

function makeDispatch(store, overrides = {}) {
  return createDispatch({
    config: Config({ maxItemsPerFeed: 100, ...overrides.config }),
    log: () => {},
    ready: () => store,
    refreshNow: async () => ({ outcome: 'not-ready', attempted: 0, total: 0 }),
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
    ...(overrides.fetchImpl === undefined ? {} : { fetchImpl: overrides.fetchImpl }),
    ...(overrides.fetchArticleImpl === undefined ? {} : { fetchArticleImpl: overrides.fetchArticleImpl }),
  })
}

test('payload 非法：limit 0 / 51 / 非整数 / 非 URL / 非 http(s) 都回 bad-request，且不触达 handler', async () => {
  const store = makeStore(false)
  const dispatch = makeDispatch(store)
  const badSamples = [
    { feedId: FEED_ID, archiveUrl: ARCHIVE_URL, limit: 0 },
    { feedId: FEED_ID, archiveUrl: ARCHIVE_URL, limit: 51 },
    { feedId: FEED_ID, archiveUrl: ARCHIVE_URL, limit: 1.5 },
    { feedId: FEED_ID, archiveUrl: 'not a url' },
    { feedId: FEED_ID, archiveUrl: 'ftp://feed.example.com/archives' },
    {},
  ]
  for (const payload of badSamples) {
    const result = await dispatch('backfillHistory', payload)
    assert.equal(result.ok, false, JSON.stringify(payload) + ' 必须被拒')
    assert.equal(result.error.code, 'bad-request', JSON.stringify(payload) + ' 必须走统一坏入参信封')
    assert.match(result.error.message, /backfillHistory/)
  }
})

test('feed 不存在 ⇒ not-found（可读错误，不是 internal）', async () => {
  const store = makeStore(false)
  const dispatch = makeDispatch(store)
  const result = await dispatch('backfillHistory', { feedId: FEED_ID, archiveUrl: ARCHIVE_URL })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'not-found')
  assert.match(result.error.message, /订阅源不存在/)
})

test('成功回包：报告字段与 spec §4.8 逐项一致，limit 缺省 20 由声明层给出', async () => {
  const store = makeStore()
  const urls = [
    'https://feed.example.com/blog/2020/01/old-1.html',
    'https://feed.example.com/blog/2020/02/old-2.html',
  ]
  const dispatch = makeDispatch(store, {
    fetchImpl: archiveStub(urls),
    fetchArticleImpl: async (url) => okArticle('回溯 ' + url, '2020-01-01T00:00:00.000Z'),
  })

  const result = await dispatch('backfillHistory', { feedId: FEED_ID, archiveUrl: ARCHIVE_URL, limit: 2 })
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, {
    feedId: FEED_ID,
    archiveUrl: ARCHIVE_URL,
    sampleCount: 3,
    archiveLinks: 2,
    matched: 2,
    existing: 0,
    attempted: 2,
    added: 2,
    failures: [],
    remaining: 0,
  })
  // stoppedBy 只在真被卡住时出现；这里没有。
  assert.equal(Object.hasOwn(result.value, 'stoppedBy'), false)

  // 缺省 limit 是 20（spec §4.1）：形状声明本身的判据，不必真跑 20 篇。
  const parsed = (await import('../lib/endpoint-payloads.js')).backfillHistoryPayload
    .parse({ feedId: FEED_ID, archiveUrl: ARCHIVE_URL })
  assert.equal(parsed.limit, 20)
})

test('在途闸门：同一源第二次请求回 conflict；结束后可再次运行', async () => {
  const store = makeStore()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const inFlight = 'https://feed.example.com/blog/2020/01/slow.html'
  const dispatch = makeDispatch(store, {
    fetchImpl: archiveStub([inFlight]),
    fetchArticleImpl: async () => {
      await gate
      return okArticle('慢文章', '2020-01-01T00:00:00.000Z')
    },
  })

  const first = dispatch('backfillHistory', { feedId: FEED_ID, archiveUrl: ARCHIVE_URL, limit: 1 })
  // dispatch 同步执行到 handler 的第一个 await：此时在途闸门已经落下。
  const second = await dispatch('backfillHistory', { feedId: FEED_ID, archiveUrl: ARCHIVE_URL, limit: 1 })
  assert.equal(second.ok, false)
  assert.equal(second.error.code, 'conflict')
  assert.match(second.error.message, /已有回溯在进行/)

  release()
  const finished = await first
  assert.equal(finished.ok, true, '第一次运行必须正常完成')
  assert.equal(finished.value.added, 1)

  // finally 清理后，同一源可以再次发起（第二次的候选已被同文键挡住，但不应再回 conflict）。
  const again = await dispatch('backfillHistory', { feedId: FEED_ID, archiveUrl: ARCHIVE_URL, limit: 1 })
  assert.equal(again.ok, true, '在途闸门必须在 finally 里释放，否则一次失败会把源永久锁死')
  assert.equal(again.value.added, 0)
})

test('在途回溯期间 removeFeed 回 conflict（防孤儿条目）；结束后可以正常退订', async () => {
  const store = makeStore()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const url = 'https://feed.example.com/blog/2020/01/slow-remove.html'
  const dispatch = makeDispatch(store, {
    fetchImpl: archiveStub([url]),
    fetchArticleImpl: async () => {
      await gate
      return okArticle('慢文章', '2020-01-01T00:00:00.000Z')
    },
  })

  const running = dispatch('backfillHistory', { feedId: FEED_ID, archiveUrl: ARCHIVE_URL, limit: 1 })
  const rejected = await dispatch('removeFeed', { url: FEED_ID })
  assert.equal(rejected.ok, false, '回溯在途时退订必须被宿主拒绝，不能只靠界面置灰')
  assert.equal(rejected.error.code, 'conflict')
  assert.match(rejected.error.message, /回溯/)
  assert.ok(store.feed(FEED_ID) !== undefined, '被拒的退订不许动订阅')

  release()
  const finished = await running
  assert.equal(finished.ok, true)
  const removed = await dispatch('removeFeed', { url: FEED_ID })
  assert.equal(removed.ok, true, '回溯结束后同一源必须能退订')
  assert.equal(store.feed(FEED_ID), undefined)
})

test('正文已缓存：回溯后打开该条不再发网络请求', async () => {
  const store = makeStore()
  const url = 'https://feed.example.com/blog/2020/01/cached.html'
  const dispatch = makeDispatch(store, {
    fetchImpl: archiveStub([url]),
    fetchArticleImpl: async () => okArticle('缓存文章', '2020-01-01T00:00:00.000Z'),
  })
  const run = await dispatch('backfillHistory', { feedId: FEED_ID, archiveUrl: ARCHIVE_URL, limit: 1 })
  assert.equal(run.ok, true)

  const itemId = deriveItemId(FEED_ID, { link: url })
  const realFetch = globalThis.fetch
  globalThis.fetch = () => { throw new Error('正文已缓存，不该再出网') }
  try {
    const opened = await dispatch('article', { itemId })
    assert.equal(opened.ok, true)
    assert.equal(opened.value.cached, true, '回溯写入的正文缓存必须能被 article 端点直接命中')
    assert.equal(opened.value.title, '缓存文章')
  } finally {
    globalThis.fetch = realFetch
  }
})
