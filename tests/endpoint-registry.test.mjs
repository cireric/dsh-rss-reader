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
  assert.equal(ENDPOINT_NAMES.length, 14)
  assert.equal(new Set(ENDPOINT_NAMES).size, 14)
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
  for (const id of [FEED_ID]) feeds[id] = { url: id, title: '源 0' }
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
    refreshNow: overrides.refreshNow ?? (async () => false),
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
  })
  return {
    dispatch, store, db,
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