/**
 * 列表分页（keyset 游标）的宿主侧契约（2026-10-11 大规模存储任务 6）。
 *
 * 病象：overview 一次只回 maxItemsShown（默认 300）条，且没有任何「下一页」的入口 ——
 * 10 万行下第 301 条之后的条目在界面上**永远到不了**（spec §6.3）。
 *
 * 三条判据缺一不可：
 *  ① **游标编解码**：格式 `"<recency>|<id>"`；认不出必须**响亮拒绝**，不能静默当成「从头开始」
 *     —— 那会让翻页永远翻不完（每页都回第一页，界面无限追加同一批条目，用户只看到重复）；
 *  ② **跨页不重不漏**，特别是第 300 与第 301 条的边界。同 recency 打平是**常态**而不是边角
 *     （同一轮抓取的条目共享 fetchedAt），而行值比较 `(recency, id) < (?, ?)` 在这个形状下会
 *     重复 + 漏（spec §10.3 实测：返回 `a d e f`，正确是 `c d e f`）；
 *  ③ **nextCursor 缺省 = 到底**（客户端据此停止翻页）。
 *
 * 刻意用**真实 SQLite store + 真实端点**：分页的正确性全在 SQL 谓词与取数窗口上，内存桩测不到
 * —— 桩的 listRecent 是我自己写的，测出来的是我的理解（docs/pitfalls.md 二、2.5 / 2.6）。
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
import { createStore } from '../lib/store.js'
import { decodeCursor, encodeCursor } from '../lib/shared.js'
import { selectCleanup } from '../lib/retention.js'

const FEED_ID = 'https://feed0.example.com/atom.xml'
/** 一组条目共享的 recency：真实形状就是「同一轮抓取共享 fetchedAt」。 */
const ROUND_A = '2026-10-11T09:00:00.000Z'
const ROUND_B = '2026-10-11T08:00:00.000Z'
const ROUND_C = '2026-10-11T07:00:00.000Z'

/** 四位补零 ⇒ 字典序与数值序一致（页序断言读起来才是「第 n 条」）。 */
const itemIdOf = (index) => 'item-' + String(index).padStart(4, '0')

/**
 * 造一个真实库：`rows` 是 [{ id, recency }]，direct 插入（单事务直灌，量的是读路径）。
 * 刻意不逐条走 saveItem：300 条以上时那是 300 次事务，与判据无关。
 */
function freshRows(tag, rows) {
  const dir = mkdtempSync(join(tmpdir(), 'rss-paging-' + tag + '-'))
  const db = openDatabase(':memory:')
  migrateSchema(db)
  const store = createSqliteStore(db, join(dir, 'config.json'))
  const insert = db.prepare(
    'INSERT INTO items (id, feed_id, title, link, published_at, fetched_at, starred)'
    + ' VALUES (?, ?, ?, ?, ?, ?, 0)',
  )
  db.exec('BEGIN')
  for (const row of rows) {
    insert.run(row.id, FEED_ID, '标题 ' + row.id, 'https://site.example/post/' + row.id, row.recency, row.recency)
  }
  db.exec('COMMIT')
  writeConfigFile(join(dir, 'config.json'), { version: 1, feeds: { [FEED_ID]: { url: FEED_ID, title: '源 0' } } })
  return { store, db, dir }
}

/** EndpointDeps 的桩（形状照 src/endpoints.ts 的 EndpointDeps，不增减字段）。 */
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

/** 取一次 overview，顺手断言信封成功 —— 失败被当成空数据糊过去是最难查的一类假绿。 */
async function view(dispatch, payload) {
  const result = await dispatch('overview', payload)
  assert.equal(result.ok, true, 'overview 应当成功：' + JSON.stringify(result))
  return result.value
}

/** 逐页取完（最多 20 页兜底防死循环），返回每一页的 id。 */
async function walkPages(dispatch, payload) {
  const pages = []
  let cursor
  for (let guard = 0; guard < 20; guard += 1) {
    const page = await view(dispatch, cursor === undefined ? payload : { ...payload, cursor })
    const ids = page.items.map((entry) => entry.id)
    if (ids.length > 0) pages.push(ids)
    if (page.nextCursor === undefined) return { pages, last: page }
    cursor = page.nextCursor
  }
  throw new Error('翻页没有终点（nextCursor 一直存在）—— 客户端会无限追加同一批条目')
}

test('overview 分页：第 300 与第 301 条的边界不重不漏，末页没有 nextCursor', async () => {
  const { store, db, dir } = freshRows('boundary', Array.from({ length: 301 }, (_, i) => ({ id: itemIdOf(i), recency: ROUND_A })))
  try {
    // 默认 maxItemsShown = 300：这正是「第 301 条永远到不了」的那个数
    const dispatch = createDispatch(deps(store, Config({})))
    const first = await view(dispatch, {})
    assert.equal(first.items.length, 300, '首页按 maxItemsShown 截断')
    assert.equal(first.items[0].id, itemIdOf(0))
    assert.equal(typeof first.nextCursor, 'string',
      '还有第 301 条 ⇒ 必须给出续页入口；没有它，那一条在界面上永远到不了（本任务要修的缺陷本体）')

    const second = await view(dispatch, { cursor: first.nextCursor })
    assert.deepEqual(second.items.map((entry) => entry.id), [itemIdOf(300)],
      '第二页必须正好从第 301 条开始（多一条、少一条都是错了位）')
    assert.equal(second.nextCursor, undefined, '到底时 nextCursor 缺省 —— 客户端据此停止翻页')

    const seen = [...first.items, ...second.items].map((entry) => entry.id)
    assert.equal(new Set(seen).size, 301, '两页合起来必须是 301 个互异 id（不重不漏）')
    assert.ok(second.items[0].id > first.items[299].id, '续页首条必须排在首页末条之后（顺序不许回退）')

    // refresh 是「重头取第一页」：它不接受游标，也不许把上一次的边界带进来
    const result = await dispatch('refresh', { cursor: first.nextCursor })
    assert.equal(result.ok, true)
    assert.deepEqual(result.value.items.map((entry) => entry.id), first.items.map((entry) => entry.id),
      'refresh 必须从第一页重新开始，不受 payload 里的游标影响')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('overview 分页：页边界正好压在 recency 打平组上时不重不漏（同批抓取是常态）', async () => {
  // 3 组 recency × 每组 3 条，页大小 3 ⇒ 每一次翻页的边界都落在打平组内
  const rows = []
  for (const [group, recency] of [ROUND_A, ROUND_B, ROUND_C].entries()) {
    for (let i = 0; i < 3; i += 1) rows.push({ id: 'g' + group + '-i' + i, recency })
  }
  const expected = ['g0-i0', 'g0-i1', 'g0-i2', 'g1-i0', 'g1-i1', 'g1-i2', 'g2-i0', 'g2-i1', 'g2-i2']
  const { store, db, dir } = freshRows('ties', rows)
  try {
    const dispatch = createDispatch(deps(store, Config({ maxItemsShown: 3 })))
    const { pages } = await walkPages(dispatch, {})
    assert.deepEqual(pages, [expected.slice(0, 3), expected.slice(3, 6), expected.slice(6, 9)],
      '页边界压在打平点上：行值比较会返回重复页（spec §10.3 的 a d e f）')
    const flat = pages.flat()
    assert.deepEqual(flat, expected, '跨页必须与全序逐条相同（不重不漏）')
    assert.equal(new Set(flat).size, flat.length, '跨页不许重复')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('overview 续页：边界行随后被删掉也不影响翻页（游标是一对值，不是行引用）', async () => {
  // 清理/退订会在翻页期间删行；若续页依赖「边界行还在」就会静默丢页
  const rows = []
  for (const [group, recency] of [ROUND_A, ROUND_B, ROUND_C].entries()) {
    for (let i = 0; i < 3; i += 1) rows.push({ id: 'g' + group + '-i' + i, recency })
  }
  const { store, db, dir } = freshRows('deleted-boundary', rows)
  try {
    const dispatch = createDispatch(deps(store, Config({ maxItemsShown: 3 })))
    const first = await view(dispatch, {})
    assert.deepEqual(first.items.map((entry) => entry.id), ['g0-i0', 'g0-i1', 'g0-i2'])
    await store.deleteItem('g0-i2') // 边界那一行本身被删掉

    const second = await view(dispatch, { cursor: first.nextCursor })
    assert.deepEqual(second.items.map((entry) => entry.id), ['g1-i0', 'g1-i1', 'g1-i2'],
      '游标解出的 recency/id 是值，不依赖那一行还存在')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 旧实现（src/store.ts 的 createStore，站在存储域上）的同一个谓词。
 *
 * 为什么两处都要钉：Ruling P-7 把游标加在 **listRecent 这个接口**上 ⇒ 两份实现都得守同一条契约。
 * 只钉自持实现的话，两份谓词哪天分家（改了一处忘了另一处）不会有任何断言翻红 —— 本仓库的
 * selectCleanup 就是靠「SQL 是第二实现、有对账用例」这句话活下来的（见 store.ts 的契约注释）。
 * 生产早已是 createSqliteStore，但「不用的那份可以悄悄坏掉」不是一条能接受的约定。
 */
function legacyStoreWith(rows) {
  const items = new Map(rows.map((row) => [row.id, {
    feedId: FEED_ID, title: '标题 ' + row.id, link: 'https://site.example/post/' + row.id,
    publishedAt: row.recency, fetchedAt: row.recency, starred: false,
  }]))
  const tables = { feeds: new Map([[FEED_ID, { url: FEED_ID, title: '源 0' }]]), items, cursors: new Map() }
  const handle = (name) => ({
    get: (key) => tables[name].get(key),
    entries: () => [...tables[name].entries()][Symbol.iterator](),
    keys: () => [...tables[name].keys()][Symbol.iterator](),
    get size() { return tables[name].size },
    put: async (key, value) => { tables[name].set(key, value) },
    delete: async (key) => { tables[name].delete(key) },
    update: async (key, fn) => { const next = fn(tables[name].get(key)); tables[name].set(key, next); return next },
  })
  return createStore({ name: 'rss_reader', table: handle, global: { get: () => undefined, set: async () => {} } })
}

test('旧实现（createStore）：listRecent 的游标谓词与自持实现逐条同义', () => {
  const rows = []
  for (const [group, recency] of [ROUND_A, ROUND_B, ROUND_C].entries()) {
    for (let i = 0; i < 3; i += 1) rows.push({ id: 'g' + group + '-i' + i, recency })
  }
  const store = legacyStoreWith(rows)
  const expected = ['g0-i0', 'g0-i1', 'g0-i2', 'g1-i0', 'g1-i1', 'g1-i2', 'g2-i0', 'g2-i1', 'g2-i2']
  assert.deepEqual(store.listRecent(9).map(([id]) => id), expected, '不带游标 = 前缀，与 allItems 同序')

  const first = store.listRecent(3)
  assert.deepEqual(first.map(([id]) => id), expected.slice(0, 3), '前置条件：第一页')
  const last = first[first.length - 1][1]
  const boundary = { recency: last.publishedAt ?? last.fetchedAt, id: first[first.length - 1][0] }
  assert.deepEqual(store.listRecent(3, boundary).map(([id]) => id), expected.slice(3, 6),
    '续页必须严格排在边界之后（同 recency 内 id 升序）—— 与 SQL 侧那条谓词逐字同义')
  assert.deepEqual(store.listRecent(3, { recency: ROUND_C, id: 'g2-i2' }), [], '末页之后没有行')
})

test('游标编解码：格式 "<recency>|<id>"，认不出的必须返回 undefined（不许当成从头开始）', () => {
  const cursor = { recency: '2026-10-11T09:00:00.000Z', id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' }
  assert.equal(encodeCursor(cursor), cursor.recency + '|' + cursor.id, 'wire 形状就是 "<recency>|<id>"')
  assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor, '往返必须逐字段相同')

  // 认不出的形状一律 undefined：调用方据此响亮拒绝，而不是悄悄回第一页
  for (const bad of ['', 'nope', '|abc', 'abc|', '|', '2026-10-11T09:00:00.000Z']) {
    assert.equal(decodeCursor(bad), undefined, '认不出的游标必须被拒绝：' + JSON.stringify(bad))
  }
  // ⚠️ 上面那几个**只能**证明「切不出两段」被挡住了：它们全都先被分隔符/空白/空 id 那三道闸拦下，
  // 于是 recency 的校验（ISO_INSTANT）即使整个删掉也照样绿 —— 那不是覆盖，是巧合（变异门槛实测：
  // 「游标不校验形状」那条变异**幸存**过一轮，就是这几个输入造成的假绿）。
  // 下面这三个只可能被 recency 校验拒绝：分隔符合法、两端无空白、id 非空，唯独时间戳不成立。
  for (const bad of [
    'not-an-instant|a1b2c3',                 // 根本不是时刻
    '2026-10-11T09:00:00|a1b2c3',            // 缺时区：本插件所有写入口都产 UTC（见 decodeCursor 注释）
    '2026-13-45T99:99:99.000Z|a1b2c3',       // 形状对、日期不存在（ISO_INSTANT 放行，Date.parse 兜住）
  ]) {
    assert.equal(decodeCursor(bad), undefined,
      'recency 不是合法时刻时必须拒绝（只靠分隔符那几道闸挡不住这一族）：' + JSON.stringify(bad))
  }
  // 同一个道理的另一面：合法时刻必须照常通过，别把闸门收得连正常游标都挡了
  assert.deepEqual(decodeCursor('2026-10-11T09:00:00.000Z|a1b2c3'),
    { recency: '2026-10-11T09:00:00.000Z', id: 'a1b2c3' })

  // 分隔符取**第一个** |：recency 的取值域（ISO-8601）不含它，其余一律归 id —— 切法是唯一确定的
  assert.deepEqual(decodeCursor('2026-10-11T09:00:00.000Z|a|b'),
    { recency: '2026-10-11T09:00:00.000Z', id: 'a|b' })
})

test('overview：游标认不出时响亮拒绝（bad-request），绝不静默从头开始', async () => {
  const { store, db, dir } = freshRows('bad-cursor', [{ id: itemIdOf(0), recency: ROUND_A }])
  try {
    const dispatch = createDispatch(deps(store, Config({ maxItemsShown: 2 })))
    // 后两个只可能被 recency 的校验拒绝（见上一条用例的注：全被前几道闸挡下的输入会造成假绿）
    for (const cursor of ['nope', '', '|x', ' 2026-10-11T09:00:00.000Z|a', 'not-an-instant|a', '2026-13-45T99:99:99.000Z|a', 42, {}]) {
      const result = await dispatch('overview', { cursor })
      assert.equal(result.ok, false,
        '游标 ' + JSON.stringify(cursor) + ' 认不出就必须失败：静默回第一页会让翻页永远翻不完')
      assert.equal(result.error.code, 'bad-request', '失败码要说清是调用方传错了')
    }
    // 「没有游标」的表达是**缺席**（或 null），不是空串 —— 空串被上面那条挡住
    assert.equal((await dispatch('overview', {})).ok, true, '不带游标 = 第一页')
    assert.equal((await dispatch('overview', { cursor: null })).ok, true, 'null 与缺席同义')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
/**
 * ── 旧实现 ↔ 自持实现的**逐方法**同义性基线（2026-10-11 终检评审 G1）───────────────
 *
 * 病象：`createStore` 是「换实现之后旧行为还在不在」的对照物，但只有 `listRecent` 的游标谓词
 * 有一条对照用例 —— `unreadPerFeed` / `listCleanupCandidates` / `listArticleCacheEntries`
 * 各自只被钉在「与自己的桩一致」上。两份实现悄悄分家时没有任何断言会翻红，
 * 而生产早已是 createSqliteStore：坏掉的那份没人用，也就没人发现。
 *
 * 为什么钉得住：夹具里放齐三类行（受保护 / 可清理 / 带正文），两边的**同一份输入**各跑一遍，
 * 逐字段 deepEqual。判据是「结果」而不是「写法」——所以它同时挡住 SQLite 侧与旧侧的任何漂移。
 */
const FEED_EMPTY = 'https://empty.example.com/atom.xml'

/** 两套实现共用的输入。recency 两边都取 publishedAt ?? fetchedAt（这里两者同值，简化对照）。 */
const EQUIV_ROWS = [
  { id: 'old-plain', recency: '2020-01-01T00:00:00.000Z', readAt: '2026-10-01T00:00:00.000Z', summary: 'x'.repeat(10) },
  { id: 'old-starred', recency: '2020-01-01T00:00:00.000Z', readAt: '2026-10-01T00:00:00.000Z', starred: true, summary: 'y'.repeat(7) },
  { id: 'old-kept', recency: '2020-01-01T00:00:00.000Z', readAt: '2026-10-01T00:00:00.000Z', keptUnread: true },
  { id: 'old-with-body', recency: '2020-01-01T00:00:00.000Z', readAt: '2026-10-01T00:00:00.000Z',
    article: { fetchedAt: '2020-02-02T00:00:00.000Z', blocks: [{ kind: 'p', text: '正文' }, { kind: 'list', items: ['ab', 'c'] }] } },
  { id: 'new-read', recency: '2026-10-11T00:00:00.000Z', readAt: '2026-10-11T00:00:00.000Z' },
  { id: 'unread-1', recency: '2026-10-11T09:00:00.000Z' },
  { id: 'unread-2', recency: '2026-10-11T08:00:00.000Z', article: { fetchedAt: '2026-10-11T08:30:00.000Z', blocks: [{ kind: 'p', text: '一二三' }] } },
  { id: 'orphan-1', feedId: 'https://gone.example.com/atom.xml', recency: '2026-10-11T07:00:00.000Z' },
]

/** 旧实现（createStore）的完整夹具：把每条记录按 ItemRecord 的形状放进域表。 */
function legacyStoreWithRecords(rows, feedIds) {
  const items = new Map(rows.map((row) => [row.id, {
    feedId: row.feedId ?? FEED_ID, title: '标题 ' + row.id, link: 'https://site.example/post/' + row.id,
    publishedAt: row.recency, fetchedAt: row.recency, starred: row.starred === true,
    ...(row.readAt === undefined ? {} : { readAt: row.readAt }),
    ...(row.keptUnread === undefined ? {} : { keptUnread: row.keptUnread }),
    ...(row.summary === undefined ? {} : { summary: row.summary }),
    ...(row.article === undefined ? {} : { article: row.article }),
  }]))
  const feeds = new Map(feedIds.map((id) => [id, { url: id, title: id }]))
  const tables = { feeds, items, cursors: new Map() }
  const handle = (name) => ({
    get: (key) => tables[name].get(key),
    entries: () => [...tables[name].entries()][Symbol.iterator](),
    keys: () => [...tables[name].keys()][Symbol.iterator](),
    get size() { return tables[name].size },
    put: async (key, value) => { tables[name].set(key, value) },
    delete: async (key) => { tables[name].delete(key) },
    update: async (key, fn) => { const next = fn(tables[name].get(key)); tables[name].set(key, next); return next },
  })
  return createStore({ name: 'rss_reader', table: handle, global: { get: () => undefined, set: async () => {} } })
}

/** 自持实现的同一份夹具：直灌 items + texts（单事务，量的是读路径）。 */
function sqliteStoreWithRecords(rows, feedIds) {
  const dir = mkdtempSync(join(tmpdir(), 'rss-equiv-'))
  const db = openDatabase(':memory:')
  migrateSchema(db)
  const store = createSqliteStore(db, join(dir, 'config.json'))
  const insertItem = db.prepare(
    'INSERT INTO items (id, feed_id, title, link, published_at, fetched_at, summary, read_at, starred, kept_unread)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const insertText = db.prepare(
    'INSERT INTO texts (item_id, body, revision, frameable, title, fetched_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  db.exec('BEGIN')
  for (const row of rows) {
    insertItem.run(row.id, row.feedId ?? FEED_ID, '标题 ' + row.id,
      'https://site.example/post/' + row.id, row.recency, row.recency,
      row.summary ?? null, row.readAt ?? null, row.starred === true ? 1 : 0, row.keptUnread === true ? 1 : 0)
    if (row.article !== undefined) {
      insertText.run(row.id, JSON.stringify(row.article.blocks),
        row.article.revision ?? null, null, row.article.title ?? null, row.article.fetchedAt)
    }
  }
  db.exec('COMMIT')
  const feeds = {}
  for (const id of feedIds) feeds[id] = { url: id, title: id }
  writeConfigFile(join(dir, 'config.json'), { version: 1, feeds })
  return { store, db, dir }
}

/** 只取两边共有的字段做对照，顺带按 id 排序 —— 顺序不是这条判据要钉的东西。 */
const candidatesOf = (rows) => rows
  .map(({ id, starred, kept, read, recency, articleChars, summaryChars }) =>
    ({ id, starred, kept, read, recency, articleChars, summaryChars }))
  .sort((a, b) => a.id.localeCompare(b.id))

test('逐方法同义性：listCleanupCandidates 的候选行与旧实现逐字段相等（两边都比判据之家更窄）', () => {
  const cutoff = '2026-01-01T00:00:00.000Z'
  const feedIds = [FEED_ID, FEED_EMPTY]
  const legacy = legacyStoreWithRecords(EQUIV_ROWS, feedIds)
  const { store, db, dir } = sqliteStoreWithRecords(EQUIV_ROWS, feedIds)
  try {
    const legacyRows = legacy.listCleanupCandidates(cutoff)
    const sqliteRows = store.listCleanupCandidates(cutoff)

    // ① 候选集两边**逐字段**相等 —— 且「保持未读」那条两边都被排除。
    //    （写这条时我原以为旧实现会把 kept 那条交出来 —— 实测它同样先按 !kept 过滤再跑判据，
    //      两边的口径本来就一致；断言在这里当场把那个错判暴露了，这正是逐方法对照的用处。）
    assert.deepEqual(candidatesOf(sqliteRows), candidatesOf(legacyRows),
      '候选行（含 articleChars / summaryChars）必须与旧实现逐字段相等 —— 两份实现分家时这条要翻红')

    // ② 三类受保护的行两边都不进候选：星标、未读、与「保持未读」
    for (const id of ['old-starred', 'old-kept', 'new-read', 'unread-1']) {
      assert.equal(sqliteRows.some((row) => row.id === id), false, id + ' 不得进候选')
    }

    // ③ 与「判据之家」的原始集合对照：selectCleanup 单算会把「保持未读」也算进去 ——
    //    所以两份实现都必须比它更窄（SQL 谓词的第四项 / 旧实现的 filter(!kept)）。
    //    这条钉的是「更窄」这件事本身，而不是某一份实现的写法。
    const raw = { id: 'old-kept', starred: false, kept: true, read: true, recency: '2020-01-01T00:00:00.000Z' }
    assert.deepEqual(selectCleanup([raw], cutoff), ['old-kept'],
      '判据之家单独算会认为它可以清 —— 两份实现的候选集都必须比它更窄（多守「保持未读」）')

    // ④ **最终删除集**才是 cleanup 的实际效果：候选 ∩ selectCleanup —— 两边必须逐字相等
    const doomed = (rows) => selectCleanup(rows, cutoff).sort()
    assert.deepEqual(doomed(sqliteRows), doomed(legacyRows),
      '两边算出的最终删除集必须逐字相等（星标 / 保持未读都不许被动）')
    assert.deepEqual(doomed(sqliteRows), ['old-plain', 'old-with-body'], '实际该删的就是这两条')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('逐方法同义性：unreadPerFeed 与旧实现逐键相等（0 未读的源两边都留 0 值键）', () => {
  const feedIds = [FEED_ID, FEED_EMPTY]
  const legacy = legacyStoreWithRecords(EQUIV_ROWS, feedIds)
  const { store, db, dir } = sqliteStoreWithRecords(EQUIV_ROWS, feedIds)
  try {
    const expected = legacy.unreadPerFeed(feedIds)
    const actual = store.unreadPerFeed(feedIds)
    assert.deepEqual(actual, expected, '每源账目必须与旧实现逐键相等（含键域）')
    assert.deepEqual(actual, {
      [FEED_ID]: 2,
      [FEED_EMPTY]: 0,
    }, '前置条件：未读 = unread-1 / unread-2；已退订源的残留条目不进账、空源留 0 值键')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('逐方法同义性：listArticleCacheEntries 与旧实现逐条相等（只交出 { id, chars, fetchedAt }）', () => {
  const feedIds = [FEED_ID, FEED_EMPTY]
  const legacy = legacyStoreWithRecords(EQUIV_ROWS, feedIds)
  const { store, db, dir } = sqliteStoreWithRecords(EQUIV_ROWS, feedIds)
  try {
    const expected = [...legacy.listArticleCacheEntries()].sort((a, b) => a.id.localeCompare(b.id))
    const actual = [...store.listArticleCacheEntries()].sort((a, b) => a.id.localeCompare(b.id))
    assert.deepEqual(actual, expected, '清算原料必须与旧实现逐条相等（chars 的口径最容易在两处分家）')
    assert.deepEqual(actual, [
      { id: 'old-with-body', chars: 5, fetchedAt: '2020-02-02T00:00:00.000Z' },
      { id: 'unread-2', chars: 3, fetchedAt: '2026-10-11T08:30:00.000Z' },
    ], '前置条件：只有带正文的条目进名单，chars 含 blocks 的 text 与 items')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
