/**
 * R3 01 + 02：订阅源顺序的唯一真相是 `config.json` 的 `feedOrder`。
 *
 * 01 的用例回答两类问题：把文件关掉再打开，顺序还是不是用户排的那一份；以及「没排过」的旧配置
 * 会不会被一次无关写入悄悄变成「排过」。02 加了写入口，于是补上端点面：回包是落盘后的有效顺序、
 * 未知 id/重复/未点名的归一、空数组不写盘、重启保持、旧续页游标仍可用、读态与未读账不变。
 * 派生规则是纯函数，所以先用边界把规则钉死，再用真 config.json + 真 SQLite store 钉读写两侧。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrateSchema } from '../lib/storage/db.js'
import { readConfigFile, writeConfigFile } from '../lib/storage/config-file.js'
import { createSqliteStore } from '../lib/store-sqlite.js'
import { createDispatch } from '../lib/endpoints.js'
import { Config } from '../lib/config.js'
import { deriveFeedOrder } from '../lib/feed-order.js'

const A = 'https://a.example/feed.xml'
const B = 'https://b.example/feed.xml'
const C = 'https://c.example/feed.xml'
const D = 'https://d.example/feed.xml'

/** 最小 FeedRecord：url 是必填项，其余字段与顺序判定无关。 */
const record = (id) => ({ url: id, title: id })
const feedsOf = (...ids) => Object.fromEntries(ids.map((id) => [id, record(id)]))

/** 每个用例一份独立目录：真文件 config.json + 真 SQLite 库（重启判据要能关掉再开）。 */
function fresh(tag, rawConfig, feeds = feedsOf(A, B, C)) {
  const dir = mkdtempSync(join(tmpdir(), 'rss-feed-order-' + tag + '-'))
  const configPath = join(dir, 'config.json')
  if (rawConfig !== undefined) writeFileSync(configPath, rawConfig)
  else writeConfigFile(configPath, { version: 1, feeds })
  const dbPath = join(dir, 'rss.db')
  const db = openDatabase(dbPath)
  migrateSchema(db)
  const ctx = { dir, configPath, dbPath, db, open: true, store: createSqliteStore(db, configPath) }
  return ctx
}

/** 模拟「插件重启」：关连接、重开同一个库与同一份配置。 */
function reopen(ctx) {
  ctx.db.close()
  ctx.open = false
  ctx.db = openDatabase(ctx.dbPath)
  migrateSchema(ctx.db)
  ctx.open = true
  ctx.store = createSqliteStore(ctx.db, ctx.configPath)
  return ctx.store
}

function dispose(ctx) {
  // 不写空 catch：关闭失败必须让人看见（AGENTS.md 的硬约束）。
  if (ctx.open) {
    ctx.db.close()
    ctx.open = false
  }
  rmSync(ctx.dir, { recursive: true, force: true })
}

const idsOf = (entries) => entries.map(([feedId]) => feedId)
const rawConfigWith = (feeds, extra = {}) => JSON.stringify({ version: 1, feeds, ...extra }, null, 2) + '\n'

test('派生：已列出的按数组序，未列出的按 feeds 键序追加；未知 id 与空串丢弃，重复保首次', () => {
  const feeds = feedsOf(A, B, C, D)
  assert.deepEqual(deriveFeedOrder([C, A], feeds), [C, A, B, D], '已列出的顺序优先，其余按 feeds 键序追加')
  assert.deepEqual(deriveFeedOrder([C, 'missing', A, C, ''], feeds), [C, A, B, D], '未知/空串丢弃，重复保首次')
  assert.deepEqual(deriveFeedOrder(undefined, feeds), [A, B, C, D], '没配置 ⇒ 键序')
  assert.deepEqual(deriveFeedOrder([], feeds), [A, B, C, D], '空数组 ⇒ 键序（明确没有排过）')
  assert.deepEqual(deriveFeedOrder(['missing'], feeds), [A, B, C, D], '全是未知 id ⇒ 键序，不丢源')
  assert.deepEqual(deriveFeedOrder([B], {}), [], '没有源 ⇒ 空')
})

test('手改 feedOrder（故意与键序不同）后：读入与关掉重开都按它，且读取不改写文件', () => {
  const raw = rawConfigWith(feedsOf(A, B, C), { feedOrder: [C, A] })
  const ctx = fresh('read', raw)
  try {
    assert.deepEqual(idsOf(ctx.store.listFeeds()), [C, A, B], '读侧按 feedOrder 派生')
    assert.deepEqual(readConfigFile(ctx.configPath).feedOrder, [C, A], '读出来的数组保持原样（不排序、不去重）')
    assert.equal(readFileSync(ctx.configPath, 'utf8'), raw, '读取不得顺手改写文件')

    const reopened = reopen(ctx)
    assert.deepEqual(idsOf(reopened.listFeeds()), [C, A, B], '关掉重开（同一份 config.json 重建 store）后顺序保持')
    assert.equal(readFileSync(ctx.configPath, 'utf8'), raw, '重开也不得改写文件')
  } finally { dispose(ctx) }
})

test('feedOrder 里的未知 id 与空串：读入不报错、派生丢弃、文件一字不改', () => {
  const raw = rawConfigWith(feedsOf(A, B, C), { feedOrder: ['', 'https://gone.example/feed.xml', C] })
  const ctx = fresh('unknown', raw)
  try {
    assert.deepEqual(idsOf(ctx.store.listFeeds()), [C, A, B], '只认 feeds 里真实存在的 id')
    assert.equal(readFileSync(ctx.configPath, 'utf8'), raw, '不认识的 id 不是格式错，读侧不改写文件')
  } finally { dispose(ctx) }
})

test('feedOrder: [] 是合法值：读入不报错，顺序回落到键序', () => {
  const raw = rawConfigWith(feedsOf(A, B), { feedOrder: [] })
  const ctx = fresh('empty-order', raw)
  try {
    assert.deepEqual(readConfigFile(ctx.configPath).feedOrder, [], '空数组必须原样读回（它是「明确没排过」）')
    assert.deepEqual(idsOf(ctx.store.listFeeds()), [A, B], '空数组 ⇒ 键序')
    assert.equal(readFileSync(ctx.configPath, 'utf8'), raw, '读取不改写')
  } finally { dispose(ctx) }
})

test('feedOrder 不是字符串数组：装载响亮失败、消息带路径，绝不返回空订阅', () => {
  const badValues = ['"a,b"', '[1,2]', '["https://a.example/feed.xml",1]', '{}', 'null']
  for (const bad of badValues) {
    const ctx = fresh('bad-' + Buffer.from(bad).toString('hex').slice(0, 8), rawConfigWith(feedsOf(A), { feedOrder: JSON.parse(bad) }))
    try {
      assert.throws(() => readConfigFile(ctx.configPath), (error) => {
        assert.match(error.message, /feedOrder/, '错误必须点名 feedOrder')
        assert.ok(error.message.includes(ctx.configPath), '错误消息必须带路径：' + error.message)
        return true
      }, '坏形状 ' + bad + ' 必须抛错')
      assert.throws(() => ctx.store.listFeeds(), /feedOrder/, 'store 读侧也必须抛，绝不返回空订阅')
    } finally { dispose(ctx) }
  }
})

test('旧配置没有 feedOrder：保存视图偏好 / 刷新写回 / 文件夹写入之后，文件里仍然没有这个键', async () => {
  const ctx = fresh('legacy', undefined, feedsOf(A, B))
  const gone = () => !Object.hasOwn(JSON.parse(readFileSync(ctx.configPath, 'utf8')), 'feedOrder')
  try {
    assert.ok(gone(), '前提：夹具写出来的旧配置没有 feedOrder')
    assert.deepEqual(idsOf(ctx.store.listFeeds()), [A, B], '没排过 ⇒ 键序')

    await ctx.store.saveViewPreferences({ navSelection: { kind: 'virtual' }, filter: 'unread', navVisible: false })
    assert.ok(gone(), '保存视图偏好不得把「没排过」物化成「排过」')

    await ctx.store.updateFeed(A, {
      kind: 'refresh-success', url: A, stamp: '2026-11-20T00:00:00.000Z', title: 'A',
    })
    assert.ok(gone(), '刷新写回 lastFetchedAt 也不得凭空生成 feedOrder')

    await ctx.store.createFolder('技术')
    assert.ok(gone(), '文件夹写入同样不得生成 feedOrder')
    assert.deepEqual(idsOf(ctx.store.listFeeds()), [A, B])
  } finally { dispose(ctx) }
})

test('已有 feedOrder：一次无关写入既不能丢掉它，也不能改变它', async () => {
  const raw = rawConfigWith(feedsOf(A, B, C), { feedOrder: [C, A] })
  const ctx = fresh('preserve', raw)
  try {
    await ctx.store.saveViewPreferences({ navSelection: { kind: 'virtual' }, filter: 'unread', navVisible: false })
    assert.deepEqual(readConfigFile(ctx.configPath).feedOrder, [C, A], '保存视图偏好必须原样带上顺序')
    await ctx.store.updateFeed(C, { kind: 'refresh-success', url: C, stamp: '2026-11-20T00:00:00.000Z', title: 'C' })
    assert.deepEqual(readConfigFile(ctx.configPath).feedOrder, [C, A], '刷新写回也必须原样带上顺序')
    assert.deepEqual(idsOf(ctx.store.listFeeds()), [C, A, B])
  } finally { dispose(ctx) }
})

test('文件夹成员数组保持键序（只当集合用）：源顺序只在 listFeeds 派生', () => {
  const raw = rawConfigWith(
    { [A]: { ...record(A), folder: '技术' }, [B]: { ...record(B), folder: '技术' }, [C]: record(C) },
    { feedOrder: [C, B, A] },
  )
  const ctx = fresh('folder-set', raw)
  try {
    assert.deepEqual(idsOf(ctx.store.listFeeds()), [C, B, A], '展示顺序跟随 feedOrder')
    assert.deepEqual(ctx.store.listFolders(), [{ name: '技术', feedIds: [A, B] }],
      'FolderView.feedIds 仍是 config.json 键序：它只当集合用，不是第二份展示顺序')
  } finally { dispose(ctx) }
})

// ── R3 02：写入口与落盘语义（端点面：真 SQLite store + 真 dispatch）──────────────────

/**
 * 端点级装配（照 tests/folder-endpoints.test.mjs）：临时目录里真 config.json + 真 SQLite store
 * + 真 dispatch。`ready` 读的是可变引用，`reopen()` 换代 store 之后同一个 dispatch 照常分发 ——
 * 「关掉重开顺序还在」因此是在端点上观察到的，而不只是 listFeeds 的局部结论。
 */
function makeEndpointRig({ feeds = feedsOf(A, B, C, D), feedOrder, rawConfig, maxItemsShown = 300 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rss-feed-order-endpoint-'))
  const configPath = join(dir, 'config.json')
  if (rawConfig !== undefined) writeFileSync(configPath, rawConfig)
  else writeConfigFile(configPath, { version: 1, feeds, ...(feedOrder === undefined ? {} : { feedOrder }) })
  const dbPath = join(dir, 'rss.db')
  let db = openDatabase(dbPath)
  migrateSchema(db)
  let store = createSqliteStore(db, configPath)
  const dispatch = createDispatch({
    config: Config({ maxItemsShown }),
    log: () => {},
    ready: () => store,
    refreshNow: async () => ({ outcome: 'not-ready', attempted: 0, total: 0 }),
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
  })
  return {
    dispatch,
    configPath,
    get store() { return store },
    reopen() {
      db.close()
      db = openDatabase(dbPath)
      migrateSchema(db)
      store = createSqliteStore(db, configPath)
      return store
    },
    cleanup() {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** 一条最小条目：recency 由 publishedAt 决定，读态字段按需覆盖。 */
const itemOf = (feedId, id, publishedAt, extra = {}) => ({
  feedId,
  title: id,
  link: 'https://site.example/' + id,
  fetchedAt: publishedAt,
  publishedAt,
  starred: false,
  ...extra,
})

test('reorderFeeds 端点：回包是落盘后的有效顺序；未知 id 丢弃、重复保首次、未点名的按当前顺序排末尾', async () => {
  const h = makeEndpointRig()
  try {
    let result = await h.dispatch('reorderFeeds', { ids: [C, A] })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(result.value, { feedOrder: [C, A, B, D] }, '回包是完整顺序，不是只回请求那一段')
    assert.equal('unread' in result.value, false, '排序不动未读账：回包不带 carriesAccount 的字段')

    let disk = readConfigFile(h.configPath)
    assert.deepEqual(disk.feedOrder, [C, A, B, D], '落盘的是完整 4 个 id')
    assert.deepEqual(Object.keys(disk.feeds), [A, B, C, D], 'feeds 的键序原样不动')

    const overview = await h.dispatch('overview', {})
    assert.equal(overview.ok, true, JSON.stringify(overview))
    assert.deepEqual(overview.value.feeds.map((feed) => feed.id), [C, A, B, D], '下一次 overview 按新顺序下发')

    result = await h.dispatch('reorderFeeds', { ids: [D, 'https://missing.example/feed.xml', D, B] })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(result.value, { feedOrder: [D, B, C, A] },
      '未知 id 忽略不拒绝；重复保首次；未点名的按当前有效顺序补齐')
    disk = readConfigFile(h.configPath)
    assert.deepEqual(disk.feedOrder, [D, B, C, A])
    assert.ok(!JSON.stringify(disk).includes('missing.example'), '回包与文件里都没有未知 id')
  } finally { h.cleanup() }
})

test('reorderFeeds：空数组与全是未知 id 都不写盘（文件逐字节不变、不新建键），回当前顺序', async () => {
  // 手写单行 JSON：任何一次写盘都会被 writeConfigFile 按缩进重排，字节比较因此能抓到「写过」。
  const raw = JSON.stringify({ version: 1, feeds: feedsOf(A, B, C) })
  const h = makeEndpointRig({ rawConfig: raw })
  try {
    assert.equal(Object.hasOwn(JSON.parse(raw), 'feedOrder'), false, '前提：夹具原本没有 feedOrder')
    assert.deepEqual(idsOf(h.store.listFeeds()), [A, B, C])

    let result = await h.dispatch('reorderFeeds', { ids: [] })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(result.value, { feedOrder: [A, B, C] }, '空数组：回当前有效顺序')
    assert.equal(readFileSync(h.configPath, 'utf8'), raw, '空数组不得写盘（也不物化 feedOrder）')

    result = await h.dispatch('reorderFeeds', { ids: ['https://missing.example/x'] })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(result.value, { feedOrder: [A, B, C] }, '全是未知 id：回当前有效顺序')
    assert.equal(readFileSync(h.configPath, 'utf8'), raw, '全是未知 id 同样不写盘')
  } finally { h.cleanup() }
})

test('reorderFeeds：关掉重开（同一份 config.json 重建 store）后顺序保持', async () => {
  const h = makeEndpointRig()
  try {
    const result = await h.dispatch('reorderFeeds', { ids: [D, C, B, A] })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(result.value, { feedOrder: [D, C, B, A] })

    const store = h.reopen()
    assert.deepEqual(idsOf(store.listFeeds()), [D, C, B, A], '重启后仍按 feedOrder 派生')
    const overview = await h.dispatch('overview', {})
    assert.deepEqual(overview.value.feeds.map((feed) => feed.id), [D, C, B, A], '重开后的 overview 同序')
    assert.deepEqual(readConfigFile(h.configPath).feedOrder, [D, C, B, A])
  } finally { h.cleanup() }
})

test('排序之后：排序前拿到的续页游标仍可用，翻完不重不漏（栅栏只认成员集合）', async () => {
  const feeds = {
    [A]: { ...record(A), folder: '技术' },
    [B]: { ...record(B), folder: '技术' },
    [C]: { ...record(C), folder: '技术' },
  }
  const h = makeEndpointRig({ feeds, maxItemsShown: 2 })
  try {
    const rows = [
      ['a1', A, '2026-11-06T00:00:00.000Z'],
      ['b1', B, '2026-11-05T00:00:00.000Z'],
      ['a2', A, '2026-11-04T00:00:00.000Z'],
      ['c1', C, '2026-11-03T00:00:00.000Z'],
      ['b2', B, '2026-11-02T00:00:00.000Z'],
      ['c2', C, '2026-11-01T00:00:00.000Z'],
    ]
    for (const [id, feedId, publishedAt] of rows) await h.store.saveItem(id, itemOf(feedId, id, publishedAt))

    const first = await h.dispatch('overview', { folder: '技术' })
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.deepEqual(first.value.items.map((row) => row.id), ['a1', 'b1'])
    assert.ok(first.value.nextCursor, '第一页必须给续页游标')

    // 排序前拿到的游标绑的是文件夹成员集合（键序 A,B,C 排序后哈希）；换顺序不改集合。
    const reordered = await h.dispatch('reorderFeeds', { ids: [C, A, B] })
    assert.equal(reordered.ok, true, JSON.stringify(reordered))
    assert.deepEqual(reordered.value, { feedOrder: [C, A, B] })

    const seen = first.value.items.map((row) => row.id)
    let cursor = first.value.nextCursor
    let guard = 0
    while (cursor !== undefined) {
      const page = await h.dispatch('overview', { folder: '技术', cursor })
      assert.equal(page.ok, true, '排序前的续页游标必须仍然可用：' + JSON.stringify(page))
      seen.push(...page.value.items.map((row) => row.id))
      cursor = page.value.nextCursor
      guard += 1
      assert.ok(guard < 10, '翻页必须有终点')
    }
    assert.deepEqual(seen, ['a1', 'b1', 'a2', 'c1', 'b2', 'c2'], '不重不漏，且仍是 recency 降序')
  } finally { h.cleanup() }
})

test('排序前后：条目流时间序、每条读态与每源未读数逐项不变', async () => {
  const h = makeEndpointRig({ feeds: feedsOf(A, B, C) })
  try {
    await h.store.saveItem('a-read', itemOf(A, 'a-read', '2026-11-05T00:00:00.000Z', { readAt: '2026-11-05T01:00:00.000Z' }))
    await h.store.saveItem('a-star', itemOf(A, 'a-star', '2026-11-04T00:00:00.000Z', { starred: true }))
    await h.store.saveItem('b-kept', itemOf(B, 'b-kept', '2026-11-03T00:00:00.000Z', { keptUnread: true }))
    await h.store.saveItem('c-unread', itemOf(C, 'c-unread', '2026-11-02T00:00:00.000Z'))
    await h.store.saveItem('b-read', itemOf(B, 'b-read', '2026-11-01T00:00:00.000Z', {
      readAt: '2026-11-01T02:00:00.000Z', starred: true,
    }))

    const stateOf = (overview) => Object.fromEntries(overview.items.map((row) => [row.id, {
      readAt: row.readAt, starred: row.starred, keptUnread: row.keptUnread,
    }]))
    const before = await h.dispatch('overview', {})
    assert.equal(before.ok, true, JSON.stringify(before))

    const reordered = await h.dispatch('reorderFeeds', { ids: [C, B, A] })
    assert.equal(reordered.ok, true, JSON.stringify(reordered))

    const after = await h.dispatch('overview', {})
    assert.deepEqual(after.value.items.map((row) => row.id), before.value.items.map((row) => row.id),
      '条目流仍是 recency 降序：排序只整理源，不动条目')
    assert.deepEqual(stateOf(after.value), stateOf(before.value),
      '每条条目的 readAt / starred / keptUnread 逐项不变')
    assert.deepEqual(after.value.perFeedUnread, before.value.perFeedUnread, '每源未读数逐项不变')
    assert.equal(after.value.unread, before.value.unread, '未读总数不变')
  } finally { h.cleanup() }
})
