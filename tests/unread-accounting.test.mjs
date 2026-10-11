/**
 * 未读账目守恒的**时间维度**契约测试（2026-10 两列布局任务 5）。
 *
 * 为什么另起一个文件而不并进 endpoints-perfeed-unread.test.mjs：那边钉的是 overview **单次快照**
 * 上的守恒 / 截断 / 键域三条静态断言（什么都没动时的静止状态）。本文件补的是它结构上够不到的面：
 *
 *   ① **标已读之后**账目还守不守恒（既有三条全在"静止"状态，时间维度零覆盖）；
 *   ② markRead 的返回值走 endpoints.ts 的 countUnread、overview 的计数走 buildOverview 的全表遍历
 *      —— 两处计数分居两个函数，各自自洽但互相漂移时，单快照断言永远看不见，所以必须跨端点对账；
 *   ③ 客户端 store 落地之后（markRead / markAllRead / undoMarkAll）同一条守恒式是否成立：
 *      左栏角标读 state.perFeedUnread、顶栏总数读 state.unread，二者之和是界面上的一处守恒式，
 *      只动一边就会出现「角标还是 2、顶栏已经 1」的自相矛盾。
 *
 * 断言钉不变量与账目口径，不钉实现细节。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { articleCharsOf } from '../lib/retention.js'
import { createDispatch } from '../lib/endpoints.js'
import { Config } from '../lib/config.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(ROOT, 'lib', 'client.js')

/* ------------------------------------------------------------------ host 半 */

/**
 * 与 src/store.ts 的 ReaderStore 同形的最小内存实现。
 *
 * 刻意不 import 既有文件的夹具（那两个文件没导出）：为一个共享桩去改任务 1 的文件，
 * 风险大于这点重复；夹具不是断言，重复它不构成"重抄断言"。
 */
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

/** 调一次端点并断言信封成功——失败被当成空数据糊过去正是这类测试最容易的假绿。 */
async function callEndpoint(store, endpoint, payload, config = Config({})) {
  const dispatch = createDispatch(deps(store, config))
  const result = await dispatch(endpoint, payload)
  assert.equal(result.ok, true, endpoint + ' 应当成功')
  return result.value
}

const overview = (store, config) => callEndpoint(store, 'overview', {}, config)

/** 守恒式的左边：各源未读之和。 */
const sumUnread = (map) => Object.values(map).reduce((acc, n) => acc + n, 0)

test('标一条已读之后：该源角标与总未读同步 -1，守恒式仍成立', async () => {
  const store = memoryStore()
  store.feeds.set('A', { url: 'A', title: 'A' })
  store.feeds.set('B', { url: 'B', title: 'B' })
  store.items.set('a1', item('A'))
  store.items.set('a2', item('A'))
  store.items.set('ae', item('A', { readAt: READ }))
  store.items.set('b1', item('B'))

  const before = await overview(store)
  // 先把起点钉死：不确认起点，"减 1"可能只是从一个错的基数上算出来的巧合
  assert.equal(before.unread, 3, '前置条件：起点是 3 未读')
  assert.equal(before.perFeedUnread.A, 2)

  const marked = await callEndpoint(store, 'markRead', { itemIds: ['a1'] })
  assert.equal(marked.changed, 1, '前置条件：标记真的落库了')

  const after = await overview(store)
  assert.equal(after.perFeedUnread.A, before.perFeedUnread.A - 1,
    '被标的那条所属源的角标要减 1')
  assert.equal(after.perFeedUnread.B, before.perFeedUnread.B, '没被标的源角标纹丝不动')
  assert.equal(after.unread, before.unread - 1)
  assert.equal(sumUnread(after.perFeedUnread), after.unread,
    '守恒式必须在用户操作之后仍成立——既有断言只测过静止状态')
})

test('某源全部标已读后：角标归 0 但键仍在（键域 = feeds 表），守恒式仍成立', async () => {
  const store = memoryStore()
  store.feeds.set('A', { url: 'A', title: 'A' })
  store.feeds.set('B', { url: 'B', title: 'B' })
  store.items.set('a1', item('A'))
  store.items.set('a2', item('A'))
  store.items.set('b1', item('B'))

  const marked = await callEndpoint(store, 'markRead', { itemIds: ['a1', 'a2'] })
  assert.equal(marked.changed, 2, '前置条件：两条都标上了')

  const view = await overview(store)
  assert.equal(view.perFeedUnread.A, 0, '标空之后角标是 0，而不是缺键')
  // 0 值键必须活下来：左栏按 feeds 表逐行渲染，缺键的表现是"角标空白"而非报错，
  // 所以这条要单独钉——它测的是**操作之后**的键域，与既有 :119 测的静止键域是两回事。
  assert.equal(Object.prototype.hasOwnProperty.call(view.perFeedUnread, 'A'), true,
    '标空之后 A 的键必须还在（否则左栏那一行的角标会消失）')
  assert.equal(view.perFeedUnread.B, 1, '别源不受影响')
  assert.equal(view.unread, 1)
  assert.equal(sumUnread(view.perFeedUnread), view.unread)
})

test('markRead 的返回值与随后 overview 的计数同口径（退订残留条目不进账）', async () => {
  // 这条钉的是两处**独立实现**的口径一致：countUnread（按 listFeeds 聚合）
  // 与 buildOverview 的全表遍历。两者各自自洽，只在互相漂移时才暴露。
  const store = memoryStore()
  store.feeds.set('A', { url: 'A', title: 'A' })
  store.items.set('a1', item('A'))
  store.items.set('x1', item('X')) // X 已退订，条目还残留在库里

  const marked = await callEndpoint(store, 'markRead', { itemIds: ['x1'] })
  assert.equal(marked.changed, 1, '残留条目本身是能被标记的')
  assert.equal(marked.unread, 1, '但它不该进账：总未读只数在订源（countUnread 这条路径）')

  const view = await overview(store)
  assert.equal(view.unread, 1, 'overview 的全表遍历必须与 countUnread 得出同一个数')
  assert.equal(view.perFeedUnread.A, 1)
  assert.equal(sumUnread(view.perFeedUnread), view.unread)
})

test('撤销（unmarkRead）之后账目回到标记前：守恒式在往返中不漂移', async () => {
  const store = memoryStore()
  store.feeds.set('A', { url: 'A', title: 'A' })
  store.feeds.set('B', { url: 'B', title: 'B' })
  store.items.set('a1', item('A'))
  store.items.set('a2', item('A'))
  store.items.set('b1', item('B'))

  const before = await overview(store)
  assert.equal(sumUnread(before.perFeedUnread), before.unread, '前置条件：起点守恒')

  await callEndpoint(store, 'markRead', { itemIds: ['a1', 'b1'] })
  const mid = await overview(store)
  assert.equal(sumUnread(mid.perFeedUnread), mid.unread, '到达中途也守')
  assert.equal(mid.unread, before.unread - 2)

  await callEndpoint(store, 'unmarkRead', { itemIds: ['a1', 'b1'] })
  const after = await overview(store)
  assert.deepEqual(after.perFeedUnread, before.perFeedUnread, '撤销后各源账目回到原样')
  assert.equal(after.unread, before.unread, '总数也回到原样（往返不漂移）')
  assert.equal(sumUnread(after.perFeedUnread), after.unread)
})

test('host：markRead / unmarkRead 的回包必须带 perFeedUnread（客户端在截断场景下只能靠它）', async () => {
  // 为什么这条必须在**宿主侧**断言：客户端那几条用的都是桩 fetch，桩回什么它就收什么 ——
  // 宿主真的回了什么，只有走到 createDispatch 才测得出来。只写客户端用例的话，
  // 「宿主忘了带 perFeedUnread」这个形态会静默漏过（桩件一直在代它履约）。
  const store = memoryStore()
  store.feeds.set('A', { url: 'A', title: 'A' })
  store.feeds.set('B', { url: 'B', title: 'B' })
  store.items.set('a1', item('A'))
  store.items.set('a2', item('A'))
  store.items.set('a3', item('A'))
  store.items.set('b1', item('B'))

  const marked = await callEndpoint(store, 'markRead', { itemIds: ['a1', 'a2', 'a3'] })
  assert.equal(marked.changed, 3, '前置条件：三条都标上了')
  assert.deepEqual(marked.perFeedUnread, { A: 0, B: 1 },
    '回包必须带每源账目（0 未读的源也要留键）—— 客户端看不见全量表，只能靠它')
  assert.equal(sumUnread(marked.perFeedUnread), marked.unread, '回包自身必须守恒')
  // 与 overview **同口径**：两处各算一遍就是任务 1 / 任务 5 栽过的那条路
  const view = await overview(store)
  assert.deepEqual(marked.perFeedUnread, view.perFeedUnread, '回包与 overview 的每源账目必须一致')
  assert.equal(marked.unread, view.unread, '回包与 overview 的总数必须一致')

  const undone = await callEndpoint(store, 'unmarkRead', { itemIds: ['a1'] })
  assert.equal(undone.changed, 1, '前置条件：真的撤销了一条')
  assert.deepEqual(undone.perFeedUnread, { A: 1, B: 1 }, '撤销的回包同样要带每源账目')
  assert.equal(sumUnread(undone.perFeedUnread), undone.unread, '撤销回包也守恒')
})

/* ---------------------------------------------------------------- 客户端半 */

/** 一条最小可用的条目（形状与 lib/client.js 消费的 Overview.items 一致）。 */
function clientItem(id, overrides = {}) {
  return {
    id, feedId: 'feedA', feedTitle: '源 A', title: '标题 ' + id,
    link: 'https://example.com/' + id, readAt: undefined, starred: false,
    fetchedAt: '2026-10-06T00:00:00.000Z', ...overrides,
  }
}

/** 桩 overview：键域 = feeds 表、0 未读的源也留 0 值键（守宿主契约）。 */
function clientOverview(items) {
  const feeds = [...new Set(items.map((entry) => entry.feedId))].map((feedId) => ({ id: feedId, title: feedId }))
  const perFeedUnread = {}
  for (const feed of feeds) perFeedUnread[feed.id] = 0
  for (const entry of items) if (entry.readAt === undefined) perFeedUnread[entry.feedId] += 1
  return { feeds, items, unread: items.filter((entry) => entry.readAt === undefined).length, perFeedUnread, refreshed: false }
}

/**
 * 加载真实构建产物 lib/client.js 并取出 createReaderStore（桩沙箱沿用 nav-selection.test.mjs 那套）。
 *
 * 桩 fetch 按宿主契约回应 markRead / unmarkRead 的 unread——markAllRead 会把宿主返回值写回
 * state.unread，若桩乱给一个数，测出来的"守恒破缺"就可能是桩造成的假象。
 *
 * @param hostTruth 宿主的**真账**（可选）。不传时就是 items 里能数出来的那份，等价于没截断。
 *   传它是为了表达真实截断：items 被 maxItemsShown 截到 300 条，而宿主的 unread / perFeedUnread
 *   是按**全量表**算的（src/config.ts 的 maxItemsPerFeed 500 > maxItemsShown 300）。此时客户端手上
 *   的 items 少于宿主账目，任何"拿本地 items 整体重算"的做法都会把账目算小。
 */
function loadStore(overview, hostTruth) {
  const source = readFileSync(BUNDLE, 'utf8')
  let captured = null
  class HTMLElementStub {}
  const sandbox = {
    document: { addEventListener: () => {}, removeEventListener: () => {}, querySelector: () => null, activeElement: null },
    window: { __ModuleLoader__: { load: (entry) => { captured = entry } }, open: () => {} },
    console,
    HTMLElement: HTMLElementStub,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  assert.ok(captured !== null, 'client bundle 没有调用 window.__ModuleLoader__.load')

  // 宿主侧的真账：可由调用方给一份比本地 items 更大的（截断场景）
  const host = {
    perFeedUnread: { ...(hostTruth?.perFeedUnread ?? overview.perFeedUnread) },
    unread: hostTruth?.unread ?? overview.unread,
  }
  const feedOf = new Map(overview.items.map((entry) => [entry.id, entry.feedId]))
  const shiftHost = (ids, delta) => {
    for (const id of ids) {
      const feedId = feedOf.get(id)
      if (feedId === undefined || host.perFeedUnread[feedId] === undefined) continue
      host.perFeedUnread[feedId] = Math.max(0, host.perFeedUnread[feedId] + delta)
      host.unread = Math.max(0, host.unread + delta)
    }
  }
  sandbox.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    const payload = body.payload ?? {}
    const reply = (value) => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) })
    if (body.endpoint === 'overview' || body.endpoint === 'refresh') {
      return reply({ ...overview, unread: host.unread, perFeedUnread: { ...host.perFeedUnread } })
    }
    if (body.endpoint === 'markRead' || body.endpoint === 'unmarkRead') {
      const ids = Array.isArray(payload.itemIds) ? payload.itemIds : []
      shiftHost(ids, body.endpoint === 'markRead' ? -1 : 1)
      // 回包**同时**给 unread 与 perFeedUnread（宿主契约：src/endpoints.ts 的 unreadAccount）。
      // 客户端在截断场景下看不见全量条目，只能靠这一份整体覆盖 —— 桩件少给一个字段就等于
      // 「替被测代码兜一个契约上不该存在的形状」（docs/pitfalls.md 二、2.5 / 2.6）。
      return reply({ changed: ids.length, unread: host.unread, perFeedUnread: { ...host.perFeedUnread } })
    }
    return reply({})
  }

  const require = (specifier) => {
    if (specifier === 'react' || specifier === 'react/jsx-runtime') {
      return {
        jsx: () => null, jsxs: () => null, Fragment: Symbol('Fragment'),
        useEffect: () => {}, useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
        useCallback: (fn) => fn, useRef: (initial) => ({ current: initial }), default: {},
      }
    }
    throw new Error('未预期的外部依赖：' + specifier)
  }
  // 交出**宿主真账的句柄**：截断 + 外部漂移那两条用例要表达「装载之后、按 A 之前，
  // 另一个面板把某个源标掉了」，那就必须能在两步之间改宿主这一侧的数（见用例注释）。
  return { store: captured.factory(require).createReaderStore(), host, feedOf }
}

async function clientStore(items, hostTruth) {
  const store = loadStore(clientOverview(items), hostTruth).store
  await store.load('overview')
  return store
}

/** 沙箱造的对象与测试 realm 原型不同，逐字段取值再求和——不把跨 realm 对象交给 deepEqual。 */
const sumPerFeed = (state) => Object.values({ ...state.perFeedUnread }).reduce((acc, n) => acc + n, 0)

test('客户端：打开一条（markRead）后该源角标与总未读同步 -1，守恒式仍成立', async () => {
  const store = await clientStore([
    clientItem('a1'), clientItem('a2'),
    clientItem('b1', { feedId: 'feedB', feedTitle: '源 B' }),
  ])
  const before = store.get()
  assert.equal(before.unread, 3, '前置条件：起点是 3 未读')
  assert.equal(sumPerFeed(before), before.unread, '前置条件：起点守恒')

  await store.markRead('a1')

  const after = store.get()
  assert.equal(after.unread, before.unread - 1, '顶栏总数要减 1')
  assert.equal(after.perFeedUnread.feedA, before.perFeedUnread.feedA - 1,
    '被标源的角标也必须同步减 1——否则左栏还是 2、顶栏已经 2，界面自相矛盾')
  assert.equal(after.perFeedUnread.feedB, before.perFeedUnread.feedB, '别源角标不动')
  assert.equal(sumPerFeed(after), after.unread, '守恒式在客户端落地后仍须成立')
})

test('客户端：全部标已读后各源角标归 0 且键仍在，守恒式仍成立', async () => {
  const store = await clientStore([
    clientItem('a1'), clientItem('a2'),
    clientItem('b1', { feedId: 'feedB', feedTitle: '源 B' }),
  ])

  await store.markAllRead()

  const state = store.get()
  assert.equal(state.unread, 0, '前置条件：全部标完了')
  assert.equal(sumPerFeed(state), 0)
  assert.deepEqual(Object.keys({ ...state.perFeedUnread }).sort(), ['feedA', 'feedB'],
    '0 值键必须保留：左栏按 feeds 表逐行渲染，缺键的表现是角标空白')
})

test('客户端：撤销「全部已读」后账目回到标记前，守恒式不漂移', async () => {
  const store = await clientStore([
    clientItem('a1'), clientItem('a2'),
    clientItem('b1', { feedId: 'feedB', feedTitle: '源 B' }),
  ])
  const before = store.get()
  const beforePerFeed = { ...before.perFeedUnread }

  await store.markAllRead()
  await store.undoMarkAll()

  const after = store.get()
  assert.equal(after.unread, before.unread, '撤销后总数回到原样')
  assert.equal(after.perFeedUnread.feedA, beforePerFeed.feedA, '各源角标也回到原样')
  assert.equal(after.perFeedUnread.feedB, beforePerFeed.feedB)
  assert.equal(sumPerFeed(after), after.unread, '往返之后守恒式仍须成立')
})

/* ------------------------------------------------- 截断：宿主账 > 本地可数 */

/**
 * 关于下面三条用例的**存在理由**（不是编造的边界，是默认配置下的常态）：
 *
 * 客户端只拿得到 maxItemsShown（默认 300）条 items，而每源可存 maxItemsPerFeed（默认 500）条，
 * 宿主的 unread / perFeedUnread 按**全量表**算。于是「本地 items 数出来的未读」比「宿主的账」
 * 小 —— 这正是任务 1 拒绝「客户端从 items 派生 perFeedUnread」的理由（src/shared.ts:58-65 注释）。
 * 客户端任何一处拿本地 items **整体重算**每源账目，都会在这个场景下把角标算小，
 * 而顶栏的 unread 是宿主给的真值 ⇒ 角标 0、顶栏 17，界面上自相矛盾且无从分辨。
 *
 * 宿主真账（本地 3 条 / 宿主 20 未读）模拟的就是这个截面。
 */
const TRUNCATED_HOST = { unread: 20, perFeedUnread: { feedA: 17, feedB: 3 } }

test('客户端[截断]：本地 items 少于宿主账目时，「全部已读」不许把角标算成本地可数', async () => {
  const store = await clientStore([clientItem('a1'), clientItem('a2'), clientItem('a3')], TRUNCATED_HOST)
  const before = store.get()
  assert.equal(before.unread, 20, '前置条件：顶栏是宿主给的全量口径')
  assert.equal(sumPerFeed(before), 20, '前置条件：起点守恒')

  await store.markAllRead()

  const after = store.get()
  // feedA：宿主 17，本地只有 3 条可数。批量标已读后**只剩截断之外那 14 条**——绝不是 0。
  assert.equal(after.perFeedUnread.feedA, 14,
    '角标必须按宿主账扣掉本地标掉的 3 条，而不是按本地 items 重算成 0')
  assert.equal(after.perFeedUnread.feedB, 3, '本地一条都没有的源，账目必须原样保留（不能被重算抹掉）')
  assert.equal(after.unread, 17, '总数以宿主回包为准')
  assert.equal(sumPerFeed(after), after.unread,
    '守恒式在截断场景下仍须成立——这正是任务 1 拒绝本地派生 perFeedUnread 的原因')
})

test('客户端[截断]：撤销「全部已读」把截断账目原样加回', async () => {
  const store = await clientStore([clientItem('a1'), clientItem('a2'), clientItem('a3')], TRUNCATED_HOST)
  const beforePerFeed = { ...store.get().perFeedUnread }

  await store.markAllRead()
  await store.undoMarkAll()

  const after = store.get()
  assert.equal(after.unread, 20, '撤销后总数回到宿主口径')
  assert.equal(after.perFeedUnread.feedA, beforePerFeed.feedA, '各源账目回到原样')
  assert.equal(after.perFeedUnread.feedB, beforePerFeed.feedB)
  assert.equal(sumPerFeed(after), after.unread, '往返之后守恒式仍须成立')
})

test('客户端[截断]：r 重新拉取时宿主会把真账带回来（本地账目不许覆盖它）', async () => {
  // 这条钉的是「重新向宿主拉一次」这条退路也必须守住同一个口径：overview 回来的是宿主真账，
  // 本地那点 items 只能影响本地乐观更新，不能让 state.perFeedUnread 被本地数出来的值顶掉。
  const store = await clientStore([clientItem('a1'), clientItem('a2'), clientItem('a3')], TRUNCATED_HOST)
  await store.markAllRead()
  await store.refreshCount()

  const state = store.get()
  assert.equal(state.perFeedUnread.feedA, 14, '重取后仍是宿主口径（17 - 本地标掉的 3）')
  assert.equal(state.perFeedUnread.feedB, 3, '本地没有条目的源，账目仍在')
  assert.equal(sumPerFeed(state), state.unread, '守恒式仍成立')
})

/* ------------------------------- 乐观更新（按下到回包之间） ------------------------------- */

/**
 * 关于下面两条用例：验收要求「乐观更新保留 —— 它负责手感，回包到达后以宿主为准纠正」
 * （task-9-fix-brief 修法第 3 点）。回包一到就整体覆盖，所以这份本地镜像**只在回包到达前**
 * 可见 —— 不能在 await 之后断言它，那时它已经（正确地）被宿主真值顶掉了。
 *
 * 它们同时是三条本地账目实现（markRead 的单条增量、markAllRead / undoMarkAll 的 shift 助手）
 * 的**唯一判据**：改成「按本地 items 整体重算」或「丢键域」之后，回包仍会纠正最终状态，
 * 只有这一瞬的镜像会露馅 —— 而那正是用户从按下到响应之间**看到**的东西。
 */

test('客户端：按下「全部标已读」的回包到达前，角标已按本批当场收起（乐观更新不许丢）', async () => {
  const live = loadStore(clientOverview([clientItem('a1'), clientItem('a2'), clientItem('a3')]), DRIFTING_HOST)
  await live.store.load('overview')

  const pending = live.store.markAllRead()
  // 回包还没到（fetch 的 promise 尚未 resolve）：此刻读到的就是乐观镜像
  const optimistic = live.store.get()
  assert.equal(optimistic.unread, 17, '顶栏按下即动：20 - 本地标掉的 3')
  assert.equal(optimistic.perFeedUnread.feedA, 14, 'feedA 按本批增量减 3（17 - 3）')
  assert.equal(optimistic.perFeedUnread.feedB, 3,
    '本地没有条目的源必须原样保留 —— 整体重算会把它抹成 0、丢键域会把它抹成 undefined')
  assert.equal(sumPerFeed(optimistic), optimistic.unread, '乐观镜像自身也要守恒')

  await pending
})

test('客户端：打开一条的回包到达前，该源角标已当场 -1（乐观更新不许丢）', async () => {
  const live = loadStore(clientOverview([
    clientItem('a1'), clientItem('a2'),
    clientItem('b1', { feedId: 'feedB', feedTitle: '源 B' }),
  ]), { unread: 12, perFeedUnread: { feedA: 9, feedB: 3 } })
  await live.store.load('overview')

  const pending = live.store.markRead('a1')
  const optimistic = live.store.get()
  assert.equal(optimistic.unread, 11, '顶栏按下即动')
  assert.equal(optimistic.perFeedUnread.feedA, 8, '被标源的角标必须当场 -1，否则左栏停在旧数上')
  assert.equal(optimistic.perFeedUnread.feedB, 3, '别源纹丝不动')
  assert.equal(sumPerFeed(optimistic), optimistic.unread, '乐观镜像自身也要守恒')

  await pending
})

/* --------------------------------- 截断 + 实时外部漂移 --------------------------------- */

/**
 * 关于下面两条用例的**存在理由**（与上面三条「截断」用例是两回事，别合并）：
 *
 * 上面三条表达的是**静止截面**：宿主账 20 > 本地 3，但漂移发生在**装载之前**（概览下发时
 * 就已经少 3 了）—— 本地那份基线跟着一起少 3，所以守恒仍成立，它们是绿的。
 *
 * 真正破缺的是**下一个截面**：装载之后、用户按 A 之前，另一个面板（或另一个标签页）把某个源
 * 标掉了，而那个源在本地**一条可见条目都没有**（本地只拿得到 maxItemsShown=300 条，截断之外
 * 那部分漂移本地完全看不见）。此时：
 *   · 宿主回包的 unread 已是新真值（少了 3），客户端照单全收；
 *   · 而客户端手上的 perFeedUnread 基线还是刷新前的旧数 —— 它会多出 3 个「幽灵未读」，
 *     界面表现为「左栏各源之和 17 ≠ 顶栏 14」，两个数都是真实渲染出来的。
 * 判据：宿主回包必须**一并下发 perFeedUnread**，客户端整体覆盖；拿本地看不见全量的增量去猜必破。
 * 这是 spec §4 不变量 1（左栏各源未读之和 === 顶栏总未读）的承重点，不是「刷新会自愈」那类瑕疵。
 */
const DRIFTING_HOST = { unread: 20, perFeedUnread: { feedA: 17, feedB: 3 } }

/** 外部面板把 feedB 的 3 条全标了 —— 该源在本地一条可见条目都没有（截断之外）。 */
function driftFeedB(live) {
  live.host.perFeedUnread.feedB = 0
  live.host.unread -= 3
}

test('截断场景下「全部标已读」：以宿主回包的 perFeedUnread 为准，守恒式不破', async () => {
  const live = loadStore(clientOverview([clientItem('a1'), clientItem('a2'), clientItem('a3')]), DRIFTING_HOST)
  await live.store.load('overview')
  // 前置条件：起点守恒（宿主 20 = feedA 17 + feedB 3）
  assert.equal(sumPerFeed(live.store.get()), live.store.get().unread, '前置条件：起点守恒')

  // 装载之后、按 A 之前：另一个面板把 feedB 标空了。本地只有 feedA 的 3 条，毫不知情。
  driftFeedB(live)

  await live.store.markAllRead()

  const state = live.store.get()
  assert.equal(state.unread, 14, '顶栏以宿主回包为准（20 - 本地标掉的 3，再减去外部漂移的 3）')
  assert.equal(state.perFeedUnread.feedA, 14, '本地标掉的 3 条要扣，截断之外的 14 条要留')
  assert.equal(state.perFeedUnread.feedB, 0,
    '本地看不见的源已被外部标空 —— 盲增量会把它留成 3（幽灵未读），回包必须把它纠正过来')
  assert.equal(sumPerFeed(state), state.unread,
    'spec §4 不变量 1：左栏各源之和必须等于顶栏总未读 —— 本地看不见的漂移也必须被纠正')
})

test('截断场景下撤销：同样以宿主回包为准', async () => {
  const live = loadStore(clientOverview([clientItem('a1'), clientItem('a2'), clientItem('a3')]), DRIFTING_HOST)
  await live.store.load('overview')
  driftFeedB(live)

  await live.store.markAllRead()
  const mid = live.store.get()
  assert.equal(mid.perFeedUnread.feedB, 0, '前置条件：按下 A 之后宿主已把外部漂移纠正过来')

  await live.store.undoMarkAll()

  const after = live.store.get()
  // 撤销只把本批 a1/a2/a3 加回 feedA；feedB 在那之前就已被外部标空，撤销**不许**把它复活成 3。
  assert.equal(after.perFeedUnread.feedA, 17, '撤销把本批 3 条加回 feedA')
  assert.equal(after.perFeedUnread.feedB, 0, '撤销的是本批，不是外部漂移：feedB 必须仍是 0')
  assert.equal(after.unread, 17, '总数同样以宿主回包为准')
  assert.equal(sumPerFeed(after), after.unread, '往返之后守恒式仍须成立')
})
