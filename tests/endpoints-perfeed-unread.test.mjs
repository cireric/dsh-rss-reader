/**
 * per-feed 未读数（Overview.perFeedUnread）的契约测试（2026-10 两列布局任务 1）。
 *
 * 为什么必须存在：overview 下发的 items 被 maxItemsShown 截断（默认 300），而顶栏总未读 unread
 * 是按**全量** items 算的（buildOverview 里 items 先 slice 截断、unread 后按全量计）。客户端拿不到
 * 截断之外的条目，所以每源未读数
 * 不可能由浏览器半从 items 派生 —— 只能由宿主在同一次全表遍历里累加。
 *
 * 三条断言钉的是**守恒与边界**，不是实现细节：
 *   ① 各源之和 === 顶栏总未读（下游左栏角标赖以成立的守恒式）
 *   ② 条目数超过 maxItemsShown 时仍按全量统计（不跟随 items 截断）
 *   ③ 键域严格 = feeds 表：已退订源的残留条目不进 map，在订的源一个键都不能少
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { articleCharsOf } from '../lib/retention.js'
import { createDispatch } from '../lib/endpoints.js'
import { Config } from '../lib/config.js'

/** 与 src/store.ts 的 ReaderStore 同形的内存实现（本文件只用到 listFeeds / allItems）。 */
function memoryStore() {
  const feeds = new Map()
  const items = new Map()
  return {
    feeds,
    items,
    feed: (id) => feeds.get(id),
    saveFeed: async (id, record) => { feeds.set(id, record) },
    cursor: () => undefined,
    saveCursor: async () => {},
    deleteFeed: async (feedId) => { feeds.delete(feedId) },
    item: (id) => items.get(id),
    saveItem: async (id, record) => { items.set(id, record) },
    // 原子读改写（ReaderStore 契约的一部分）：fn 在写入槽位看到当前记录，见 src/store.ts 的注释
    updateItem: async (id, fn) => { items.set(id, fn(items.get(id))) },
    deleteItem: async (id) => { items.delete(id) },
    listItems: (feedId) => [...items.entries()].filter(([, record]) => record.feedId === feedId),
    allItems: () => [...items.entries()],
    listFeeds: () => [...feeds.entries()],
    /**
     * 与自持实现同形（Task 5 的三条 SQL 取数方法）。
     *
     * 桩也必须守**同一条契约**：unreadPerFeed 先按传进来的键铺 0（0 未读的源留键）、
    listCleanupCandidates 把 SQL 谓词多守的「保持未读不删」一并实现 —— 桩与实现各写一套
    语义，测出来的就只是桩的理解（docs/pitfalls.md 二、2.5 / 2.6）。
     */
    unreadPerFeed: (feedIds) => {
      const unread = {}
      for (const feedId of feedIds) unread[feedId] = 0
      for (const record of items.values()) {
        if (unread[record.feedId] === undefined || record.readAt !== undefined) continue
        unread[record.feedId] += 1
      }
      return unread
    },
    listRecent: (limit) => {
      if (limit <= 0) return []
      const rows = [...items.entries()]
      rows.sort(([idA, a], [idB, b]) => {
        const byTime = (b.publishedAt ?? b.fetchedAt).localeCompare(a.publishedAt ?? a.fetchedAt)
        return byTime !== 0 ? byTime : idA.localeCompare(idB)
      })
      return rows.slice(0, limit)
    },
    listCleanupCandidates: (cutoffIso) => {
      const rows = []
      for (const [id, record] of items.entries()) {
        const recency = record.publishedAt ?? record.fetchedAt
        // 判据 = retention.ts 的 selectCleanup（已读 + 未星标 + 早于阈值）另加「保持未读」保护
        if (record.readAt === undefined || record.starred || record.keptUnread === true) continue
        if (recency >= cutoffIso) continue
        rows.push({
          id,
          starred: false,
          kept: false,
          read: true,
          recency,
          articleChars: articleCharsOf(record.article),
          summaryChars: record.summary?.length ?? 0,
        })
      }
      return rows
    },
  }
}

/** 与 src/domain.ts 的 itemRecordSchema 同形；未读 = readAt 缺省。 */
function item(feedId, over = {}) {
  return {
    feedId,
    title: '标题',
    link: 'https://example.com/' + feedId,
    publishedAt: '2026-01-01T00:00:00.000Z',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    starred: false,
    ...over,
  }
}

const READ = '2026-01-02T00:00:00.000Z'

/** EndpointDeps 的桩（形状照 src/endpoints.ts:18-30，不增减字段）。 */
function deps(store, config) {
  return {
    config,
    log: () => {},
    ready: () => store,
    refreshNow: async () => false,
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
  }
}

/** 取一次 overview；顺手断言信封是成功的，免得失败被当成空数据糊过去。 */
async function overview(store, config) {
  const dispatch = createDispatch(deps(store, config))
  const result = await dispatch('overview', {})
  assert.equal(result.ok, true, 'overview 应当成功')
  return result.value
}

test('perFeedUnread：各源未读数之和 === 顶栏总未读', async () => {
  const store = memoryStore()
  store.feeds.set('https://a.example/feed', { url: 'https://a.example/feed', title: 'A' })
  store.feeds.set('https://b.example/feed', { url: 'https://b.example/feed', title: 'B' })
  store.feeds.set('https://c.example/feed', { url: 'https://c.example/feed', title: 'C' })
  // 已知分布：A 3 条 2 未读 / B 2 条 0 未读 / C 4 条 3 未读 ⇒ 合计 5
  store.items.set('a1', item('https://a.example/feed'))
  store.items.set('a2', item('https://a.example/feed'))
  store.items.set('a3', item('https://a.example/feed', { readAt: READ }))
  store.items.set('b1', item('https://b.example/feed', { readAt: READ }))
  store.items.set('b2', item('https://b.example/feed', { readAt: READ }))
  store.items.set('c1', item('https://c.example/feed'))
  store.items.set('c2', item('https://c.example/feed'))
  store.items.set('c3', item('https://c.example/feed'))
  store.items.set('c4', item('https://c.example/feed', { readAt: READ }))

  const view = await overview(store, Config({}))

  assert.deepEqual(view.perFeedUnread, {
    'https://a.example/feed': 2,
    'https://b.example/feed': 0,
    'https://c.example/feed': 3,
  })
  assert.equal(view.unread, 5)
  const sum = Object.values(view.perFeedUnread).reduce((acc, n) => acc + n, 0)
  assert.equal(sum, view.unread, '各源未读之和必须等于顶栏总未读（左栏角标的守恒式）')
})

test('perFeedUnread：条目数超过 maxItemsShown 时仍按全量统计（不跟随 items 截断）', async () => {
  const store = memoryStore()
  store.feeds.set('https://a.example/feed', { url: 'https://a.example/feed', title: 'A' })
  const TOTAL = 12
  for (let i = 0; i < TOTAL; i += 1) {
    store.items.set('a' + i, item('https://a.example/feed', { publishedAt: '2026-01-01T00:00:' + String(i).padStart(2, '0') + '.000Z' }))
  }

  const view = await overview(store, Config({ maxItemsShown: 5 }))

  // 先确认截断真的发生了，否则这条测试等于什么都没量
  assert.equal(view.items.length, 5, 'items 应被 maxItemsShown 截断')
  assert.equal(view.perFeedUnread['https://a.example/feed'], TOTAL, '每源未读必须按全量统计')
  assert.equal(view.unread, TOTAL)
})

test('已退订源的残留条目：既不进账目，也不许把列表的截断窗口占掉（退订后没清干净 / 手工改库）', async () => {
  const store = memoryStore()
  store.feeds.set('https://a.example/feed', { url: 'https://a.example/feed', title: 'A' })
  // 残留条目刻意排在**最前面**（recency 最新）：它们会先被取回来，再因为「所属源已退订」被挡掉。
  // 不把窗口放大重取的话，右栏就会少几条 —— 而用户完全看不出原因（原实现是先滤后截，不会少）。
  for (let i = 0; i < 4; i += 1) {
    store.items.set('x' + i, item('https://x.example/feed', { publishedAt: '2026-12-0' + (i + 1) + 'T00:00:00.000Z' }))
  }
  for (let i = 0; i < 6; i += 1) {
    store.items.set('a' + i, item('https://a.example/feed', { publishedAt: '2026-01-0' + (i + 1) + 'T00:00:00.000Z' }))
  }

  const view = await overview(store, Config({ maxItemsShown: 5 }))

  assert.equal(view.items.length, 5, '残留行占掉的窗口必须被补回来（否则右栏静默少几条）')
  assert.equal(view.items.every((entry) => entry.feedId === 'https://a.example/feed'), true,
    '残留条目一条都不许出现在列表里')
  assert.equal(view.unread, 6, '账目同样只算在订源')
})

test('perFeedUnread：已退订源（items 里还剩条目）不出现在 map 里', async () => {
  const store = memoryStore()
  store.feeds.set('https://a.example/feed', { url: 'https://a.example/feed', title: 'A' })
  // B 在订但已全部读完：它是「0 值键必须存在」这一半的探针。没有它，下面的键集断言挡不住
  // 「只给未读 > 0 的源发键」这种实现 —— 那正是本条要防的键域漂移。
  store.feeds.set('https://b.example/feed', { url: 'https://b.example/feed', title: 'B' })
  // 只剩 A / B 在订阅表里；X 的条目还没被清掉（退订后残留 / 手工改库的情形）
  store.items.set('a1', item('https://a.example/feed'))
  store.items.set('b1', item('https://b.example/feed', { readAt: READ }))
  store.items.set('x1', item('https://x.example/feed'))
  store.items.set('x2', item('https://x.example/feed'))

  const view = await overview(store, Config({}))

  assert.equal(view.perFeedUnread['https://a.example/feed'], 1)
  assert.equal(view.perFeedUnread['https://b.example/feed'], 0, '在订但已读完的源也要有键，值为 0')
  assert.equal(Object.prototype.hasOwnProperty.call(view.perFeedUnread, 'https://x.example/feed'), false,
    '已退订源不该出现在 perFeedUnread 里')
  // 键集全等，而不只是「X 不在里面」：只断言缺键的话，若实现改成「只给未读 > 0 的源发键」
  // （省略 0 值键）照样通过，而那时键域已经漂了。左栏按 feeds 表逐行渲染，键域漂移的表现是
  // 「角标空白」而不是报错，所以必须在这里钉死「键域 = feeds 表」这一条 Record decision。
  assert.deepEqual(Object.keys(view.perFeedUnread).sort(),
    ['https://a.example/feed', 'https://b.example/feed'],
    '键集必须全等于 feeds 表（不多键也不少键）')
  assert.equal(view.unread, 1, '总未读同样只算在订阅表里的源')
})
