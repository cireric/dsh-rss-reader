/**
 * 显示窗的**宿主最高缝**：真 SQLite + 真 dispatch（ADR-0005）。
 *
 * 这里只钉窗口的**取数**半边（R1 01 票）：条目的窗内/窗外、半开边界、无日期排除、窗口进栅栏、
 * 范围组合、refresh、旧行为不变、坏入参。账目按窗与三联拆分是 02 / 04 票的判据，不在这里提前钉
 * —— 否则同一件事会有两套验收，改一处永远只红一半。
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

    const unwindowed = await ok(dispatch, 'refresh', {})
    assert.ok(idsOf(unwindowed).includes('ten-days-a'),
      '不带窗口的 refresh 仍是全部（旧行为）')
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
