/**
 * 未读记账 / 列表取数 / 清理候选在 **10 万行真实库**上的钉子（2026-10-11 大规模存储任务 5）。
 *
 * 为什么另起一个文件而不是并进 unread-accounting.test.mjs：那边用的是内存桩，它测不到本任务的
 * 全部要点 —— 「记账是不是真的落到 SQL 上」。行为层看不出差别（一个把全表读回 JS 再算的实现
 * 同样「对」），所以本文件的两类判据缺一不可：
 *
 *   ① **结构性**：包一层 store，数 allItems() 被调了几次 —— buildOverview / accountOf / cleanup
 *      三处都必须是 0 次（spec §3.1 的「扫描族归零」，点一次星标 = 一次 100 000 行全表遍历）。
 *   ② **规模**：10 万行下打开面板的耗时上界。改造前实测 ~215–238 ms（每次开面板一次全表物化），
 *      预算 100 ms 留了 ~5 倍余量：二次实现会稳定超界，而慢机器不会误报。
 *
 * 断言钉的是不变量与口径（各源之和 === 总未读、0 未读的源留键、清理只动该动的），不钉实现细节。
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

const FEEDS = 200
const PER_FEED = 500
const TOTAL = FEEDS * PER_FEED

/** 源 id 与前缀：合成数据与 config.json 必须用**同一个**键，否则量到的是空结果（Task 3 踩过）。 */
const feedIdOf = (index) => 'https://feed' + index + '.example.com/atom.xml'

/** 打开面板的耗时预算（毫秒）。改造前实测 215–238 ms ⇒ 这条会稳定翻红，而修好后 ~15 ms。 */
const OVERVIEW_BUDGET_MS = 100

/**
 * 造一个 10 万行的真实库（单事务直灌 —— 量的是读路径，不是 saveItem 的写入成本）。
 *
 * 行形状刻意与 scripts/scale-bench.mjs 同形：1/3 没有发布时间（考排序键的 COALESCE 与
 * 「缺发布时间的行必须按抓取时间归位」），1/3 已读（考未读判据）。
 */
async function freshLargeStore(tag) {
  const dir = mkdtempSync(join(tmpdir(), 'rss-scale-' + tag + '-'))
  const db = openDatabase(join(dir, 'rss.db'))
  migrateSchema(db)
  const store = createSqliteStore(db, join(dir, 'config.json'))

  const insert = db.prepare(
    'INSERT INTO items (id, feed_id, title, link, published_at, fetched_at, summary, read_at, starred)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  db.exec('BEGIN')
  for (let f = 0; f < FEEDS; f += 1) {
    for (let i = 0; i < PER_FEED; i += 1) {
      insert.run(
        'item-' + f + '-' + i, feedIdOf(f), 't'.repeat(40) + '#' + f + '_' + i,
        'https://site' + f + '.example.com/post/' + i,
        i % 3 === 0 ? null : '2026-10-11T09:00:00.000Z',
        '2026-10-11T10:00:00.000Z',
        '摘要' + f + '_' + i,
        i % 3 === 0 ? '2026-10-11T10:05:00.000Z' : null,
        i % 7 === 0 ? 1 : 0,
      )
    }
  }
  db.exec('COMMIT')

  // feeds 表（= config.json）一次写完：键域与合成数据的键必须完全一致。
  // 刻意走 writeConfigFile 而不是 200 次 saveFeed —— 后者每次都要「读全份 → 改一处 → fsync 原子写回」，
  // 在这里要花掉约 1 秒，而本文件是**10 万行规模**的判据，不该把预算花在夹具的 fsync 上。
  // 语义等价：store 的 feed/listFeeds/viewPreferences 每次都是现读这份文件（没有内存副本）。
  const feeds = {}
  for (let f = 0; f < FEEDS; f += 1) feeds[feedIdOf(f)] = { url: feedIdOf(f), title: '源 ' + f }
  writeConfigFile(join(dir, 'config.json'), { version: 1, feeds })
  return { store, db, dir }
}

/**
 * 包一层计数：只关心 allItems() 被调了几次。
 *
 * 展开成新对象即可 —— store 的每个方法都是闭包里的箭头函数，不依赖 this。
 */
function counting(store) {
  const calls = { allItems: 0 }
  return {
    calls,
    store: { ...store, allItems: () => { calls.allItems += 1; return store.allItems() } },
  }
}

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

const sumUnread = (map) => Object.values(map).reduce((acc, n) => acc + n, 0)

test('10 万行：overview 不再物化全表，耗时在预算内，且账目守恒（键域 = feeds 表）', async () => {
  const { store, db, dir } = await freshLargeStore('overview')
  try {
    const spy = counting(store)
    const dispatch = createDispatch(deps(spy.store, Config({})))

    const started = process.hrtime.bigint()
    const result = await dispatch('overview', {})
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

    assert.equal(result.ok, true, 'overview 应当成功')
    const view = result.value

    // ① 结构性判据：扫描族归零。改回 allItems() 时这条当场翻红（而不是躲在耗时的噪声里）。
    assert.equal(spy.calls.allItems, 0,
      'overview 不许再物化全表：记账走 unreadPerFeed（GROUP BY）、列表走 listRecent（LIMIT）')

    // ② 规模判据：改造前 215–238 ms（每次开面板一次全表物化 + 排序 10 万条 ItemView）
    assert.ok(elapsedMs < OVERVIEW_BUDGET_MS,
      'overview 耗时 ' + elapsedMs.toFixed(1) + ' ms，超过预算 ' + OVERVIEW_BUDGET_MS +
      ' ms —— 疑似又退回全表物化（改造前实测 ~230 ms，改造后 ~15 ms）')

    // ③ 账目守恒（spec §4 不变量 1）：顶栏总数必须由每源账目求和派生，两处不许各算一遍
    assert.equal(sumUnread(view.perFeedUnread), view.unread, '左栏各源之和必须等于顶栏总未读')
    assert.equal(Object.keys(view.perFeedUnread).length, FEEDS, '键域 = feeds 表（一个都不能少）')
    assert.equal(Object.prototype.hasOwnProperty.call(view.perFeedUnread, feedIdOf(FEEDS - 1)), true,
      '最后一个源也要有键（0 未读的源丢键 = 左栏角标空白）')

    // ④ 列表仍是「全局 recency 降序取前 maxItemsShown 条」：截断真的发生了，且确实是最近的那批
    assert.equal(view.items.length, 300, 'items 应按 maxItemsShown（默认 300）截断')
    assert.equal(store.listRecent(1)[0][0], view.items[0].id, '列表首条必须是全局最新的那一条')

    // ⑤ 抽取守恒前的真值：总行数没被读路径改动
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, TOTAL, '读路径不许改库')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('10 万行：标读回包（accountOf）也不物化全表，回包与 overview 同口径', async () => {
  const { store, db, dir } = await freshLargeStore('account')
  try {
    const spy = counting(store)
    const dispatch = createDispatch(deps(spy.store, Config({})))

    const marked = await dispatch('markRead', { itemIds: ['item-0-1', 'item-0-2'] })
    assert.equal(marked.ok, true)
    assert.equal(marked.value.changed, 2, '前置条件：两条未读真的被标上了')
    assert.equal(spy.calls.allItems, 0, '标读回包的前后账目都不许再物化全表（每次手势一次 10 万行遍历）')
    assert.equal(sumUnread(marked.value.perFeedUnread), marked.value.unread, '回包自身守恒')

    const view = (await dispatch('overview', {})).value
    assert.deepEqual(marked.value.perFeedUnread, view.perFeedUnread, '回包与 overview 的每源账目必须一致')
    assert.equal(marked.value.unread, view.unread, '总数也必须一致（两处口径不许漂）')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('10 万行：cleanup 的候选集由 SQL 选（不再全表），且释放量与删除数如实', async () => {
  const { store, db, dir } = await freshLargeStore('cleanup')
  try {
    const READ = '2026-10-11T10:05:00.000Z'
    // 500 条 2020 年的已读旧条目：它们才是清理目标（合成数据的 recency 都在 2026-10-11，
    // 落不进「早于 now-30 天」）。三条例外各自考 SQL 谓词的一个条件。
    for (let f = 0; f < 5; f += 1) {
      for (let i = 0; i < 100; i += 1) {
        await store.saveItem('old-' + f + '-' + i, {
          feedId: feedIdOf(f),
          title: '旧条目',
          link: 'https://site' + f + '.example.com/old/' + i,
          publishedAt: '2020-01-01T00:00:00.000Z',
          fetchedAt: '2020-01-01T00:00:00.000Z',
          summary: 's'.repeat(10),
          readAt: READ,
          starred: false,
          // 只给这两条开保护位：星标由 SQL 谓词挡（starred = 0），保持未读多守一条
          ...(f === 0 && i === 0 ? { starred: true } : {}),
          ...(f === 0 && i === 1 ? { keptUnread: true } : {}),
          // 带正文的那一条考 freedChars 的「正文也算进释放量」
          ...(f === 1 && i === 0
            ? { article: { fetchedAt: READ, blocks: [{ kind: 'p', text: 'x'.repeat(100) }] } }
            : {}),
        })
      }
    }

    const spy = counting(store)
    const dispatch = createDispatch(deps(spy.store, Config({ cleanupAfterDays: 30 })))
    // 阈值是「此刻 − 30 天」，所以取调用前后两个时刻把它夹住 —— 断言到毫秒会变成脆测
    const cutoffLow = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
    const result = (await dispatch('cleanup', {})).value
    const cutoffHigh = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()

    assert.equal(spy.calls.allItems, 0, '清理候选必须由 SQL 选：点一次清理不该再遍历 10 万行')

    // 500 条候选减去 2 条受保护的（星标 / 保持未读）
    assert.equal(result.deleted, 498, '删除数必须是 SQL 候选里真正该删的那批')
    assert.notEqual(store.item('old-0-0'), undefined, '星标条目必须活下来（SQL 谓词里的 starred = 0）')
    assert.notEqual(store.item('old-0-1'), undefined, '「保持未读」必须活下来（谓词多守的一条，比 selectCleanup 更保守）')
    assert.equal(store.item('old-1-0'), undefined, '带正文的普通旧条目要被删掉')
    // 释放量 = 498 × 10（摘要）+ 100（带正文那条的正文）
    assert.equal(result.freedChars, 498 * 10 + 100, 'freedChars 必须把正文与摘要都算进去（如实汇报）')
    assert.ok(result.cutoff >= cutoffLow && result.cutoff <= cutoffHigh,
      '阈值必须照 cleanupAfterDays 算（此刻 − 30 天），实际 ' + result.cutoff)

    // 回包里的账目同样是清完之后的真值，且与随后的 overview 一致
    assert.equal(sumUnread(result.perFeedUnread), result.unread, '清理回包自身守恒')
    const view = (await dispatch('overview', {})).value
    assert.equal(result.unread, view.unread, '清理回包的账目必须与随后的 overview 同口径')
    assert.deepEqual(result.perFeedUnread, view.perFeedUnread)
    // 10 万行 + 500 条旧条目 − 498 条已删 = TOTAL + 2（那两条受保护的）
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, TOTAL + 2, '只删了那 498 条旧条目，其余一条不动')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
