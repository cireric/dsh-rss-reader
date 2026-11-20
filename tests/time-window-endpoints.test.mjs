/**
 * 显示窗的**宿主最高缝**：真 SQLite + 真 dispatch（ADR-0005）。
 *
 * 前半（R1 01 票）钉窗口的**取数**半边：条目的窗内/窗外、半开边界、无日期排除、窗口进栅栏、
 * 范围组合、refresh、旧行为不变、坏入参。后半（R1 02 票）钉**账目**半边：overview 与五个带账
 * 写端点在同一个窗口下回同一个数、窗内标读/撤销守恒、cleanup 的窗口入参。
 * 三联拆分（todayFrom → unreadSplit）在文件末尾的 R1 04 一节：它描述「全部未读」的构成，
 * 与窗口无关，所以两条判据（窗内账 / 三分恒等）在同一份夹具上各钉各的。
 *
 * 为什么必须真库：窗口的正确性全在 SQL 谓词与取数窗口上（`published_at IS NOT NULL` 那一半
 * 只在「无日期 + 抓取时间落在窗内」的截面显形）。内存桩的 listRecent 是我自己写的，
 * 测出来的是我的理解（docs/pitfalls.md 二、2.5 / 2.6）。
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

const FEED_A = 'https://a.example.com/atom.xml'
const FEED_B = 'https://b.example.com/atom.xml'

/** 读者浏览器算出来的窗口（客户端负责本地日 → 瞬间；宿主只按这两个串比较）。 */
const WINDOW_TODAY = { from: '2026-11-20T00:00:00.000Z', to: '2026-11-21T00:00:00.000Z' }
const WINDOW_3D = { from: '2026-11-18T00:00:00.000Z', to: '2026-11-21T00:00:00.000Z' }
const WINDOW_7D = { from: '2026-11-14T00:00:00.000Z', to: '2026-11-21T00:00:00.000Z' }

/**
 * 夹具：今天 2 条（含恰好等于 from 的一条）、恰好等于 to 的 1 条、2 天前 1 条、10 天前 2 条、
 * 无日期 1 条（** fetchedAt 恰好落在今天的窗内** —— 这一条是「用 recency 兜底」的探针）。
 */
const ROWS = [
  { id: 'today-noon', feedId: FEED_A, publishedAt: '2026-11-20T12:00:00.000Z', fetchedAt: '2026-11-20T12:01:00.000Z' },
  { id: 'today-from', feedId: FEED_A, publishedAt: '2026-11-20T00:00:00.000Z', fetchedAt: '2026-11-20T00:01:00.000Z' },
  { id: 'today-to', feedId: FEED_A, publishedAt: '2026-11-21T00:00:00.000Z', fetchedAt: '2026-11-21T00:01:00.000Z' },
  { id: 'two-days', feedId: FEED_A, publishedAt: '2026-11-18T09:00:00.000Z', fetchedAt: '2026-11-18T09:01:00.000Z' },
  { id: 'ten-days-a', feedId: FEED_A, publishedAt: '2026-11-10T09:00:00.000Z', fetchedAt: '2026-11-10T09:01:00.000Z' },
  { id: 'ten-days-b', feedId: FEED_B, publishedAt: '2026-11-09T09:00:00.000Z', fetchedAt: '2026-11-09T09:01:00.000Z' },
  { id: 'today-b', feedId: FEED_B, publishedAt: '2026-11-20T08:00:00.000Z', fetchedAt: '2026-11-20T08:01:00.000Z' },
  // 无发布日期的探针：抓取时间在今天的窗内，但任何窗口都不许放它进来。
  { id: 'no-date', feedId: FEED_A, publishedAt: null, fetchedAt: '2026-11-20T23:00:00.000Z' },
]

/**
 * 一整套夹具：真文件库 + 真 config.json（FEED_A 在「技术」文件夹、FEED_B 未分类）。
 * 标签经 store 的公开方法打（关联在 item_tags，不在 ItemRecord 上）。
 */
async function openFixture(tag = 'window-fixture') {
  const dir = mkdtempSync(join(tmpdir(), 'rss-window-' + tag + '-'))
  const db = openDatabase(':memory:')
  migrateSchema(db)
  const store = createSqliteStore(db, join(dir, 'config.json'))
  const insert = db.prepare(
    'INSERT INTO items (id, feed_id, title, link, published_at, fetched_at, starred) VALUES (?, ?, ?, ?, ?, ?, 0)',
  )
  db.exec('BEGIN')
  for (const row of ROWS) {
    insert.run(row.id, row.feedId, '标题 ' + row.id, 'https://site.example/' + row.id, row.publishedAt, row.fetchedAt)
  }
  db.exec('COMMIT')
  writeConfigFile(join(dir, 'config.json'), {
    version: 1,
    feeds: {
      [FEED_A]: { url: FEED_A, title: '源 A', folder: '技术' },
      [FEED_B]: { url: FEED_B, title: '源 B' },
    },
  })
  return { store, db, dir }
}

/** 取一次 overview / refresh，失败被当成空数据糊过去是最难查的一类假绿。 */
async function ok(dispatch, endpoint, payload) {
  const result = await dispatch(endpoint, payload)
  assert.equal(result.ok, true, endpoint + ' 应当成功：' + JSON.stringify(result))
  return result.value
}

const idsOf = (view) => view.items.map((entry) => entry.id)

test('窗口取数：只判 published_at 的半开区间；等于 from 的在、等于 to 的不在、无日期的不出现', async () => {
  const { store, db, dir } = await openFixture('half-open')
  try {
    const dispatch = createDispatch({
      config: Config({}),
      log: () => {},
      ready: () => store,
      refreshNow: async () => ({ outcome: 'ran', attempted: 2, total: 2 }),
      lastRefreshCompletedAt: () => undefined,
      articleAttempts: new Map(),
    })

    assert.deepEqual(idsOf(await ok(dispatch, 'overview', WINDOW_TODAY)),
      ['today-noon', 'today-b', 'today-from'],
      '今天：恰好等于 from 的 today-from 在窗内；等于 to 的 today-to 不在；无日期的不出现（它的 fetchedAt 在窗内）')

    assert.deepEqual(idsOf(await ok(dispatch, 'overview', WINDOW_3D)),
      ['today-noon', 'today-b', 'today-from', 'two-days'],
      '近 3 天含今天：2 天前的 two-days 在窗内；10 天前的两条不在')

    assert.deepEqual(idsOf(await ok(dispatch, 'overview', WINDOW_7D)),
      ['today-noon', 'today-b', 'today-from', 'two-days'],
      '近 7 天：10 天前的两条仍在窗外')

    assert.deepEqual(idsOf(await ok(dispatch, 'overview', { from: '2026-11-21T00:00:00.000Z', to: '2026-11-22T00:00:00.000Z' })),
      ['today-to'], '恰好等于昨天窗口 to 的那条，属于下一天的窗口 —— 半开区间只有一条归属')

    // 空窗不是错误，也不是「偷偷放宽」：就是空列表。
    assert.deepEqual(idsOf(await ok(dispatch, 'overview', { from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' })),
      [], '窗口没覆盖任何行 ⇒ 空列表（不许回落成全部）')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('窗口进栅栏：切档后的旧游标被响亮拒绝（两个方向），同窗口内正常续页', async () => {
  const { store, db, dir } = await openFixture('fence')
  try {
    const dispatch = createDispatch({
      config: Config({ maxItemsShown: 2 }),
      log: () => {},
      ready: () => store,
      refreshNow: async () => ({ outcome: 'ran', attempted: 2, total: 2 }),
      lastRefreshCompletedAt: () => undefined,
      articleAttempts: new Map(),
    })

    const windowed = await ok(dispatch, 'overview', WINDOW_TODAY)
    assert.deepEqual(idsOf(windowed), ['today-noon', 'today-b'], '前置条件：今天的第一页')
    assert.equal(typeof windowed.nextCursor, 'string')

    // 今天 → 全部：旧游标必须响亮失配，绝不静默从头开始
    const mismatchToAll = await dispatch('overview', { cursor: windowed.nextCursor })
    assert.equal(mismatchToAll.ok, false, '切回「全部」后拿今天的游标续页必须失败')
    assert.equal(mismatchToAll.error.code, 'bad-request')
    assert.match(mismatchToAll.error.message, /分页游标与当前范围不匹配/,
      '失败文案要让人知道是「范围变了」，不是「你传了垃圾」')

    // 今天 → 近 7 天：同样是另一个栅栏
    const mismatchTo7d = await dispatch('overview', { ...WINDOW_7D, cursor: windowed.nextCursor })
    assert.equal(mismatchTo7d.ok, false, '换档后旧游标必须失配')
    assert.equal(mismatchTo7d.error.code, 'bad-request')
    assert.match(mismatchTo7d.error.message, /分页游标与当前范围不匹配/)

    // 全部 → 今天：反过来同样失配
    const unwindowed = await ok(dispatch, 'overview', {})
    assert.equal(typeof unwindowed.nextCursor, 'string')
    const mismatchToToday = await dispatch('overview', { ...WINDOW_TODAY, cursor: unwindowed.nextCursor })
    assert.equal(mismatchToToday.ok, false, '把「全部」的游标带进「今天」必须失败（不许静默续页）')
    assert.equal(mismatchToToday.error.code, 'bad-request')
    assert.match(mismatchToToday.error.message, /分页游标与当前范围不匹配/)

    // 同一窗口内续页照常：第二页接在第一页之后，且仍在窗内
    const second = await ok(dispatch, 'overview', { ...WINDOW_TODAY, cursor: windowed.nextCursor })
    assert.deepEqual(idsOf(second), ['today-from'], '同窗口续页：不重不漏，第二页只剩 today-from')
    assert.equal(second.nextCursor, undefined, '到底时 nextCursor 缺省')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('同一窗口翻完所有页：不重不漏，末页 nextCursor 缺省', async () => {
  const { store, db, dir } = await openFixture('walk')
  try {
    const dispatch = createDispatch({
      config: Config({ maxItemsShown: 2 }),
      log: () => {},
      ready: () => store,
      refreshNow: async () => ({ outcome: 'ran', attempted: 2, total: 2 }),
      lastRefreshCompletedAt: () => undefined,
      articleAttempts: new Map(),
    })
    const pages = []
    let cursor
    for (let guard = 0; guard < 10; guard += 1) {
      const view = await ok(dispatch, 'overview', cursor === undefined ? WINDOW_3D : { ...WINDOW_3D, cursor })
      if (view.items.length > 0) pages.push(idsOf(view))
      if (view.nextCursor === undefined) break
      cursor = view.nextCursor
    }
    assert.deepEqual(pages, [['today-noon', 'today-b'], ['today-from', 'two-days']],
      '窗口内两页：先按 recency 降序，跨页不重不漏')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('窗口 + 文件夹 / 标签范围组合：回包只含该范围里窗内的行', async () => {
  const { store, db, dir } = await openFixture('scope')
  try {
    const dispatch = createDispatch({
      config: Config({}),
      log: () => {},
      ready: () => store,
      refreshNow: async () => ({ outcome: 'ran', attempted: 2, total: 2 }),
      lastRefreshCompletedAt: () => undefined,
      articleAttempts: new Map(),
    })

    // 文件夹「技术」只有一个成员（单源范围）：窗内的 A 行，且 A 自己的范围外行不许混进来。
    assert.deepEqual(idsOf(await ok(dispatch, 'overview', { folder: '技术', ...WINDOW_TODAY })),
      ['today-noon', 'today-from'], '文件夹 + 今天：只给该文件夹里窗内的行')

    const tag = await store.createTag('窗内')
    await store.setItemTags('today-noon', [tag.id])
    await store.setItemTags('ten-days-b', [tag.id]) // 窗外的那条也打上标：窗口必须先把它挡掉
    assert.deepEqual(idsOf(await ok(dispatch, 'overview', { tagId: tag.id, ...WINDOW_TODAY })),
      ['today-noon'], '标签 + 今天：只给该标签里窗内的行（窗外那条不许漏进来）')
    assert.deepEqual(idsOf(await ok(dispatch, 'overview', { tagId: tag.id })),
      ['today-noon', 'ten-days-b'], '不带窗口的同一条标签范围：两条都在（旧行为不变）')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('refresh 也接受窗口：回包 items 仍在窗内（不带窗口会悄悄回全部）', async () => {
  const { store, db, dir } = await openFixture('refresh')
  try {
    const dispatch = createDispatch({
      config: Config({}),
      log: () => {},
      ready: () => store,
      refreshNow: async () => ({ outcome: 'ran', attempted: 2, total: 2 }),
      lastRefreshCompletedAt: () => Date.now(),
      articleAttempts: new Map(),
    })

    const refreshed = await ok(dispatch, 'refresh', WINDOW_TODAY)
    assert.deepEqual(idsOf(refreshed), ['today-noon', 'today-b', 'today-from'],
      'refresh 带窗口：列表必须留在「今天」，不能悄悄把视图放回全部')
    assert.equal(refreshed.refreshed, true, '前置条件：这确实是一轮刷新回包')
    assert.equal(refreshed.unread, 3, 'refresh 的账目同样按窗（与同一页的 items 一致）')
    assert.equal(sumOf(refreshed.perFeedUnread), refreshed.unread, 'refresh 回包也守守恒式')

    const unwindowed = await ok(dispatch, 'refresh', {})
    assert.ok(idsOf(unwindowed).includes('ten-days-a'),
      '不带窗口的 refresh 仍是全部（旧行为）')
    assert.equal(unwindowed.unread, 8, '不带窗口的 refresh 回全量账（8 条全都未读）')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('不带窗口的旧行为逐字不变：缺省 / null 同义、旧游标继续有效、回包没有 unreadSplit', async () => {
  const { store, db, dir } = await openFixture('legacy')
  try {
    const dispatch = createDispatch({
      config: Config({ maxItemsShown: 2 }),
      log: () => {},
      ready: () => store,
      refreshNow: async () => ({ outcome: 'ran', attempted: 2, total: 2 }),
      lastRefreshCompletedAt: () => undefined,
      articleAttempts: new Map(),
    })

    const absent = await ok(dispatch, 'overview', {})
    const explicitNull = await ok(dispatch, 'overview', null)
    assert.deepEqual(explicitNull.items, absent.items, 'wire 形状 null 与缺省同义（浏览器通道会发 null）')
    assert.deepEqual(explicitNull.unread, absent.unread)
    assert.deepEqual(explicitNull.perFeedUnread, absent.perFeedUnread)
    assert.equal('unreadSplit' in absent, false, '不带窗口的回包不许长出 unreadSplit（旧形状逐字不变）')

    // 「全部」按 recency 降序：未来发布的 today-to 最前，其次是无日期条目（按 fetchedAt 归位）。
    assert.deepEqual(idsOf(absent), ['today-to', 'no-date'], '「全部」里无日期条目照常出现（按抓取时间归位）')

    // 旧游标（无窗口、无范围）在无窗口请求里继续有效 —— 升级瞬间浏览器里的游标不该作废。
    assert.equal(typeof absent.nextCursor, 'string')
    const next = await ok(dispatch, 'overview', { cursor: absent.nextCursor })
    assert.deepEqual(idsOf(next), ['today-noon', 'today-b'],
      '无窗口的旧游标必须照常续页（前缀一个字都不许变）')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('坏入参：五种窗口形态全部 bad-request，且不触达 store', async () => {
  /** 任何属性被读就炸：坏入参必须在 shape 层被拒，绝不许走到 handler。 */
  const EXPLODING_STORE = new Proxy({}, { get() { throw new Error('坏入参不该触达 store') } })
  const dispatch = createDispatch({
    config: Config({}),
    log: () => {},
    ready: () => EXPLODING_STORE,
    refreshNow: async () => ({ outcome: 'not-ready', attempted: 0, total: 0 }),
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
  })

  const bad = [
    ['缺 to', { from: WINDOW_TODAY.from }],
    ['缺 from', { to: WINDOW_TODAY.to }],
    ['from >= to', { from: WINDOW_TODAY.to, to: WINDOW_TODAY.from }],
    ['无毫秒', { from: '2026-11-20T00:00:00Z', to: WINDOW_TODAY.to }],
    ['带 +08:00 偏移', { from: '2026-11-20T00:00:00.000+08:00', to: WINDOW_TODAY.to }],
    ['只有日期', { from: '2026-11-20', to: WINDOW_TODAY.to }],
    ['今天起点不是时刻', { todayFrom: '2026-11-20' }],
  ]
  for (const endpoint of ['overview', 'refresh']) {
    for (const [label, payload] of bad) {
      const result = await dispatch(endpoint, payload)
      assert.equal(result.ok, false, endpoint + ' 放过了坏窗口（' + label + '）：' + JSON.stringify(payload))
      assert.equal(result.error.code, 'bad-request', endpoint + ' ' + label + ' 的失败码')
      assert.ok(Array.isArray(result.error.details.issues) && result.error.details.issues.length > 0,
        endpoint + ' ' + label + ' 必须给出字段路径')
    }
  }
})

/* ── 账目按窗（R1 02）──────────────────────────────────────────────────
 * 01 票只钉窗口取数；这里补的是**账目半边**：overview 与五个带账写端点在同一个窗口下
 * 回同一个数。夹具按 spec 验收的共用夹具：今天 3 条（2 未读 + 1 已读）、2 天前 1 条未读、
 * 10 天前 2 条未读、无日期 3 条（2 未读 + 1 已读）⇒ 全部 9 条 / 7 未读；今天 2 未读；
 * 近 3 天 / 近 7 天 3 未读。三联拆分（todayFrom）见文件末尾的 R1 04 一节。
 */

const FEED_C = 'https://c.example.com/atom.xml'

const ACCOUNT_ROWS = [
  { id: 'today-a', feedId: FEED_A, publishedAt: '2026-11-20T09:00:00.000Z', fetchedAt: '2026-11-20T09:01:00.000Z', readAt: null },
  { id: 'today-b', feedId: FEED_B, publishedAt: '2026-11-20T08:00:00.000Z', fetchedAt: '2026-11-20T08:01:00.000Z', readAt: null },
  { id: 'today-read', feedId: FEED_B, publishedAt: '2026-11-20T07:00:00.000Z', fetchedAt: '2026-11-20T07:01:00.000Z', readAt: '2026-11-20T07:30:00.000Z' },
  { id: 'two-days', feedId: FEED_A, publishedAt: '2026-11-18T09:00:00.000Z', fetchedAt: '2026-11-18T09:01:00.000Z', readAt: null },
  { id: 'ten-days-a', feedId: FEED_A, publishedAt: '2026-11-10T09:00:00.000Z', fetchedAt: '2026-11-10T09:01:00.000Z', readAt: null },
  { id: 'ten-days-b', feedId: FEED_B, publishedAt: '2026-11-09T09:00:00.000Z', fetchedAt: '2026-11-09T09:01:00.000Z', readAt: null },
  { id: 'no-date-a', feedId: FEED_A, publishedAt: null, fetchedAt: '2026-11-20T23:00:00.000Z', readAt: null },
  { id: 'no-date-b', feedId: FEED_B, publishedAt: null, fetchedAt: '2026-11-19T23:00:00.000Z', readAt: null },
  { id: 'no-date-read', feedId: FEED_B, publishedAt: null, fetchedAt: '2026-11-18T23:00:00.000Z', readAt: '2026-11-19T00:00:00.000Z' },
]

/** 与 openFixture 同形，但带已读态；三个源里 C 一条条目都没有（0 未读键的探针）。 */
async function openAccountFixture(tag = 'account') {
  const dir = mkdtempSync(join(tmpdir(), 'rss-account-' + tag + '-'))
  const db = openDatabase(':memory:')
  migrateSchema(db)
  const store = createSqliteStore(db, join(dir, 'config.json'))
  const insert = db.prepare(
    'INSERT INTO items (id, feed_id, title, link, published_at, fetched_at, read_at, starred)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
  )
  db.exec('BEGIN')
  for (const row of ACCOUNT_ROWS) {
    insert.run(row.id, row.feedId, '标题 ' + row.id, 'https://site.example/' + row.id,
      row.publishedAt, row.fetchedAt, row.readAt)
  }
  db.exec('COMMIT')
  writeConfigFile(join(dir, 'config.json'), {
    version: 1,
    feeds: {
      [FEED_A]: { url: FEED_A, title: '源 A', folder: '技术' },
      [FEED_B]: { url: FEED_B, title: '源 B' },
      [FEED_C]: { url: FEED_C, title: '源 C' },
    },
  })
  return { store, db, dir }
}

function accountDispatch(store) {
  return createDispatch({
    config: Config({}),
    log: () => {},
    ready: () => store,
    refreshNow: async () => ({ outcome: 'ran', attempted: 2, total: 2 }),
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
  })
}

const sumOf = (perFeedUnread) => Object.values(perFeedUnread).reduce((sum, count) => sum + count, 0)

test('overview 带窗账目：只算窗内未读，键域 = feeds 表（0 未读留键），各源之和 = 总未读', async () => {
  const { store, db, dir } = await openAccountFixture('overview')
  try {
    const dispatch = accountDispatch(store)
    const today = await ok(dispatch, 'overview', WINDOW_TODAY)
    assert.equal(today.unread, 2, '今天窗内未读 = today-a + today-b（today-read 已读不算）')
    assert.deepEqual(today.perFeedUnread, { [FEED_A]: 1, [FEED_B]: 1, [FEED_C]: 0 },
      '每源窗内账：C 一条条目都没有也必须留 0 键（键域 = feeds 表）')
    assert.equal(sumOf(today.perFeedUnread), today.unread, '各源之和 = 顶栏总未读')

    // 窗内账目必须与窗内列表里的未读行数一致（同一窗口、同一判据）。
    assert.equal(today.items.filter((entry) => entry.readAt === undefined).length, today.unread,
      '窗内总未读 = 窗内列表里的未读行数')

    const threeDays = await ok(dispatch, 'overview', WINDOW_3D)
    assert.equal(threeDays.unread, 3, '近 3 天含 2 天前那条')
    assert.deepEqual(threeDays.perFeedUnread, { [FEED_A]: 2, [FEED_B]: 1, [FEED_C]: 0 })

    // 范围只筛列表，不筛账目：顶栏 / 角标是全局视野（spec 验收 10）。
    const scoped = await ok(dispatch, 'overview', { folder: '技术', ...WINDOW_TODAY })
    assert.deepEqual(scoped.items.map((entry) => entry.id), ['today-a'], '前置条件：文件夹范围只剩 A 的窗内行')
    assert.equal(scoped.unread, 2, '账目是全局的，不随文件夹范围变')
    assert.deepEqual(scoped.perFeedUnread, { [FEED_A]: 1, [FEED_B]: 1, [FEED_C]: 0 })

    // 不带窗口 = 全量（旧行为）：7 未读 = 今天 2 + 更早 3 + 无日期 2
    const all = await ok(dispatch, 'overview', {})
    assert.equal(all.unread, 7, '「全部」是 7 未读（无日期未读也计入全量）')
    assert.deepEqual(all.perFeedUnread, { [FEED_A]: 4, [FEED_B]: 3, [FEED_C]: 0 })
    assert.equal(sumOf(all.perFeedUnread), all.unread)
    assert.equal('unreadSplit' in all, false, '不带 todayFrom 的旧请求不带 unreadSplit（旧形状逐字不变）')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 五个带账写端点：同一份窗口必须得到同一份窗内账；不带窗口回全量。
 * 每个端点用一份**新的**夹具，保证两次调用从同一初始态出发。
 */
const ACCOUNT_ENDPOINT_CASES = [
  { endpoint: 'markRead', payload: { itemIds: ['today-a'] }, window: { unread: 1, perFeed: { [FEED_A]: 0, [FEED_B]: 1, [FEED_C]: 0 } }, full: { unread: 6, perFeed: { [FEED_A]: 3, [FEED_B]: 3, [FEED_C]: 0 } }, split: { today: 1, earlier: 3, noDate: 2 } },
  { endpoint: 'unmarkRead', payload: { itemIds: ['today-read'] }, window: { unread: 3, perFeed: { [FEED_A]: 1, [FEED_B]: 2, [FEED_C]: 0 } }, full: { unread: 8, perFeed: { [FEED_A]: 4, [FEED_B]: 4, [FEED_C]: 0 } }, split: { today: 3, earlier: 3, noDate: 2 } },
  { endpoint: 'toggleStar', payload: { itemId: 'today-a' }, window: { unread: 2, perFeed: { [FEED_A]: 1, [FEED_B]: 1, [FEED_C]: 0 } }, full: { unread: 7, perFeed: { [FEED_A]: 4, [FEED_B]: 3, [FEED_C]: 0 } }, split: { today: 2, earlier: 3, noDate: 2 } },
  { endpoint: 'toggleKeepUnread', payload: { itemId: 'today-a' }, window: { unread: 2, perFeed: { [FEED_A]: 1, [FEED_B]: 1, [FEED_C]: 0 } }, full: { unread: 7, perFeed: { [FEED_A]: 4, [FEED_B]: 3, [FEED_C]: 0 } }, split: { today: 2, earlier: 3, noDate: 2 } },
  { endpoint: 'cleanup', payload: {}, window: { unread: 2, perFeed: { [FEED_A]: 1, [FEED_B]: 1, [FEED_C]: 0 } }, full: { unread: 7, perFeed: { [FEED_A]: 4, [FEED_B]: 3, [FEED_C]: 0 } }, split: { today: 2, earlier: 3, noDate: 2 } },
]

test('五个带账写端点：带窗回窗内账、不带窗回全量，各源之和恒等于总未读', async () => {
  for (const { endpoint, payload, window: windowedExpect, full: fullExpect } of ACCOUNT_ENDPOINT_CASES) {
    const windowedFixture = await openAccountFixture('endpoint-' + endpoint + '-window')
    try {
      const windowed = await ok(accountDispatch(windowedFixture.store), endpoint, { ...payload, ...WINDOW_TODAY })
      assert.equal(windowed.unread, windowedExpect.unread, endpoint + ' 带窗：总未读必须是窗内账，不许回全量')
      assert.deepEqual(windowed.perFeedUnread, windowedExpect.perFeed, endpoint + ' 带窗：每源窗内账')
      assert.equal(sumOf(windowed.perFeedUnread), windowed.unread, endpoint + ' 带窗：各源之和 = 总未读')
    } finally {
      windowedFixture.db.close()
      rmSync(windowedFixture.dir, { recursive: true, force: true })
    }

    const fullFixture = await openAccountFixture('endpoint-' + endpoint + '-full')
    try {
      const full = await ok(accountDispatch(fullFixture.store), endpoint, payload)
      assert.equal(full.unread, fullExpect.unread, endpoint + ' 不带窗：旧行为是回全量')
      assert.deepEqual(full.perFeedUnread, fullExpect.perFeed, endpoint + ' 不带窗：每源全量账')
      assert.equal(sumOf(full.perFeedUnread), full.unread, endpoint + ' 不带窗：各源之和 = 总未读')
    } finally {
      fullFixture.db.close()
      rmSync(fullFixture.dir, { recursive: true, force: true })
    }
  }
})

test('窗内标读 / 撤销：总数与所属源角标同步 ±1，全程不回全量', async () => {
  const { store, db, dir } = await openAccountFixture('mark-undo')
  try {
    const dispatch = accountDispatch(store)
    const before = await ok(dispatch, 'overview', WINDOW_TODAY)
    assert.equal(before.unread, 2, '前置条件：今天 2 条未读')

    const marked = await ok(dispatch, 'markRead', { itemIds: ['today-a'], ...WINDOW_TODAY })
    assert.equal(marked.unread, 1, '标掉一条今天的未读：窗内总数减 1，不许被打回全量 6')
    assert.equal(marked.perFeedUnread[FEED_A], 0, '所属源角标同步减 1')
    assert.equal(marked.perFeedUnread[FEED_B], 1, '别的源一格不动')
    assert.equal(sumOf(marked.perFeedUnread), marked.unread, '守恒式在回包里成立')

    const afterMark = await ok(dispatch, 'overview', WINDOW_TODAY)
    assert.equal(afterMark.unread, 1, '下一次 overview 仍是窗内账（没有回全量）')

    const undone = await ok(dispatch, 'unmarkRead', { itemIds: ['today-a'], ...WINDOW_TODAY })
    assert.equal(undone.unread, 2, '撤销后窗内总数加回 1')
    assert.equal(undone.perFeedUnread[FEED_A], 1, '所属源角标同步加回 1')
    assert.equal(sumOf(undone.perFeedUnread), undone.unread)

    const all = await ok(dispatch, 'overview', {})
    assert.equal(all.unread, 7, '全量账始终 7：窗内标读 / 撤销不许改变窗外账')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('账目只有一个算账处：overview 与写端点在同一个窗口 / 夹具上逐项相等', async () => {
  const { store, db, dir } = await openAccountFixture('same-account')
  try {
    const dispatch = accountDispatch(store)
    const overview = await ok(dispatch, 'overview', WINDOW_TODAY)
    const toggled = await ok(dispatch, 'toggleStar', { itemId: 'two-days', ...WINDOW_TODAY })
    assert.equal(toggled.unread, overview.unread, '写端点与 overview 的总未读必须来自同一个算账函数')
    assert.deepEqual(toggled.perFeedUnread, overview.perFeedUnread, '每源账目逐键相等')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cleanup 入参：仍接受 null / 缺省 / 带无关键的对象；坏窗口回 bad-request 且不触达 store', async () => {
  const { store, db, dir } = await openAccountFixture('cleanup-payload')
  try {
    const dispatch = accountDispatch(store)
    // 旧语义：零入参端点「接受并忽略 payload」；null / 缺省 / 多余键都不能变成坏入参。
    for (const payload of [undefined, null, {}, { anything: 1 }]) {
      const result = await ok(dispatch, 'cleanup', payload)
      assert.equal(result.unread, 7, '不带窗口的 cleanup 仍回全量账（' + JSON.stringify(payload) + '）')
    }
    const windowed = await ok(dispatch, 'cleanup', { ...WINDOW_TODAY, anything: 1 })
    assert.equal(windowed.unread, 2, 'cleanup 也接受窗口：回包按窗算账')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }

  // 坏窗口必须在入参层被拒 —— 用碰一下就炸的 store 证明没有触达 handler。
  const EXPLODING_STORE = new Proxy({}, { get() { throw new Error('坏入参不该触达 store') } })
  const dispatch = createDispatch({
    config: Config({}),
    log: () => {},
    ready: () => EXPLODING_STORE,
    refreshNow: async () => ({ outcome: 'not-ready', attempted: 0, total: 0 }),
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
  })
  for (const [label, payload] of [
    ['缺 to', { from: WINDOW_TODAY.from }],
    ['from >= to', { from: WINDOW_TODAY.to, to: WINDOW_TODAY.from }],
    ['今天起点不是时刻', { todayFrom: '2026-11-20' }],
  ]) {
    const result = await dispatch('cleanup', payload)
    assert.equal(result.ok, false, 'cleanup 放过了坏窗口（' + label + '）')
    assert.equal(result.error.code, 'bad-request')
    assert.ok(result.error.details.issues.length > 0, 'cleanup 的坏窗口必须给出字段路径')
  }
})

/* ── 三联拆分（R1 04）─────────────────────────────────────────────────
 * `unreadSplit` 描述**全部未读**的构成（今天 / 更早 / 无日期），与显示窗无关；请求给了
 * `todayFrom` 才回它。夹具沿用上面的 ACCOUNT_ROWS：全部 7 未读 = 今天 2 + 更早 3 + 无日期 2。
 */

/** 读者本地「今天」的起点；与 WINDOW_TODAY.from 同一刻（边界由客户端算，宿主只比较）。 */
const TODAY_FROM = WINDOW_TODAY.from

test('unreadSplit：三分只数未读，且与请求是否带窗口无关；不带 todayFrom 的 overview / refresh 没有这个字段', async () => {
  const { store, db, dir } = await openAccountFixture('split-shape')
  try {
    const dispatch = accountDispatch(store)

    const all = await ok(dispatch, 'overview', { todayFrom: TODAY_FROM })
    assert.deepEqual(all.unreadSplit, { today: 2, earlier: 3, noDate: 2 },
      '全部未读 7 = 今天 2 + 更早 3 + 无日期 2（已读的 today-read / no-date-read 都不算）')
    assert.equal(all.unread, 7, '前置：不带窗口时总未读是全量')
    assert.equal(all.unreadSplit.today + all.unreadSplit.earlier + all.unreadSplit.noDate, all.unread,
      '不带窗口时三数之和恒等于总未读')

    // 带窗口请求：unread 收窄，但 split 仍是「全部未读」的构成 —— 同一份。
    for (const window of [WINDOW_TODAY, WINDOW_3D]) {
      const windowed = await ok(dispatch, 'overview', { ...window, todayFrom: TODAY_FROM })
      assert.deepEqual(windowed.unreadSplit, all.unreadSplit, 'split 与窗口无关：带窗请求回同一份')
      assert.notEqual(windowed.unread, all.unread, '前置：窗口确实收窄了 unread（否则上一条断言没意义）')
    }

    const refreshed = await ok(dispatch, 'refresh', { todayFrom: TODAY_FROM })
    assert.deepEqual(refreshed.unreadSplit, all.unreadSplit, 'refresh 也把同一份 split 回下去')

    const legacyOverview = await ok(dispatch, 'overview', {})
    assert.equal('unreadSplit' in legacyOverview, false, '不带 todayFrom 的 overview 没有 unreadSplit（旧形状逐字不变）')
    const legacyRefresh = await ok(dispatch, 'refresh', {})
    assert.equal('unreadSplit' in legacyRefresh, false, '不带 todayFrom 的 refresh 没有 unreadSplit')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('五个带账写端点：带 todayFrom 回 unreadSplit（带窗口也是同一份），不带时没有这个字段', async () => {
  for (const { endpoint, payload, split } of ACCOUNT_ENDPOINT_CASES) {
    const windowedFixture = await openAccountFixture('split-endpoint-' + endpoint + '-windowed')
    try {
      const windowed = await ok(accountDispatch(windowedFixture.store), endpoint,
        { ...payload, ...WINDOW_TODAY, todayFrom: TODAY_FROM })
      assert.deepEqual(windowed.unreadSplit, split,
        endpoint + '：带窗口 + todayFrom 也回同一份「全部未读」三分')
    } finally {
      windowedFixture.db.close()
      rmSync(windowedFixture.dir, { recursive: true, force: true })
    }

    const plainFixture = await openAccountFixture('split-endpoint-' + endpoint + '-plain')
    try {
      const plain = await ok(accountDispatch(plainFixture.store), endpoint, { ...payload, todayFrom: TODAY_FROM })
      assert.deepEqual(plain.unreadSplit, split, endpoint + '：不带窗口也回同一份三分')
      assert.equal(sumOf(plain.perFeedUnread), plain.unread, endpoint + '：各源之和 = 总未读')
      assert.equal(split.today + split.earlier + split.noDate, plain.unread,
        endpoint + '：不带窗口时三分之和 = 总未读')
    } finally {
      plainFixture.db.close()
      rmSync(plainFixture.dir, { recursive: true, force: true })
    }

    const legacyFixture = await openAccountFixture('split-endpoint-' + endpoint + '-legacy')
    try {
      const legacy = await ok(accountDispatch(legacyFixture.store), endpoint, payload)
      assert.equal('unreadSplit' in legacy, false, endpoint + '：不带 todayFrom 的回包没有 unreadSplit')
    } finally {
      legacyFixture.db.close()
      rmSync(legacyFixture.dir, { recursive: true, force: true })
    }
  }
})

test('窗口档位标读：unread 减 1、unreadSplit.today 减 1，撤销后逐一恢复；无日期的 K 只数未读且已读后仍在「全部」里', async () => {
  const { store, db, dir } = await openAccountFixture('split-mark-undo')
  try {
    const dispatch = accountDispatch(store)
    const before = await ok(dispatch, 'overview', { ...WINDOW_TODAY, todayFrom: TODAY_FROM })
    assert.equal(before.unread, 2, '前置：今天窗内 2 条未读')
    assert.deepEqual(before.unreadSplit, { today: 2, earlier: 3, noDate: 2 })

    const marked = await ok(dispatch, 'markRead', { itemIds: ['today-a'], ...WINDOW_TODAY, todayFrom: TODAY_FROM })
    assert.equal(marked.unread, before.unread - 1, '窗内总未读减 1')
    assert.equal(sumOf(marked.perFeedUnread), marked.unread, '各源之和 = 总未读')
    assert.deepEqual(marked.unreadSplit, { today: 1, earlier: 3, noDate: 2 },
      'split 是「全部未读」的三分：只有 today 减 1，更早 / 无日期一格不动')

    const undone = await ok(dispatch, 'unmarkRead', { itemIds: ['today-a'], ...WINDOW_TODAY, todayFrom: TODAY_FROM })
    assert.equal(undone.unread, before.unread, '撤销后窗内总数恢复')
    assert.deepEqual(undone.unreadSplit, before.unreadSplit, '撤销后三分逐一恢复')

    // K 只数未读：把一条无日期未读标掉，K 减 1；已读条目仍留在「全部」列表里（可见但不再计数）。
    const markedNoDate = await ok(dispatch, 'markRead', { itemIds: ['no-date-a'], todayFrom: TODAY_FROM })
    assert.deepEqual(markedNoDate.unreadSplit, { today: 2, earlier: 3, noDate: 1 },
      '标掉一条无日期未读：K 2 → 1（已读的 no-date-read 本来就没算），今天那桶不动')
    const allAfter = await ok(dispatch, 'overview', {})
    assert.ok(allAfter.items.some((entry) => entry.id === 'no-date-a'),
      '已读的无日期条目仍在「全部」列表里可见（K 减 1 不等于条目消失）')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
