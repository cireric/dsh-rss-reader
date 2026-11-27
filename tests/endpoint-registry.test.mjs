/**
 * 端点注册表：名字单一来源、表完整性、横切信封（计划 Task 1-3/5）。
 *
 * 为什么单独一个文件：变异清单里两条新增条目以它为 judge
 * （endpoint-表漏掉一个端点 / endpoint-未就绪守卫被绕过），一个文件一个职责。
 *
 * 刻意用**真实 SQLite store**而不是内存桩：`toggleStar` / `opmlExport` 等五个端点在端点层
 * 原本零覆盖（2026-10-15 实测：grep 全部 27 个测试文件，驱动次数均为 0），本文件的用例是先立
 * 的金标准；桩会各自漂移，真 store 不会（docs/pitfalls.md 二、2.5 / 2.6）。
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
import { readFileSync } from 'node:fs'
import { ENDPOINT_NAMES } from '../lib/shared.js'

const FEED_ID = 'https://feed0.example.com/atom.xml'
const ITEM_ID = 'item-0001'
const ROUND = '2026-10-11T09:00:00.000Z'

test('端点名字表非空、无重复、全为非空字符串', () => {
  // R3 02 新增 reorderFeeds 端点：28 → 29；R11 01 新增 settings：29 → 30；
  // R11 02 新增写端点 saveSettings：30 → 31；R8a 01 新增 testRsshub：31 → 32；
  // R9 02 新增 backfillHistory：32 → 33；R8b 03 新增只读的探索端点 exploreCatalog /
  // exploreBuildUrl：33 → 35；R7 01 新增 translateBatch：35 → 36；R7 02 新增可用性探测
  // translateInfo：36 → 37；R15 01 新增实例池读写 rsshubSettings / saveRsshubSettings：37 → 39；
  // R15 08 新增精选源包读写 sourcePack / saveSourcePack：39 → 41。
  // 这个数字是「端点表变更必须显形」的判据本身。
  assert.equal(ENDPOINT_NAMES.length, 41)
  assert.equal(new Set(ENDPOINT_NAMES).size, 41)
  for (const name of ENDPOINT_NAMES) assert.equal(typeof name, 'string')
})

/**
 * 装配一个**真实** dispatch：临时目录里的 config.json + 内存 SQLite store。
 * overrides：ready（造 not-ready）· refreshNow（避免出网）· items（预置条目 id）。
 */
function makeDispatch(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rss-registry-'))
  const db = openDatabase(':memory:')
  migrateSchema(db)
  const feeds = {}
  for (const id of [FEED_ID]) feeds[id] = { url: id, title: '源 0', folder: overrides.folder, ...(overrides.feedRecord ?? {}) }
  writeConfigFile(join(dir, 'config.json'), { version: 1, feeds })
  const store = createSqliteStore(db, join(dir, 'config.json'))
  const insert = db.prepare(
    'INSERT INTO items (id, feed_id, title, link, published_at, fetched_at, starred)'
    + ' VALUES (?, ?, ?, ?, ?, ?, 0)',
  )
  for (const id of overrides.items ?? []) {
    insert.run(id, FEED_ID, '标题 ' + id, 'https://site.example/' + id, ROUND, ROUND)
  }
  const dispatch = createDispatch({
    config: Config({}),
    log: () => {},
    ready: overrides.ready ?? (() => store),
    refreshNow: overrides.refreshNow ?? (async () => ({ outcome: 'not-ready', attempted: 0, total: 0 })),
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
  })
  return {
    dispatch, store, db, dir,
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

test('注册表覆盖全部端点名字，不多不少', async () => {
  const { ENDPOINTS } = await import('../lib/endpoints.js')
  assert.deepEqual(Object.keys(ENDPOINTS).sort(), [...ENDPOINT_NAMES].sort())
})

test('unknown-endpoint：原型链上的名字与空名字都拒绝', async () => {
  const h = makeDispatch({ items: [ITEM_ID] })
  try {
    for (const name of ['constructor', 'toString', '__proto__', 'valueOf', '']) {
      const r = await h.dispatch(name, {})
      assert.equal(r.ok, false, '名字 ' + JSON.stringify(name) + ' 必须被拒绝')
      assert.equal(r.error.code, 'unknown-endpoint', '名字 ' + JSON.stringify(name) + ' 的错误码')
    }
  } finally { h.cleanup() }
})

test('not-ready 先于 unknown-endpoint：未就绪时任何名字都回 not-ready', async () => {
  const h = makeDispatch({ ready: () => undefined })
  try {
    for (const name of ['overview', 'constructor', '不存在的名字']) {
      const r = await h.dispatch(name, {})
      assert.equal(r.ok, false)
      assert.equal(r.error.code, 'not-ready', '未就绪时 ' + name + ' 必须先撞 not-ready')
    }
  } finally { h.cleanup() }
})

test('carriesAccount：标读回包必带 unread 与 perFeedUnread（守恒）', async () => {
  const h = makeDispatch({ items: [ITEM_ID] })
  try {
    const r = await h.dispatch('markRead', { itemIds: [ITEM_ID] })
    assert.equal(r.ok, true)
    assert.equal(r.value.changed, 1)
    assert.equal(r.value.unread, 0, '标读后总未读归零')
    assert.equal(r.value.perFeedUnread[FEED_ID], 0, '每源账目必须一并下发')
  } finally { h.cleanup() }
})

// ── 五个零覆盖端点的金标准（搬运前记录，搬运后必须一字不差）────────────────────

test('金标准：opmlExport 回包形状', async () => {
  const h = makeDispatch()
  try {
    const r = await h.dispatch('opmlExport', {})
    assert.equal(r.ok, true)
    assert.equal(r.value.feedCount, 1)
    assert.match(r.value.opml, /xmlUrl/)
  } finally { h.cleanup() }
})

test('金标准：removeFeed 的两个失败码与文案', async () => {
  const h = makeDispatch()
  try {
    const empty = await h.dispatch('removeFeed', {})
    assert.equal(empty.ok, false)
    assert.equal(empty.error.code, 'bad-request')
    assert.match(empty.error.message, /removeFeed 需要 url/)
    const missing = await h.dispatch('removeFeed', { url: 'https://nope.example.com/x.xml' })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'not-found')
    assert.match(missing.error.message, /订阅不存在：/)
  } finally { h.cleanup() }
})

test('金标准：toggleStar 回包含 starred 且翻转', async () => {
  const h = makeDispatch({ items: [ITEM_ID] })
  try {
    const on = await h.dispatch('toggleStar', { itemId: ITEM_ID })
    assert.equal(on.ok, true)
    assert.equal(on.value.starred, true)
    const off = await h.dispatch('toggleStar', { itemId: ITEM_ID })
    assert.equal(off.value.starred, false)
    const missing = await h.dispatch('toggleStar', { itemId: 'nope' })
    assert.equal(missing.error.code, 'not-found')
  } finally { h.cleanup() }
})

test('金标准：opmlImport 的空文本失败码与「解析出 0 订阅」的成功回包（不出网）', async () => {
  const h = makeDispatch()
  try {
    const empty = await h.dispatch('opmlImport', { opml: '   ' })
    assert.equal(empty.ok, false)
    assert.equal(empty.error.code, 'bad-request')
    assert.match(empty.error.message, /opmlImport 需要 opml 文本/)
    // 不是 OPML：parseOpml 回 0 订阅 + 一条 skipped，端点应当照常 ok（坏输入不抛错）
    const notOpml = await h.dispatch('opmlImport', { opml: '<not-opml/>' })
    assert.equal(notOpml.ok, true)
    assert.equal(notOpml.value.added, 0)
    assert.equal(notOpml.value.existed, 0)
    assert.equal(notOpml.value.accepted.length, 0)
    assert.equal(notOpml.value.skipped.length, 1)
  } finally { h.cleanup() }
})

test('金标准：addFeed 的非法 URL 走 ok 的 failed 数组（不出网）', async () => {
  const h = makeDispatch()
  try {
    const r = await h.dispatch('addFeed', { url: '' })
    assert.equal(r.ok, true, '校验失败不是信封失败——客户端靠 failed 数组展示原因')
    assert.equal(r.value.added, 0)
    assert.equal(r.value.failed.length, 1)
    assert.equal(r.value.failed[0].reason, '不是合法 URL')
  } finally { h.cleanup() }
})
// ── M4 01：发现（只发现、不订阅）────────────────────────────────────────

/**
 * 发现的**零写入**判据：回候选之后，订阅表与 config.json 都必须一个字节都没变。
 *
 * 为什么要在端点层钉：discoverCandidates 本身不接 store（结构上就写不了），但「发现」最容易
 * 被后来者顺手接成「顺便帮你把第一个候选订上」。那条改动的后果是「取消」变成事后回滚，
 * 而回滚会丢用户已有数据 —— 这里直接用字节比对把它挡住。
 *
 * 出网用桩：地址故意挑**公网字面量**（不触发 DNS），fetch 换成回固定页面的桩。
 */
test('金标准：discoverFeeds 回候选但不写任何订阅（store 与 config.json 都不变）', async () => {
  const h = makeDispatch()
  const { readFileSync: read } = await import('node:fs')
  const configPath = join(h.dir, 'config.json')
  const before = read(configPath, 'utf8')
  const feedsBefore = h.store.listFeeds()
  const realFetch = globalThis.fetch
  const page = '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>'
  const rss = '<?xml version="1.0"?><rss version="2.0"><channel><title>远端的源</title>'
    + '<item><title>a</title><link>https://ex.test/a</link><guid>g1</guid></item></channel></rss>'
  globalThis.fetch = async (url) => new Response(String(url).endsWith('/feed.xml') ? rss : page, { status: 200 })
  try {
    const r = await h.dispatch('discoverFeeds', { url: 'http://93.184.216.34/' })
    assert.equal(r.ok, true)
    assert.deepEqual(r.value.candidates.map((candidate) => candidate.url), ['http://93.184.216.34/feed.xml'])
    assert.equal(r.value.candidates[0].title, '远端的源', '标题取的是 feed 自己声明的那个')
    assert.deepEqual(r.value.warnings, [])
    assert.deepEqual(h.store.listFeeds(), feedsBefore, '发现阶段不许写订阅表')
    assert.equal(read(configPath, 'utf8'), before, '发现阶段不许改写 config.json（一个字节都不许）')
  } finally {
    globalThis.fetch = realFetch
    h.cleanup()
  }
})

test('金标准：discoverFeeds 的空与非法输入（不出网）', async () => {
  const h = makeDispatch()
  try {
    const empty = await h.dispatch('discoverFeeds', { url: '   ' })
    assert.equal(empty.ok, false)
    assert.equal(empty.error.code, 'bad-request')
    assert.match(empty.error.message, /discoverFeeds 需要 url/)
    const bad = await h.dispatch('discoverFeeds', { url: 'not a url' })
    assert.equal(bad.ok, true, '用户输入问题走 warnings，不是信封失败')
    assert.deepEqual(bad.value.candidates, [])
    assert.equal(bad.value.warnings.length, 1)
    assert.match(bad.value.warnings[0].reason, /不是合法 URL/)
  } finally { h.cleanup() }
})

// ── M4 02：订阅健康与本轮刷新统计 ──────────────────────────────────────

test('M4 02：overview 透出每源健康字段（最近尝试/上次成功/原因/连败次数），但不带本轮统计', async () => {
  const h = makeDispatch({
    feedRecord: {
      lastFetchedAt: '2026-11-13T09:00:00.000Z',
      lastAttemptedAt: '2026-11-13T10:00:00.000Z',
      lastFailure: 'HTTP 502',
      failureCount: 2,
    },
  })
  try {
    const r = await h.dispatch('overview', {})
    assert.equal(r.ok, true)
    const feed = r.value.feeds[0]
    assert.deepEqual(
      { lastAttemptedAt: feed.lastAttemptedAt, lastFetchedAt: feed.lastFetchedAt, lastFailure: feed.lastFailure, failureCount: feed.failureCount },
      { lastAttemptedAt: '2026-11-13T10:00:00.000Z', lastFetchedAt: '2026-11-13T09:00:00.000Z', lastFailure: 'HTTP 502', failureCount: 2 },
      '源级的四个健康字段必须原样透出（客户端据此算状态与「次数未知」）',
    )
    assert.equal(r.value.refreshed, false, 'overview 恒不发起抓取')
    assert.equal(r.value.refresh, undefined, 'overview 不带「本轮」统计：那属于 refresh 端点')
  } finally { h.cleanup() }
})

test('M4 02：refresh 回本轮 X/Y 与原因；被节流时 X=0 但分母仍是订阅数', async () => {
  const ran = makeDispatch({ refreshNow: async () => ({ outcome: 'ran', attempted: 2, total: 5 }) })
  try {
    const r = await ran.dispatch('refresh', {})
    assert.equal(r.ok, true)
    assert.equal(r.value.refreshed, true, '真抓了 ⇒ refreshed 为真（既有字段语义不变）')
    assert.deepEqual(r.value.refresh, { outcome: 'ran', attempted: 2, total: 5 }, 'X/Y 原样回给界面')
  } finally { ran.cleanup() }

  const throttled = makeDispatch({ refreshNow: async () => ({ outcome: 'throttled', attempted: 0, total: 5, waitMs: 125000 }) })
  try {
    const r = await throttled.dispatch('refresh', {})
    assert.equal(r.value.refreshed, false, '没发起 ⇒ refreshed 仍是假')
    assert.equal(r.value.refresh.outcome, 'throttled')
    assert.equal(r.value.refresh.attempted, 0, '一个请求都没发 ⇒ X=0')
    assert.equal(r.value.refresh.total, 5, '分母照样是订阅数（0/0 会被读成「订阅表空了」）')
    assert.equal(r.value.refresh.waitMs, 125000, '还要等多久必须能说出口')
  } finally { throttled.cleanup() }
})

// ── 客户端接缝（计划 Task 5）────────────────────────────────────────────

/**
 * 端点名字面量不许散落在组件里。
 *
 * 为什么不是「组件里不许出现端点名字面量」：store.load('overview'|'refresh') 是合法的（load 的
 * 形参本就是这两个），而 'article' 在组件里是**视图名**不是端点名（index.tsx:352/357/460）。
 * 真正的失效模式是**绕过 store 直连通道**：callRpc 只在 store.ts 内定义、未导出，组件拿不到。
 */
test('客户端组件不许绕过 store 直调端点通道', () => {
  const src = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  assert.equal(/callRpc\s*\(/.test(src), false, '组件直调 callRpc 会让端点的类型保护失效')
  assert.equal(/fetch\(\s*ROUTE_PATH/.test(src), false, '组件直接 fetch 路由会绕过统一信封解析')
})

// 类型层的守卫归 typecheck（AGENTS.md:50：测试钉行为，不钉实现文本）。
// 此处**刻意不**断言 `callRpc(endpoint: Endpoint` 的源码形态：那种断言抓不到行为、
// 却会在无害重构（改泛型名/换行）时假红，逼后来者改断言。代价见 ledger 的 Task 8 Ruling。})
// ── carriesAccount 声明的判据（终审 I1）────────────────────────────────
/**
 * 判据覆盖「声明」本身，而不只是「回包形状」。
 *
 * 为什么两条都要有（终审实测的反例）：把 toggleStar / toggleKeepUnread 的 `carriesAccount: true`
 * 各删一行，本轮 375 条用例**全部通过** —— 也就是说「横切不变量收成一处声明」这个卖点，
 * 当时只在 3/5 处可被观测。静态那条钉住「标记集合恰好是这 5 个」，动态那条钉住「标了就必须带」。
 */
const CARRIES_ACCOUNT_PAYLOADS = {
  markRead: { itemIds: [ITEM_ID] },
  unmarkRead: { itemIds: [ITEM_ID] },
  cleanup: {},
  toggleStar: { itemId: ITEM_ID },
  toggleKeepUnread: { itemId: ITEM_ID },
}

test('carriesAccount：标记集合恰好是那 5 个端点（声明本身有判据）', async () => {
  const { ENDPOINTS } = await import('../lib/endpoints.js')
  const marked = Object.entries(ENDPOINTS)
    .filter(([, spec]) => spec.carriesAccount === true)
    .map(([name]) => name)
    .sort()
  assert.deepEqual(marked, Object.keys(CARRIES_ACCOUNT_PAYLOADS).sort(),
    '标记集合变了：漏标 ⇒ 幽灵未读会静默出现（左栏各源之和 ≠ 顶栏总数）；多标 ⇒ 回包白带账目')
})

test('carriesAccount：每个标记的端点走成功路径都带回未读账', async () => {
  for (const [name, payload] of Object.entries(CARRIES_ACCOUNT_PAYLOADS)) {
    const h = makeDispatch({ items: [ITEM_ID] })
    try {
      const r = await h.dispatch(name, payload)
      assert.equal(r.ok, true, name + ' 应当成功（夹具已就位：一个源 + 一条条目）')
      assert.equal(typeof r.value.unread, 'number', name + ' 的回包必须带 unread')
      assert.equal(typeof r.value.perFeedUnread, 'object', name + ' 的回包必须带 perFeedUnread')
      assert.ok(r.value.perFeedUnread !== null && FEED_ID in r.value.perFeedUnread,
        name + ' 的每源账目必须以 feeds 表为键域（0 未读的源也留键）')
    } finally { h.cleanup() }
  }
})
test('overview 下发既有订阅文件夹和权威逐源未读数', async () => {
  const h = makeDispatch({ items: [ITEM_ID, 'item-0002'], folder: '技术/工具' })
  try {
    const result = await h.dispatch('overview', {})
    assert.equal(result.ok, true)
    assert.equal(result.value.feeds[0].folder, '技术/工具')
    assert.equal(result.value.perFeedUnread[FEED_ID], 2)
  } finally { h.cleanup() }
})
