/**
 * 一页条目（src/item-page.ts）的模块级判据 —— **不起库、不起 dispatch**。
 *
 * 这是阶段 6 验收第 2 条（「一页的产生可以不经真库直接测」）的落地：分页协议的正确性原先只被
 * `overview-paging`（真 SQLite + 真端点）覆盖，而那一层同时混着 SQL 谓词与窗口逻辑，红了也分不清
 * 是谁的错。这里用一个 20 行的假 `listRecent` 把**窗口补偿 / 判尾 / 围栏 / 续页关系**单独钉住；
 * SQL 侧仍由 `overview-paging` / `folder-browse` / `tag-browse` 负责（两边互补，不重复）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  afterCursor,
  buildItemPage,
  decodePageCursor,
  encodePageCursor,
  fenceKeyOf,
} from '../lib/item-page.js'

const T = (minute) => '2026-10-11T09:' + String(minute).padStart(2, '0') + ':00.000Z'

/** 一条最小 ItemRecord（只放分页会用到的字段）。 */
function item(feedId, over = {}) {
  return {
    feedId,
    title: '标题',
    link: 'https://site.example/' + feedId,
    fetchedAt: T(0),
    starred: false,
    ...over,
  }
}

/**
 * 假取数：行为与 ReaderStore.listRecent 的契约一致（排序键固定，调用方按 recency 降序 + id 升序
 * 排序传入），并**记录每次被请求的参数** —— 窗口放大没有别的观察面，它只体现在 limit 上；
 * 而时间窗有没有传下去，只能从这里看。
 *
 * 窗口过滤在这里按契约自己写一遍（`published_at` 有值且在 `[from, to)` 内），**不 import**
 * 被测模块的谓词：桩件引用被测代码的判据会让「窗口没传下去」也能绿（docs/pitfalls.md §2.6）。
 */
function fakeSource(rows, tagIdsByItem = {}) {
  const calls = []
  return {
    calls,
    listRecent(limit, cursor, feedIds, tagId, window) {
      calls.push({ limit, cursor, feedIds, tagId, window })
      if (limit <= 0) return []
      let found = rows
      if (feedIds !== undefined) found = found.filter(([id, record]) => feedIds.includes(record.feedId))
      // 标签在 item_tags 里，不在 ItemRecord 上（src/domain.ts 的 schema 是 .strict() 的）：
      // 桩件照真实关系建模，否则「标签范围」测的是桩自己的想象（docs/pitfalls.md §2.6）。
      if (tagId !== undefined) found = found.filter(([id]) => (tagIdsByItem[id] ?? []).includes(tagId))
      if (window !== undefined) {
        found = found.filter(([, record]) =>
          record.publishedAt !== undefined && record.publishedAt >= window.from && record.publishedAt < window.to)
      }
      if (cursor !== undefined) {
        found = found.filter(([id, record]) => afterCursor({ recency: record.publishedAt ?? record.fetchedAt, id }, cursor))
      }
      return found.slice(0, limit)
    },
  }
}

/** 按 recency 降序、同 recency 内 id 升序铺一批行（与真实排序键同一条规则）。 */
const sorted = (rows) => [...rows].sort(([idA, a], [idB, b]) => {
  const byTime = (b.publishedAt ?? b.fetchedAt).localeCompare(a.publishedAt ?? a.fetchedAt)
  return byTime !== 0 ? byTime : idA.localeCompare(idB)
})

test('窗口放大：孤儿占掉的窗口必须被补回来，取回的条数始终是 window + 1', () => {
  // 4 条孤儿排在最前（recency 最新），后面 6 条在订源的条目
  const rows = sorted([
    ...Array.from({ length: 4 }, (_, i) => ['x' + i, item('x', { publishedAt: T(50 - i) })]),
    ...Array.from({ length: 6 }, (_, i) => ['a' + i, item('a', { publishedAt: '2026-01-0' + (i + 1) + 'T00:00:00.000Z' })]),
  ])
  const source = fakeSource(rows)

  const page = buildItemPage(source, { pageSize: 5, knownFeedIds: new Set(['a']) })

  assert.deepEqual(page.rows.map(([id]) => id), ['a5', 'a4', 'a3', 'a2', 'a1'],
    '一页要凑满 5 条在订源的条目（recency 降序），孤儿一条都不许下发')
  assert.ok(source.calls.length > 1,
    '首轮 6 条只够下发 2 条 ⇒ 必须重取；只取一次的话结果会静默少 3 条')
  assert.equal(typeof page.nextCursor, 'string', '后面还有 a0 ⇒ 必须给续页入口')

  // 续页：游标解出的边界是最后一条**下发**的行，下一页正好接上
  const parsed = decodePageCursor(undefined, page.nextCursor)
  assert.equal(parsed.status, 'ok')
  const second = buildItemPage(source, { pageSize: 5, knownFeedIds: new Set(['a']), cursor: parsed.cursor })
  assert.deepEqual(second.rows.map(([id]) => id), ['a0'], '第二页从 a0 开始，不重不漏')
  assert.equal(second.nextCursor, undefined, '到底时 nextCursor 缺省 —— 客户端据此停止翻页')
})

test('窗口放大：整批都是孤儿时继续放大（3 → 5 → 9），直到凑满一页', () => {
  const rows = sorted([
    ...Array.from({ length: 6 }, (_, i) => ['x' + i, item('x', { publishedAt: T(50 - i) })]),
    ...Array.from({ length: 4 }, (_, i) => ['a' + i, item('a', { publishedAt: '2026-01-0' + (i + 1) + 'T00:00:00.000Z' })]),
  ])
  const source = fakeSource(rows)

  const page = buildItemPage(source, { pageSize: 2, knownFeedIds: new Set(['a']) })

  assert.deepEqual(page.rows.map(([id]) => id), ['a3', 'a2'], 'recency 降序：a3 最新')
  assert.ok(source.calls.length > 1, '整批都是孤儿 ⇒ 继续放大重取，不能把空页当成「到底」')
  assert.equal(typeof page.nextCursor, 'string')
})

test('判尾：到底时不硬给续页游标；恰好取满也不算「还有下一页」', () => {
  // ① 行数少于页大小 ⇒ 一次就到底
  const short = fakeSource(sorted([['a0', item('a')], ['a1', item('a')]]))
  const page = buildItemPage(short, { pageSize: 5, knownFeedIds: new Set(['a']) })
  assert.deepEqual(page.rows.map(([id]) => id), ['a0', 'a1'])
  assert.equal(page.nextCursor, undefined, '取不满 ≠ 有下一页：到底就必须缺省')

  // ② 行数恰好等于页大小 ⇒ 存储侧已给不出更多行（请求 6 只拿到 5），同样到底
  const exact = fakeSource(sorted(Array.from({ length: 5 }, (_, i) => ['a' + i, item('a', { publishedAt: '2026-01-0' + (i + 1) + 'T00:00:00.000Z' })])))
  const full = buildItemPage(exact, { pageSize: 5, knownFeedIds: new Set(['a']) })
  assert.equal(full.rows.length, 5)
  assert.equal(full.nextCursor, undefined, '末页一条不少也必须没有 nextCursor（否则界面上是个死按钮）')
})

test('页大小 ≤ 0：空页、无游标（配置没有下限，不许抛错也不许给续页）', () => {
  const rows = sorted([['a0', item('a')], ['a1', item('a')]])
  // limit ≤ 0 的语义由 ReaderStore 契约负责（三份实现都返回空列表），这里只钉本模块的结果。
  for (const pageSize of [0, -3]) {
    const source = fakeSource(rows)
    const page = buildItemPage(source, { pageSize, knownFeedIds: new Set(['a']) })
    assert.deepEqual(page.rows, [], 'pageSize ≤ 0 ⇒ 空页（不抛错）')
    assert.equal(page.nextCursor, undefined, '空页永远不是「还有下一页」')
  }
})

test('范围映射：tag 范围只取带该标签的行并写入 tag 栅栏；空 folder 是空结果而不是全表', () => {
  const rows = sorted([
    ['a0', item('a', { publishedAt: '2026-01-01T00:00:00.000Z' })],
    ['a1', item('a', { publishedAt: '2026-01-02T00:00:00.000Z' })],
    ['b0', item('b', { publishedAt: '2026-01-03T00:00:00.000Z' })],
  ])
  const source = fakeSource(rows, { a0: ['t1'], b0: ['t2'] })

  const tagged = buildItemPage(source, { scope: { kind: 'tag', id: 't1' }, pageSize: 5, knownFeedIds: new Set(['a', 'b']) })
  assert.deepEqual(tagged.rows.map(([id]) => id), ['a0'], 'tag 范围只下发打了该标签的条目')
  assert.equal(tagged.nextCursor, undefined)

  const emptyFolder = buildItemPage(source, {
    scope: { kind: 'folder', name: '空', feedIds: [] },
    pageSize: 5,
    knownFeedIds: new Set(['a', 'b']),
  })
  assert.deepEqual(emptyFolder.rows, [], '空成员文件夹 = 空结果，绝不回落成「无范围」（那会查出全库）')
})

test('栅栏：同范围可解，成员变动 / 别的范围失配，垃圾体是 malformed（三态不许合并）', () => {
  const folder = { kind: 'folder', name: '技术', feedIds: ['b', 'a'] }
  const cursor = { recency: T(0), id: 'it-1' }
  const wire = encodePageCursor(folder, cursor)
  const key = fenceKeyOf(folder)

  assert.match(key, /^folder:[A-Za-z0-9_-]+$/, '文件夹键 = folder:<hash>')
  assert.ok(wire.startsWith(key + ':'), '带范围的游标必须带栅栏前缀')
  assert.deepEqual(decodePageCursor(folder, wire), { status: 'ok', cursor }, '同一范围往返必须逐字段相同')
  assert.equal(fenceKeyOf({ kind: 'folder', name: '技术', feedIds: ['a', 'b'] }), key,
    '成员顺序不参与语义（键必须对排序后的成员取哈希）')

  // 成员变动 = 另一个范围：旧游标必须失配，绝不能静默按新成员续页
  assert.deepEqual(decodePageCursor({ kind: 'folder', name: '技术', feedIds: ['a'] }, wire), { status: 'mismatch' })
  assert.deepEqual(decodePageCursor(folder, 'garbage'), { status: 'mismatch' },
    '有范围时连栅栏前缀都没有的串，是「别的范围的游标」而不是「本范围的坏游标」——不猜、不静默从头开始')
  assert.deepEqual(decodePageCursor(undefined, wire), { status: 'malformed' }, '无范围请求拿有范围游标：认不出')
  assert.deepEqual(decodePageCursor(folder, key + ':garbage'), { status: 'malformed' })
  assert.deepEqual(decodePageCursor(folder, key + ':'), { status: 'malformed' })

  // 标签：id 稳定，改名不失效；换标签才失配
  const tag = { kind: 'tag', id: 't1' }
  const tagWire = encodePageCursor(tag, cursor)
  assert.ok(tagWire.startsWith('tag:t1:'))
  assert.deepEqual(decodePageCursor(tag, tagWire), { status: 'ok', cursor })
  assert.deepEqual(decodePageCursor({ kind: 'tag', id: 't2' }, tagWire), { status: 'mismatch' })

  // 无范围：裸体 "<recency>|<id>"，没有前缀
  assert.equal(encodePageCursor(undefined, cursor), T(0) + '|it-1')
  assert.deepEqual(decodePageCursor(undefined, T(0) + '|it-1'), { status: 'ok', cursor })
})

test('afterCursor：recency 降序、同 recency 内 id 升序的「严格之后」', () => {
  const cursor = { recency: T(10), id: 'b' }
  assert.equal(afterCursor({ recency: T(9), id: 'z' }, cursor), true, '更早的 recency 一律在后')
  assert.equal(afterCursor({ recency: T(11), id: 'a' }, cursor), false, '更新的 recency 不在后')
  assert.equal(afterCursor({ recency: T(10), id: 'c' }, cursor), true, '同 recency 内 id 升序：c 在 b 之后')
  assert.equal(afterCursor({ recency: T(10), id: 'a' }, cursor), false, '同 recency 内更小的 id 在前面')
  assert.equal(afterCursor({ recency: T(10), id: 'b' }, cursor), false, '边界行本身不算「之后」——否则每页都会重复它')
})

/**
 * ── R1 显示窗：窗口进栅栏（ADR-0004 的 2026-11-19 修订）────────────────────────────
 *
 * 窗口一变，游标边界行可能整个落在窗外：沿用旧游标会从错误的位置继续（重复或断档），
 * 所以 `(scope, window)` 一起决定前缀。而无窗口时前缀必须**一个字都不变** —— 升级瞬间
 * 用户浏览器里可能还握着旧游标，面板不重载就该继续能用（spec 补充说明第 3 条）。
 */
const WINDOW_TODAY = { from: '2026-11-20T00:00:00.000Z', to: '2026-11-21T00:00:00.000Z' }
const WINDOW_7D = { from: '2026-11-14T00:00:00.000Z', to: '2026-11-21T00:00:00.000Z' }

test('窗口栅栏：无窗口时前缀逐字不变（旧游标继续有效）', () => {
  const cursor = { recency: T(0), id: 'it-1' }
  const folder = { kind: 'folder', name: '技术', feedIds: ['b', 'a'] }

  // 无范围：裸体 "<recency>|<id>"，与加窗之前逐字相同
  assert.equal(encodePageCursor(undefined, cursor), T(0) + '|it-1')
  // 有范围：仍是既有的 folder:<hash>: 前缀，窗口缺席不追加任何段
  assert.equal(encodePageCursor(folder, cursor), fenceKeyOf(folder) + ':' + T(0) + '|it-1')
  // 显式传 undefined 与省略参数逐字相同（调用方不必区分两种写法）
  assert.equal(encodePageCursor(folder, cursor, undefined), encodePageCursor(folder, cursor))
  assert.deepEqual(decodePageCursor(folder, encodePageCursor(folder, cursor)), { status: 'ok', cursor },
    '不带窗口的旧游标必须照常解出 —— 否则升级那一刻所有人的翻页都会断')
})

test('窗口栅栏：同窗口往返可解；切窗口 / 带窗游标带回「全部」一律 mismatch', () => {
  const cursor = { recency: T(0), id: 'it-1' }
  const scopes = [undefined, { kind: 'tag', id: 't1' }, { kind: 'folder', name: '技术', feedIds: ['a'] }]

  for (const scope of scopes) {
    const wire = encodePageCursor(scope, cursor, WINDOW_TODAY)
    assert.deepEqual(decodePageCursor(scope, wire, WINDOW_TODAY), { status: 'ok', cursor },
      '同一 (范围, 窗口) 往返必须逐字段相同：' + JSON.stringify(scope))
    assert.deepEqual(decodePageCursor(scope, wire, WINDOW_7D), { status: 'mismatch' },
      '切档后旧游标必须失配，绝不能静默按旧边界续页：' + JSON.stringify(scope))
    assert.deepEqual(decodePageCursor(scope, wire), { status: 'mismatch' },
      '带窗游标带回「全部」同样失配（反过来也一样）')
  }

  // 无窗口旧游标带到带窗口请求：失配（窗口段的失配必须响亮，不许当成「第一页」）
  const oldWire = encodePageCursor(undefined, cursor)
  assert.deepEqual(decodePageCursor(undefined, oldWire, WINDOW_TODAY), { status: 'mismatch' })
  // 同一范围、两个窗口的键必须彼此不同（否则切档不会失配）
  assert.notEqual(encodePageCursor(undefined, cursor, WINDOW_TODAY), encodePageCursor(undefined, cursor, WINDOW_7D))
})

test('窗口栅栏：带窗口前缀下的坏游标体是 malformed（与 mismatch 分开）', () => {
  const cursor = { recency: T(0), id: 'it-1' }
  const good = encodePageCursor(undefined, cursor, WINDOW_TODAY)
  // 前缀 = 去掉裸游标后的那段；用它拼一个形状对、内容坏的体
  const prefix = good.slice(0, good.length - encodeCursorLength(cursor))
  assert.deepEqual(decodePageCursor(undefined, prefix + 'garbage', WINDOW_TODAY), { status: 'malformed' })
  assert.deepEqual(decodePageCursor(undefined, prefix, WINDOW_TODAY), { status: 'malformed' },
    '只剩前缀（没有游标体）也是 malformed —— 不许被当成「没有游标」')
})

/** 裸游标在 wire 里的长度（`<recency>|<id>`）；测试里只用来切前缀。 */
function encodeCursorLength(cursor) {
  return cursor.recency.length + 1 + cursor.id.length
}

test('窗口透传：窗口原样交给取数，与 folder / tag 范围正交（范围仍是那两态）', () => {
  const rows = sorted([
    ['today-a', item('a', { publishedAt: '2026-11-20T10:00:00.000Z' })],
    ['today-b', item('b', { publishedAt: '2026-11-20T09:00:00.000Z' })],
    ['old-a', item('a', { publishedAt: '2026-11-10T10:00:00.000Z' })],
    ['no-date', item('a', { fetchedAt: '2026-11-20T10:30:00.000Z' })],
  ])
  const source = fakeSource(rows, { 'today-a': ['t1'] })

  const page = buildItemPage(source, {
    scope: { kind: 'tag', id: 't1' },
    window: WINDOW_TODAY,
    pageSize: 5,
    knownFeedIds: new Set(['a', 'b']),
  })
  assert.deepEqual(page.rows.map(([id]) => id), ['today-a'],
    '窗口 + 标签范围叠加：只给该范围里窗内的行（无发布日期的今天抓到的条目也不许进窗）')
  const call = source.calls.at(-1)
  assert.deepEqual(call.window, WINDOW_TODAY, '窗口必须原样传给 listRecent（取数才是真过滤的地方）')
  assert.equal(call.tagId, 't1', '标签范围照旧落到 listRecent 的 tagId 参数上')

  const folderPage = buildItemPage(source, {
    scope: { kind: 'folder', name: '技术', feedIds: ['a', 'b'] },
    window: WINDOW_TODAY,
    pageSize: 5,
    knownFeedIds: new Set(['a', 'b']),
  })
  assert.deepEqual(folderPage.rows.map(([id]) => id), ['today-a', 'today-b'], '文件夹范围 + 窗口：只少不少')
  const folderCall = source.calls.at(-1)
  assert.deepEqual(folderCall.feedIds, ['a', 'b'])
  assert.deepEqual(folderCall.window, WINDOW_TODAY)

  // 不带窗口：窗口参数必须是 undefined（不是空对象、不是 undefined 之外的东西）
  buildItemPage(source, { pageSize: 5, knownFeedIds: new Set(['a']) })
  assert.equal(source.calls.at(-1).window, undefined, '无窗口时必须传 undefined —— 旧行为逐字不变')
})
