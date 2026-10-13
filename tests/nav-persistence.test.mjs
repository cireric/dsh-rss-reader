/**
 * 视图记忆（两列布局任务 7）的契约测试。
 *
 * 钉三条：① 记住并恢复「上次看到哪儿」；② 持久化值不可信时回落默认且不抛错；
 * ③ **老域（文件里没有 global 键）补上 global 槽后仍能打开** —— 这条是本任务唯一的
 * 「推测必须先实测」项，见下面第三条用例的注释。
 *
 * 三层各有各的判据，不互相替代：
 *   - 纯函数层：sanitizeViewPreferences 的形状归一化（读侧唯一判定点）；
 *   - 宿主端点层：viewPreferences / saveViewPreferences 与真实 ReaderStore 的接线；
 *   - 客户端层：真实构建产物 lib/client.js 里的 store，用桩传输喂持久化值 —— 恢复与写盘
 *     都是接线，而本仓库的历史故障几乎都出在接线上。
 * 第四条用例用**真实 JsonStorageBackend + 真实 DomainFacility + 真实 readerDomain** 打开一个
 * 手工构造的老文件 —— 只有这一层能证明「老用户没被锁在门外」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import vm from 'node:vm'
import { articleCharsOf } from '../lib/retention.js'
import { createDispatch } from '../lib/endpoints.js'
import { Config } from '../lib/config.js'
import { readerDomain } from '../lib/domain.js'
import { createStore } from '../lib/store.js'
import { openDatabase, migrateSchema } from '../lib/storage/db.js'
import { createSqliteStore } from '../lib/store-sqlite.js'
import { sanitizeViewPreferences, DEFAULT_VIEW_PREFERENCES } from '../lib/shared.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(ROOT, 'lib', 'client.js')
// 与 client-bundle.test.mjs 的 BUNDLE_NAME 同一条理由（变异门槛的「崩了」分类器靠帧里的文件名）
const BUNDLE_NAME = 'client.js'

/** 等一轮宏任务：客户端写盘是 fire-and-forget 的异步链，断言前必须先让它落定。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/* ============================ ① 纯函数层：形状归一化 ============================ */

test('sanitizeViewPreferences：形状合法时原样通过，且只留协议里的三个字段', () => {
  const value = sanitizeViewPreferences({ navSelection: { kind: 'feed', feedId: 'A' }, filter: 'unread', navVisible: false })
  assert.deepEqual(value, { navSelection: { kind: 'feed', feedId: 'A' }, filter: 'unread', navVisible: false })
  // 未知键必须被丢掉：它会被原样写回存储，攒够一版就成历史包袱
  const extra = sanitizeViewPreferences({ navSelection: { kind: 'virtual' }, filter: 'all', navVisible: true, legacyJunk: 1 })
  assert.deepEqual(Object.keys(extra).sort(), ['filter', 'navSelection', 'navVisible'])
  // 默认常量本身必须是合法形状（它同时是域里的 initial）
  assert.deepEqual(sanitizeViewPreferences(DEFAULT_VIEW_PREFERENCES), DEFAULT_VIEW_PREFERENCES)
})

test('sanitizeViewPreferences：认不出的形状一律回落默认，绝不编造', () => {
  const defaults = { ...DEFAULT_VIEW_PREFERENCES }
  const bad = [
    undefined, null, 0, 'x', [], true,
    {},                                                   // 空对象
    { navSelection: { kind: 'nope' } },                   // 未知 kind
    { navSelection: { kind: 'feed' } },                   // 缺 feedId
    { navSelection: { kind: 'feed', feedId: '' } },       // 空 feedId
    { navSelection: { kind: 'feed', feedId: 7 } },        // feedId 不是字符串
    { filter: 'starred?', navVisible: 'yes' },            // 非法枚举 + 非法布尔
    { filter: null, navVisible: 0 },
  ]
  for (const raw of bad) {
    assert.deepEqual(sanitizeViewPreferences(raw), defaults, '不可信值必须整份回落：' + JSON.stringify(raw))
  }
  // 逐字段独立回落：filter 坏了不该把 navSelection 一起带走（否则一次坏值会抹掉更多记忆）
  const partial = sanitizeViewPreferences({ navSelection: { kind: 'feed', feedId: 'A' }, filter: 'bogus', navVisible: false })
  assert.deepEqual(partial, { navSelection: { kind: 'feed', feedId: 'A' }, filter: 'all', navVisible: false })
})

test('sanitizeViewPreferences：给了「源是否还在订」的判据时，未知 feedId 回落虚拟视图', () => {
  const known = (feedId) => feedId === 'A'
  assert.deepEqual(
    sanitizeViewPreferences({ navSelection: { kind: 'feed', feedId: 'A' } }, known).navSelection,
    { kind: 'feed', feedId: 'A' }, '在订的源必须原样保留 —— 否则「回落」会把正常记忆也吃掉')
  assert.deepEqual(
    sanitizeViewPreferences({ navSelection: { kind: 'feed', feedId: 'gone' } }, known).navSelection,
    { kind: 'virtual' }, '已退订的源必须回落，而不是留一个指向不存在源的选中态')
  // 不传判据 = 只验形状（客户端恢复时用：那一刻本地 feeds 还是空的，拿它当判据会把正常记忆全吃掉）
  assert.deepEqual(
    sanitizeViewPreferences({ navSelection: { kind: 'feed', feedId: 'gone' } }).navSelection,
    { kind: 'feed', feedId: 'gone' })
  // 返回的必须是新对象：不可把未校验的原值引到 state 里
  const raw = { navSelection: { kind: 'virtual' }, filter: 'all', navVisible: true }
  assert.notEqual(sanitizeViewPreferences(raw), raw)
})

/* =================== ①b 宿主真实适配器（lib/store.js 的 createStore） =================== */

/**
 * 一个最小的 Domain 桩，只为驱动**真实的** createStore。
 *
 * 为什么要这一层：下面端点层用的是本文件自己的内存桩，而生产路径走的是 createStore ——
 * 只测桩就等于「介质换成了我的理解」。这里把 Domain 的 table/global 两个面按真实接口填出来，
 * 让 createStore 里那两句 sanitizeViewPreferences 真的被执行。
 */
function fakeDomain({ feedIds = [] } = {}) {
  const tables = { feeds: new Map(), items: new Map(), cursors: new Map() }
  for (const id of feedIds) tables.feeds.set(id, { url: id })
  let global
  const handle = (name) => ({
    get: (key) => tables[name].get(key),
    entries: () => [...tables[name].entries()][Symbol.iterator](),
    keys: () => [...tables[name].keys()][Symbol.iterator](),
    get size() { return tables[name].size },
    put: async (key, value) => { tables[name].set(key, value) },
    delete: async (key) => tables[name].delete(key),
    update: async (key, fn) => { const next = fn(tables[name].get(key)); tables[name].set(key, next); return next },
  })
  return {
    domain: { name: 'rss_reader', table: handle, global: { get: () => global, set: async (value) => { global = value } } },
    readGlobal: () => global,
    writeGlobal: (value) => { global = value },
  }
}

test('真实 createStore：读侧校验坏值、写侧归一后才落库（生产路径，不是桩）', () => {
  const { domain, readGlobal, writeGlobal } = fakeDomain({ feedIds: ['A'] })
  const store = createStore(domain)

  assert.deepEqual(store.viewPreferences(), DEFAULT_VIEW_PREFERENCES, '媒介还没有 global ⇒ 回落 initial')

  // 写侧：未知源先归一再落库 —— 认不出的原值绝不许进媒介
  return store.saveViewPreferences({ navSelection: { kind: 'feed', feedId: 'gone' }, filter: 'unread', navVisible: false })
    .then((saved) => {
      assert.deepEqual(saved, { navSelection: { kind: 'virtual' }, filter: 'unread', navVisible: false })
      assert.deepEqual(readGlobal(), saved, '落库的必须是归一后的值')
      assert.deepEqual(store.viewPreferences(), saved, '读回来一致')

      // 读侧：媒介里被塞了坏值时也不许透出去（这是读侧校验唯一能生效的位置）
      writeGlobal({ navSelection: { kind: 'feed', feedId: 'gone' }, filter: 'bogus', navVisible: 1 })
      assert.deepEqual(store.viewPreferences(), DEFAULT_VIEW_PREFERENCES, '坏值诚实回落，不编造也不透传')

      // 在订的源必须保住（回落不能把正常记忆也吃掉）
      writeGlobal({ navSelection: { kind: 'feed', feedId: 'A' }, filter: 'starred', navVisible: false })
      assert.deepEqual(store.viewPreferences(), { navSelection: { kind: 'feed', feedId: 'A' }, filter: 'starred', navVisible: false })
    })
})

/**
 * 同一组契约，换到**生产路径**的自持存储上再钉一遍（Task 4 的 cutover）。
 *
 * 为什么两条都要留着，而不是把上面的 fakeDomain 换成它：那条同时是 `lib/store.js` 两个变异
 * 的判据（scripts/mutation-test.mjs 的 'persist-宿主读侧不校验' 与 'persist-宿主写侧不归一'）。
 * 删掉它、只留 SQLite 版，那两条变异就**幸存**了 —— 而门槛上「幸存」等于测试缺口。
 * 反过来只留旧那条也不够：Task 4 之后生产路径是 createSqliteStore，它一次都没被这组契约测过。
 *
 * 两条路径的共同判据（读侧归一、写侧归一再落库、未知源回落）在这里逐条重复，是刻意的：
 * 存储换介质时最容易发生的事，就是「旧实现的那条承诺没跟过来」。
 */
test('真实 createSqliteStore：读侧校验坏值、写侧归一后才落库（cutover 后的生产路径）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rss-nav-sqlite-'))
  const configPath = join(dir, 'config.json')
  const db = openDatabase(':memory:')
  try {
    migrateSchema(db)
    const store = createSqliteStore(db, configPath)
    await store.saveFeed('A', { url: 'A' })

    assert.deepEqual(store.viewPreferences(), DEFAULT_VIEW_PREFERENCES, 'config.json 还没有 ⇒ 回落默认')

    // 写侧：未知源先归一再落库 —— 认不出的原值绝不许进文件
    const saved = await store.saveViewPreferences({ navSelection: { kind: 'feed', feedId: 'gone' }, filter: 'unread', navVisible: false })
    assert.deepEqual(saved, { navSelection: { kind: 'virtual' }, filter: 'unread', navVisible: false })
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).viewPreferences, saved, '落盘的必须是归一后的值')
    assert.deepEqual(store.viewPreferences(), saved, '读回来一致')

    // 读侧：文件里被塞了坏值时也不许透出去（这是读侧校验唯一能生效的位置）
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    onDisk.viewPreferences = { navSelection: { kind: 'feed', feedId: 'gone' }, filter: 'bogus', navVisible: 1 }
    writeFileSync(configPath, JSON.stringify(onDisk))
    assert.deepEqual(store.viewPreferences(), DEFAULT_VIEW_PREFERENCES, '坏值诚实回落，不编造也不透传')

    // 在订的源必须保住（回落不能把正常记忆也吃掉）
    await store.saveViewPreferences({ navSelection: { kind: 'feed', feedId: 'A' }, filter: 'starred', navVisible: false })
    assert.deepEqual(store.viewPreferences(), { navSelection: { kind: 'feed', feedId: 'A' }, filter: 'starred', navVisible: false })
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ============================ ② 宿主端点层 ============================ */

function memoryStore() {
  const feeds = new Map()
  const items = new Map()
  let global = undefined
  return {
    feeds, items,
    globalGet: () => global,
    /** 绕过归一直接写媒介 —— 造「存储里本来就有坏值」这一形态用（真实路径下写不进坏值）。 */
    globalPut: (value) => { global = value },
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
    // 与 src/store.ts 的 createStore 逐条同形：读侧归一（未知源回落）、写侧也归一后落库并**返回**它
    viewPreferences: () => sanitizeViewPreferences(global, (feedId) => feeds.has(feedId)),
    saveViewPreferences: async (preferences) => {
      const safe = sanitizeViewPreferences(preferences, (feedId) => feeds.has(feedId))
      global = safe
      return safe
    },
  }
}

/** EndpointDeps 的桩（形状照 src/endpoints.ts 的 EndpointDeps，不增减字段）。 */
const deps = (store) => ({
  config: Config({}),
  log: () => {},
  ready: () => store,
  refreshNow: async () => false,
  lastRefreshCompletedAt: () => undefined,
  articleAttempts: new Map(),
})

async function callEndpoint(store, endpoint, payload) {
  const result = await createDispatch(deps(store))(endpoint, payload)
  assert.equal(result.ok, true, endpoint + ' 应当成功')
  return result.value
}

test('端点：saveViewPreferences 存下偏好，viewPreferences 原样读回', async () => {
  const store = memoryStore()
  store.feeds.set('A', { url: 'A', title: 'A' })
  const preferences = { navSelection: { kind: 'feed', feedId: 'A' }, filter: 'starred', navVisible: false }

  const saved = await callEndpoint(store, 'saveViewPreferences', { preferences })
  assert.deepEqual(saved.preferences, preferences, '回带宿主实际存下的值')

  const read = await callEndpoint(store, 'viewPreferences', {})
  assert.deepEqual(read.preferences, preferences, '重开面板读到的必须与写下去的一致')
  assert.deepEqual(store.globalGet(), preferences, '真的落到域的 global 槽上')
})

test('端点：未知 feedId / 非法形状写进来时回落默认，不抛错也不把垃圾存进域', async () => {
  const store = memoryStore()
  store.feeds.set('A', { url: 'A', title: 'A' })

  const unknownFeed = await callEndpoint(store, 'saveViewPreferences', { preferences: { navSelection: { kind: 'feed', feedId: 'gone' }, filter: 'unread', navVisible: false } })
  assert.deepEqual(unknownFeed.preferences, { navSelection: { kind: 'virtual' }, filter: 'unread', navVisible: false },
    '已退订的源要回落虚拟视图，而 filter / navVisible 这两条仍然保得住')
  assert.deepEqual(store.globalGet(), unknownFeed.preferences, '存进域的必须是回落后的值 —— 不许把认不出的原值原样塞进去')

  const junk = await callEndpoint(store, 'saveViewPreferences', { preferences: 'not-an-object' })
  assert.deepEqual(junk.preferences, DEFAULT_VIEW_PREFERENCES, '整份认不出就整份回落')
  const missing = await callEndpoint(store, 'viewPreferences', {})
  assert.deepEqual(missing.preferences, DEFAULT_VIEW_PREFERENCES, '读侧同样不许抛错')

  // 域里存着坏值时，读端点必须回落而不是把它透出去（绕过写侧归一，直接往媒介里塞坏值）
  store.globalPut({ navSelection: { kind: 'feed', feedId: 'gone' }, filter: 'bogus', navVisible: 1 })
  const read = await callEndpoint(store, 'viewPreferences', {})
  assert.deepEqual(read.preferences, DEFAULT_VIEW_PREFERENCES, '诚实回落到默认，而不是编造或透传')
})

/* ============================ ③ 客户端层（真实构建产物） ============================ */

function item(id, overrides = {}) {
  return {
    id, feedId: 'A', feedTitle: '源 A', title: '标题 ' + id,
    link: 'https://example.com/' + id, readAt: undefined, starred: false,
    fetchedAt: '2026-10-06T00:00:00.000Z', ...overrides,
  }
}

/** 守宿主契约的 overview 桩（键域 = feeds 表，0 未读的源也留键）。 */
function overviewOf(items) {
  const feeds = [...new Set(items.map((entry) => entry.feedId))].map((feedId) => ({ id: feedId, title: feedId }))
  const perFeedUnread = {}
  for (const feed of feeds) perFeedUnread[feed.id] = 0
  for (const entry of items) if (entry.readAt === undefined) perFeedUnread[entry.feedId] += 1
  return { feeds, items, unread: items.filter((entry) => entry.readAt === undefined).length, perFeedUnread, refreshed: false }
}

/**
 * 加载真实 bundle / 驱动真实 store。prefs 是「宿主那一侧的域 global」：跨两次 store 实例共享，
 * 这样「重开面板」在测试里就是「再建一个 store、读同一份 prefs」。
 */
function loadExports({ items, prefs, failSave = false, writeDelayMs = [] }) {
  const source = readFileSync(BUNDLE, 'utf8')
  let captured = null
  class HTMLElementStub {}
  const sandbox = {
    document: { addEventListener: () => {}, removeEventListener: () => {}, querySelector: () => null, activeElement: null },
    window: { __ModuleLoader__: { load: (entry) => { captured = entry } }, open: () => {} },
    console, HTMLElement: HTMLElementStub, setTimeout, clearTimeout, Date, JSON,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: BUNDLE_NAME })
  assert.ok(captured !== null, 'client bundle 没有调用 window.__ModuleLoader__.load')
  sandbox.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    const ok = (value) => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) })
    const bad = (code, message) => ({ ok: true, status: 200, json: async () => ({ ok: false, error: { code, message, details: {} } }) })
    if (body.endpoint === 'overview' || body.endpoint === 'refresh') return ok(overviewOf(items))
    if (body.endpoint === 'viewPreferences') return ok({ preferences: prefs.value })
    if (body.endpoint === 'saveViewPreferences') {
      if (failSave) return bad('internal', '写盘失败')
      // 第 n 次写盘的延迟由用例指定：用来表达「后发的先到」这种真实网络里会发生的事。
      // ⚠️ 序号必须在**请求到达时**取，不能用 prefs.writes.length（它只在落库后 +1）：
      // 两个请求同时在飞时，第二个到达时 length 还是 0 —— 两次会拿到同一个延迟，
      // 「后发先到」这个形态就表达不出来（本条夹具的第一版正是这么错的，变异因此静默幸存）。
      prefs.arrived = (prefs.arrived ?? 0) + 1
      const delay = writeDelayMs[prefs.arrived - 1] ?? 0
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      prefs.value = body.payload.preferences
      prefs.writes.push(body.payload.preferences)
      return ok({ preferences: prefs.value })
    }
    return ok({ changed: 1, unread: 0 })
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
  return captured.factory(require)
}

/** 「重开面板」：新 store 读同一份宿主 prefs。 */
async function openPanel(shared) {
  const exports = loadExports(shared)
  const store = exports.createReaderStore()
  await store.load('overview')
  await flush()
  return store
}

function twoFeeds() {
  return [item('a1'), item('a2'), item('b1', { feedId: 'B', feedTitle: '源 B' })]
}

const ids = (list) => list.map((entry) => entry.id)

test('记住上次选中的导航项、filter 与左栏显隐，重开后恢复', async () => {
  const prefs = { value: undefined, writes: [] }
  const first = await openPanel({ items: twoFeeds(), prefs })

  // 起点：没有任何记忆时是默认态
  assert.equal(first.get().filter, 'all')
  assert.equal(first.get().navSelection.kind, 'virtual')
  assert.equal(first.get().navVisible, true)
  assert.equal(prefs.value, undefined, '没动作就不该写盘 —— 读一次面板不产生副作用')

  // **逐个动作各断言一次写入**：persistView 落的是整份 state，若只在最后断言一次，
  // 那么任何单个动作漏写都会被后一个动作的整份写入盖过去 —— 那条守卫就永远没人看。
  first.setFilter('unread')
  await flush()
  assert.deepEqual(prefs.value, { navSelection: { kind: 'virtual' }, filter: 'unread', navVisible: true },
    'setFilter 自己就要写一次盘')

  first.selectNav({ kind: 'feed', feedId: 'B' })
  await flush()
  assert.deepEqual(prefs.value, { navSelection: { kind: 'feed', feedId: 'B' }, filter: 'unread', navVisible: true },
    'selectNav 自己就要写一次盘')

  first.toggleNav()
  await flush()
  assert.equal(prefs.writes.length, 3, '三个关键动作各写一次，不多不少')
  assert.deepEqual(prefs.value, { navSelection: { kind: 'feed', feedId: 'B' }, filter: 'unread', navVisible: false },
    '三个状态都必须落盘，且只落协议里的三个字段')

  // 重开面板：新 store 实例 + 同一份宿主 prefs
  const second = await openPanel({ items: twoFeeds(), prefs })
  assert.equal(second.get().filter, 'unread', 'filter 必须恢复，而不是回 all 初始态')
  assert.equal(second.get().navSelection.kind, 'feed', '选中的源必须恢复')
  assert.equal(second.get().navSelection.feedId, 'B')
  assert.equal(second.get().navVisible, false, '左栏显隐必须恢复')
  assert.deepEqual(ids(second.visible()), ['b1'], '恢复后的右栏内容就是「源 B × 未读」')
  // 光标刻意**不**持久化：恢复时按既有规则落到「生效的那一行」（见 src/client/store.ts 的注释）
  assert.deepEqual({ ...second.get().navCursor }, { kind: 'feed', feedId: 'B' },
    '光标落在生效的源那一行 —— 与鼠标点源、shift+o 打开源行同一规则')
})

test('持久化值不可信时（未知 feedId / 非法 shape）回落默认值且不抛错', async () => {
  const ghost = { value: { navSelection: { kind: 'feed', feedId: 'ghost' }, filter: 'unread', navVisible: false }, writes: [] }
  const store = await openPanel({ items: twoFeeds(), prefs: ghost })
  assert.equal(store.get().navSelection.kind, 'virtual', '源已退订 ⇒ 回落虚拟视图，而不是留一个指向不存在源的选中态')
  assert.deepEqual(ids(store.visible()), ['a1', 'a2', 'b1'], '回落之后右栏必须能看到条目（不是空列表）')

  // 三项**全部**非法时整份回落默认
  for (const value of [
    'not-an-object', 0, null, true, [],
    { navSelection: { kind: 'nope' }, filter: 'bogus', navVisible: 'yes' },
    { navSelection: { kind: 'feed', feedId: 7 }, filter: null, navVisible: 1 },
    { navSelection: null, filter: [], navVisible: null },
  ]) {
    const junk = await openPanel({ items: twoFeeds(), prefs: { value, writes: [] } })
    assert.equal(junk.get().filter, 'all', '非法 filter 回落 all：' + JSON.stringify(value))
    assert.equal(junk.get().navVisible, true, '非法 navVisible 回落 true：' + JSON.stringify(value))
    assert.equal(junk.get().navSelection.kind, 'virtual', '非法 navSelection 回落虚拟视图：' + JSON.stringify(value))
  }
  // 单字段非法时只回落那一项 —— 合法的那几项必须原样恢复（否则一次坏值抹掉更多记忆）
  const onlyFilterBad = await openPanel({
    items: twoFeeds(),
    prefs: { value: { navSelection: { kind: 'feed', feedId: 'B' }, filter: 'bogus', navVisible: false }, writes: [] },
  })
  assert.equal(onlyFilterBad.get().filter, 'all', '非法 filter 回落 all')
  assert.equal(onlyFilterBad.get().navVisible, false, 'navVisible 合法则原样恢复')
  assert.equal(onlyFilterBad.get().navSelection.feedId, 'B', 'navSelection 合法则原样恢复')

  // 逐字段独立回落：坏掉一项不该把另外两项的记忆一起抹掉
  const partial = await openPanel({
    items: twoFeeds(),
    prefs: { value: { navSelection: { kind: 'feed', feedId: 'B' }, filter: 'bogus', navVisible: false }, writes: [] },
  })
  assert.equal(partial.get().filter, 'all')
  assert.equal(partial.get().navVisible, false, 'filter 坏了不该带走 navVisible')
  assert.equal(partial.get().navSelection.feedId, 'B', 'filter 坏了不该带走选中的源')
})

test('写盘失败必须可见：进 error 而不是被吞掉', async () => {
  const prefs = { value: undefined, writes: [] }
  const exports = loadExports({ items: twoFeeds(), prefs, failSave: true })
  const store = exports.createReaderStore()
  await store.load('overview')
  await flush()

  store.toggleNav()
  await flush()

  assert.ok(store.get().error !== undefined, '写盘失败的异常必须有可见后果（AGENTS.md 禁空 catch）')
  assert.match(String(store.get().error), /写盘失败|internal/)
  assert.equal(store.get().navVisible, false, '持久化失败不该回滚界面上的状态 —— 那是两件事')
})

test('恢复是异步的：用户在它到达之前的手势不会被旧记忆盖掉（整份让位）', async () => {
  // 面板一挂载就 load，而恢复要等一次读端点往返。这中间用户可以按 u —— 若恢复无条件覆盖，
  // 表现是「按了没反应，过一会儿左栏自己弹回来」。判据就是这条时序。
  //
  // 裁决：**手势一旦发生就整份让位**，不做「碰过的那项让位、其余照常恢复」的逐项合并。
  // 理由是那条合并路径自己会制造矛盾状态 —— 手势已经把「当前 state」整份写进存储了
  //（persistView 落的是三项），此时的 state 才是存储里的真值；再拿旧记忆回填没被碰的那两项，
  // 就会出现「界面显示 unread，存储里记着 all」，下次重开又变回 all，用户更无从理解。
  // 代价如实说明：恢复窗口（一次本机 RPC 往返）内发生的手势，会用当时的状态覆盖全部记忆。
  const prefs = { value: { navSelection: { kind: 'virtual' }, filter: 'unread', navVisible: true }, writes: [] }
  const exports = loadExports({ items: twoFeeds(), prefs })
  const store = exports.createReaderStore()
  const loading = store.load('overview')   // 刻意不 await：模拟「还在读」的那一刻
  store.toggleNav()                        // 用户此刻按了 u
  assert.equal(store.get().navVisible, false, '前置条件：手势已经生效')
  await loading
  await flush()

  assert.equal(store.get().navVisible, false, '恢复不得盖掉用户已经做过的手势')
  assert.equal(store.get().filter, 'all', '整份让位：手势那一刻的状态就是新的记忆（存储里也是它）')
  assert.deepEqual(prefs.value, { navSelection: { kind: 'virtual' }, filter: 'all', navVisible: false },
    '存储里必须是与界面一致的那份 —— 两者不一致才是真正的缺陷')
})

test('写盘串行化：前一次慢、后一次快时，最终的记忆是「后一次动作」', async () => {
  // 不串行化时两个请求会同时在飞，先发但慢的那个最后落地 —— 记忆回退成用户更早的状态，
  // 表现为「选了源、重开面板却回到上一个源」。判据是最终落库的值 + 落地顺序。
  const prefs = { value: { navSelection: { kind: 'virtual' }, filter: 'all', navVisible: true }, writes: [], order: [] }
  const exports = loadExports({ items: twoFeeds(), prefs, writeDelayMs: [40, 0] })
  const store = exports.createReaderStore()
  await store.load('overview')
  await flush()

  store.setFilter('unread')                              // 第一次写：慢（40ms）
  store.selectNav({ kind: 'feed', feedId: 'B' })         // 第二次写：快
  await new Promise((resolve) => setTimeout(resolve, 120))

  assert.equal(prefs.writes.length, 2, '两次动作各写一次')
  assert.deepEqual(prefs.value, { navSelection: { kind: 'feed', feedId: 'B' }, filter: 'unread', navVisible: true },
    '最终记忆必须是最新动作那一份，而不是最后落地的那个请求')
  assert.deepEqual(prefs.writes[0], { navSelection: { kind: 'virtual' }, filter: 'unread', navVisible: true },
    '串行化：第一次写的是动作发生时的状态（当时还没选源）')
  assert.deepEqual(prefs.writes[1], { navSelection: { kind: 'feed', feedId: 'B' }, filter: 'unread', navVisible: true })
  // 顺序即「按动作先后」，与 setFilter 里那句注释同一条判据
  assert.deepEqual((() => { const s = store.get(); return { navSelection: s.navSelection.kind === 'feed' ? { kind: 'feed', feedId: s.navSelection.feedId } : { kind: 'virtual' }, filter: s.filter, navVisible: s.navVisible } })(), prefs.value,
    '界面状态与存储里的记忆必须一致')
})

test('只在关键动作时写盘：移动光标（每次按键）不产生写入', async () => {
  const prefs = { value: { navSelection: { kind: 'virtual' }, filter: 'all', navVisible: true }, writes: [] }
  const store = await openPanel({ items: twoFeeds(), prefs })
  assert.equal(prefs.writes.length, 0, '前置条件：恢复本身不写盘（否则每次打开都回写一遍同样的值）')

  store.moveNavCursor(1)
  store.moveNavCursor(1)
  store.moveNavCursor(-1)
  await flush()
  assert.equal(prefs.writes.length, 0,
    '光标移动不是被记忆的状态：它每按一次都发生，写盘只会把域写热而记不住任何东西（取舍见报告）')

  store.toggleNav()
  await flush()
  assert.equal(prefs.writes.length, 1, '真正被记忆的动作才写一次')
})

/* ============================ ④ 老域能否打开（必须实测） ============================ */

/**
 * 找真实的 JsonStorageBackend。
 *
 * 为什么必须是**真实后端**：站点要证明的是「老用户升级后还能打开域」，而版本检查、global 的
 * null 哨兵语义都发生在后端与设施的边界上（lib/types/spec.d.ts:83-89、storage-json 的 format.ts）。
 * 自己写一个内存 KvUnit 来「模拟」后端，等于把待验证的那一层换成我的理解 —— 那就是猜测冒充实测。
 * 本仓不链 dsh-storage-json（scripts/build.sh 只链了 storage-domain），故按 checkout 现取。
 */
async function realJsonBackendClass() {
  const home = process.env['HOME'] ?? ''
  const candidates = [
    process.env['DSH_CHECKOUT'], join(home, 'dsh-harness'), join(home, 'dsh'),
    join(home, '.dsh', 'dsh-harness'), join(home, 'deepseek-harness'),
  ].filter((candidate) => candidate !== undefined && candidate !== '')
  const install = () => import('@deepseek-ai/dsh-storage-json').then((module) => module.JsonStorageBackend)
  for (const checkout of candidates) {
    const paths = [
      join(checkout, 'packages', 'storage', 'storage-json', 'lib', 'index.js'),
      join(checkout, 'apps', 'cli', 'node_modules', '@deepseek-ai', 'dsh-base', 'node_modules', '@deepseek-ai', 'dsh-storage-json', 'lib', 'index.js'),
    ]
    for (const path of paths) {
      if (existsSync(path)) return (await import(pathToFileURL(path).href)).JsonStorageBackend
    }
  }
  // 兜底：万一将来被链进 node_modules
  try {
    return await install()
  } catch (error) {
    throw new Error('找不到真实 @deepseek-ai/dsh-storage-json（本用例需要它；试过 ' + candidates.join(' / ') + '）：' + String(error))
  }
}

/** 用真实后端 + 真实 DomainFacility 打开一个**手工构造的老域文件**。 */
async function openRealDomain({ name, schema, initial, tables, fileContent }) {
  const { DomainFacility, defineDomain, domainTable } = await import('@deepseek-ai/dsh-storage-domain')
  const JsonStorageBackend = await realJsonBackendClass()
  const dir = mkdtempSync(join(tmpdir(), 'rss-legacy-domain-'))
  const file = join(dir, name + '.json')
  writeFileSync(file, JSON.stringify(fileContent, null, 2) + '\n')
  const backend = new JsonStorageBackend(dir)
  const ctx = {
    emit: () => {},
    logger: { warn: (message) => console.warn('[legacy-domain]', message), error: (message) => console.warn('[legacy-domain]', message) },
    storage: { backend: { get: (backendName) => (backendName === 'json' ? backend : undefined) } },
  }
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  const spec = defineDomain({ name, version: 1, global: { schema, initial }, tables })
  return { domain: await facility.open(spec), file, dir }
}

test('老域（文件里没有 global）能正常打开并回落到 initial', async () => {
  const { z } = await import('zod')
  const tables = { feeds: (await import('@deepseek-ai/dsh-storage-domain')).domainTable(z.object({ url: z.string() }).strict()) }
  const initial = { navSelection: { kind: 'virtual' }, filter: 'all', navVisible: true }
  // ① 老文件**完全没有 global 键**（升级前写下的形态）② 老文件里 global 是 null（本机实测的形态）
  const legacyVariants = {
    '没有 global 键': { unit: { name: 'rss_reader_legacy_a', version: 1 }, tables: { feeds: { f1: { url: 'f1' } } } },
    'global 为 null': { unit: { name: 'rss_reader_legacy_b', version: 1 }, global: null, tables: { feeds: { f1: { url: 'f1' } } } },
  }
  let index = 0
  for (const [label, content] of Object.entries(legacyVariants)) {
    index += 1
    const name = 'rss_reader_legacy_' + (index === 1 ? 'a' : 'b')
    const { domain, file } = await openRealDomain({
      name,
      // 与 src/domain.ts 的 global 槽**同一形状**：必须非 null，但形状不合格也不许拒绝
      schema: z.unknown().refine((value) => value !== null),
      initial, tables, fileContent: content,
    })
    assert.deepEqual(domain.global.get(), initial, label + '：媒介没有 global 时必须回落到 initial')
    assert.equal(domain.table('feeds').size, 1, label + '：原有的表记录必须原样还在（老用户的数据没被弄丢）')

    // 真的写一次：老文件被就地补上 global，且版本维持 1、表记录不丢
    await domain.global.set({ navSelection: { kind: 'feed', feedId: 'f1' }, filter: 'unread', navVisible: false })
    await domain.close()
    const written = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(written.unit.version, 1, '版本必须仍是 1 —— 升 version 会让老用户打不开域（src/domain.ts 有实测记录）')
    assert.deepEqual(written.global, { navSelection: { kind: 'feed', feedId: 'f1' }, filter: 'unread', navVisible: false }, label + '：首次 set 才落盘')
    assert.deepEqual(written.tables.feeds, { f1: { url: 'f1' } }, label + '：补 global 不得动表数据')
  }
})

test('readerDomain 的 global 槽：非 null 约束满足设施要求，且 version 仍是 1', () => {
  assert.equal(readerDomain.version, 1, '禁止改 version：single layout 下版本是硬相等检查')
  assert.ok(readerDomain.global !== undefined, 'UI 偏好走 global 单例槽，不新增表')
  assert.deepEqual(Object.keys(readerDomain.tables).sort(), ['cursors', 'feeds', 'items'], '禁止新增 domain 表')
  assert.equal(readerDomain.global.schema.safeParse(null).success, false,
    'null 是「从未写过」的哨兵：global schema 必须拒绝 null（defineDomain 也会因此抛错）')
})
