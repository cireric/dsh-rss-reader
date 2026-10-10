/**
 * 「详情页切换文章后已读状态丢失」的回归测试（2026-10-10 用户实测 → 控制器定位根因）。
 *
 * 病象（用户实测）：详情页用 j/k（或上一条/下一条按钮）逐篇读，列表里那些条目确实不再显示未读，
 * 但左栏角标与顶栏未读不下降，重新加载后又变回未读。
 *
 * 根因（源码核对 src/endpoints.ts）：客户端切文章时**同时**发两个请求（store.ts 的 loadArticle）——
 *   markRead(itemId)   先落盘（写好 readAt）
 *   article(itemId)    数秒后落盘
 * 而 article 端点在抓取**之前**取了 existing 快照（:189），抓完用 rebuildItem(existing, …) 整体重建记录
 * 写回（:229 / :217）⇒ markRead 刚写的 readAt 被那份旧快照覆盖掉 —— 丢失更新。
 * 实测旁证：同一批 7 次标记里，article 命中缓存（早退、不写盘）的 3 条 readAt 存活；
 * 首次抓取（真写盘）的 4 条 readAt 全部丢失。
 *
 * 本用例把生产里「网络抓取那几秒」的窗口**确定化**：让正文那一次写慢一拍
 * （生产窗口 = fetchArticle 的数秒；这里用可控延迟等价替代 —— 判据是「并发字段不许丢」，与调度无关）。
 * ⚠️ 覆盖的是**写入原语**这一处：成功路径与失败路径共用同一个合并原语（见 endpoints.ts），
 * 所以本用例同时守住两者；成功路径另有真机复验（用户在详情页逐篇读）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDispatch } from '../lib/endpoints.js'
import { Config } from '../lib/config.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 内存 ReaderStore（与 src/store.ts 同形）。
 * 「正文那一次写」故意慢一拍：生产里它要等网络（fetchArticle 数秒），这里用可控延迟等价复现，
 * 好让「写入窗口内发生并发写」这件事成为确定性调度而不是靠运气。
 */
function memoryStore({ articleWriteDelayMs = 120 } = {}) {
  const feeds = new Map()
  const items = new Map()
  const isArticleWrite = (record) => record.article !== undefined || record.articleFailure !== undefined
  return {
    feeds,
    items,
    feed: (id) => feeds.get(id),
    saveFeed: async (id, record) => { feeds.set(id, record) },
    cursor: () => undefined,
    saveCursor: async () => {},
    deleteFeed: async () => {},
    item: (id) => items.get(id),
    saveItem: async (id, record) => {
      if (isArticleWrite(record)) await sleep(articleWriteDelayMs)
      items.set(id, record)
    },
    // 原子读改写：fn 在**写入槽位**执行，看到的是当时的记录 —— 这正是修复依赖的语义
    updateItem: async (id, fn) => {
      await sleep(articleWriteDelayMs)
      items.set(id, fn(items.get(id)))
    },
    deleteItem: async (id) => { items.delete(id) },
    listItems: (feedId) => [...items.entries()].filter(([, record]) => record.feedId === feedId),
    allItems: () => [...items.entries()],
    listFeeds: () => [...feeds.entries()],
  }
}

/** 与 src/domain.ts 的 itemRecordSchema 同形；未读 = readAt 缺省。 */
function item(over = {}) {
  return {
    feedId: 'https://af.example/feed',
    title: '标题',
    // 指向一个必然抓取失败的地址：本用例要的是「正文那一次写」，与抓取成功与否无关
    link: 'http://127.0.0.1:1/never',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    starred: false,
    ...over,
  }
}

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

test('正文写入期间并发 markRead：readAt 不得被陈旧快照覆盖', async () => {
  const store = memoryStore()
  store.items.set('i1', item())
  const dispatch = createDispatch(deps(store, Config({})))

  // ① 发起正文抓取但**不等它**：此时端点已经取过 existing 快照，正在等网络
  const inFlight = dispatch('article', { itemId: 'i1' })
  await sleep(20)

  // ② 在这段窗口内标记已读（真机里是客户端并发发出的 markRead）
  const marked = await dispatch('markRead', { itemIds: ['i1'] })
  assert.equal(marked.ok, true, 'markRead 应当成功')
  assert.ok(store.item('i1').readAt, '前置条件：readAt 已写入')

  // ③ 正文那次写落盘
  await inFlight

  assert.ok(store.item('i1').readAt,
    '正文写回不得抹掉并发写入的 readAt —— 它必须把改动合并进**当前**记录，而不是用抓取前的旧快照整体覆盖（用户实测：详情页逐篇读，已读状态丢失）')
  assert.ok(store.item('i1').articleFailure !== undefined, '正文失败原因仍要留下（两边改动都要在）')
})