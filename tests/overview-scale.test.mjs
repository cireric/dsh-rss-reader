/**
 * 未读记账 / 列表取数 / 清理候选在 **10 万行真实库**上的钉子（2026-10-11 大规模存储任务 5）。
 *
 * 为什么另起一个文件而不是并进 unread-accounting.test.mjs：那边用的是内存桩，它测不到本任务的
 * 全部要点 —— 「记账是不是真的落到 SQL 上」。行为层看不出差别（一个把全表读回 JS 再算的实现
 * 同样「对」），所以本文件钉的是**结构性**判据：包一层 store，数 allItems() 被调了几次 ——
 * buildOverview / accountOf / cleanup 三处都必须是 0 次（spec §3.1 的「扫描族归零」，
 * 点一次星标 = 一次 100 000 行全表遍历）。
 *
 * **规模**判据（10 万行下打开面板的耗时上界）住 tests/perf/overview-scale.test.mjs：
 * 2026-10-15 终审 I1 实测，墙钟断言留在内环会在并行负载下站在预算刀口两侧
 * （8 并发下实测 111–122ms 翻红，预算 100ms）——timing 闸门集中在 perf/ 是同一条教训的第二课。
 *
 * 断言钉的是不变量与口径（各源之和 === 总未读、0 未读的源留键、清理只动该动的），不钉实现细节。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { FEEDS, TOTAL, feedIdOf, freshLargeStore, counting, deps, sumUnread, DEFAULTS, recentWindow } from './helpers/overview-scale-fixture.mjs'
import { createDispatch } from '../lib/endpoints.js'
import { Config } from '../lib/config.js'

test('10 万行：overview 不再物化全表，且账目守恒（键域 = feeds 表）', async () => {
  const { store, db, dir } = await freshLargeStore('overview')
  try {
    const spy = counting(store)
    const dispatch = createDispatch(deps(spy.store, Config({})))

    const result = await dispatch('overview', {})

    assert.equal(result.ok, true, 'overview 应当成功')
    const view = result.value

    // 结构性判据：扫描族归零。改回 allItems() 时这条当场翻红（而不是躲在耗时的噪声里）。
    assert.equal(spy.calls.allItems, 0,
      'overview 不许再物化全表：记账走 unreadPerFeed（GROUP BY）、列表走 listRecent（LIMIT）')

    // 账目守恒（spec §4 不变量 1）：顶栏总数必须由每源账目求和派生，两处不许各算一遍
    assert.equal(sumUnread(view.perFeedUnread), view.unread, '左栏各源之和必须等于顶栏总未读')
    assert.equal(Object.keys(view.perFeedUnread).length, FEEDS, '键域 = feeds 表（一个都不能少）')
    assert.equal(Object.prototype.hasOwnProperty.call(view.perFeedUnread, feedIdOf(FEEDS - 1)), true,
      '最后一个源也要有键（0 未读的源丢键 = 左栏角标空白）')

    // 列表仍是「全局 recency 降序取前 maxItemsShown 条」：截断真的发生了，且确实是最近的那批
    assert.equal(view.items.length, DEFAULTS.maxItemsShown,
      'items 应按 maxItemsShown 截断（这里从 config 读默认值，不写死 300）')
    assert.equal(store.listRecent(1)[0][0], view.items[0].id, '列表首条必须是全局最新的那一条')

    // 抽取守恒前的真值：总行数没被读路径改动
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
    // 500 条 2020 年的已读旧条目才进入清理窗口，基准夹具中的条目是近期的。
    // 下方三个特殊条目分别覆盖两种保护状态和正文释放量。
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
          // 只给这两条开保护位：它们会进候选（SQL 只做成本筛选），由 selectCleanup 挡回去
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
    assert.notEqual(store.item('old-0-0'), undefined, '星标条目必须活下来（由判据挡回去，不是 SQL 谓词）')
    assert.notEqual(store.item('old-0-1'), undefined, '「保持未读」必须活下来（同上：保护条款只在判据里）')
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

/**
 * 显示窗（R1 05）：窗口覆盖大部分行 —— 基准夹具里 2/3 的行有发布时间且都在窗内。
 * 另加 5 条「更早」与 3 条「无日期」的未读当窗外样本：没有它们时，「窗口被忽略」
 * 与「窗口正确」在计数上完全同形，断言会变成一条什么都看不见的假绿。
 */
test('10 万行：带窗 overview 与带拆分的账目都不物化全表，且窗口把列表与账目一起收窄', async () => {
  const { store, db, dir } = await freshLargeStore('window')
  try {
    const { from, to } = recentWindow()
    const OLD_UNREAD = 5
    const NO_DATE_UNREAD = 3
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
    for (let n = 0; n < OLD_UNREAD; n += 1) {
      await store.saveItem('window-old-' + n, {
        feedId: feedIdOf(n % FEEDS),
        title: '更早的未读',
        link: 'https://old.example.com/post/' + n,
        publishedAt: tenDaysAgo,
        fetchedAt: tenDaysAgo,
        starred: false,
      })
    }
    for (let n = 0; n < NO_DATE_UNREAD; n += 1) {
      await store.saveItem('window-nodate-' + n, {
        feedId: feedIdOf((n + 10) % FEEDS),
        title: '没有发布日期的未读',
        link: 'https://nodate.example.com/post/' + n,
        fetchedAt: new Date().toISOString(),
        starred: false,
      })
    }

    // 独立真值：按 spec 的定义直接对 published_at 数（不是实现的 recency + IS NOT NULL 写法）。
    const oracleWindow = db.prepare(
      'SELECT COUNT(*) AS n FROM items'
      + ' WHERE read_at IS NULL AND published_at IS NOT NULL AND published_at >= ? AND published_at < ?',
    ).get(from, to).n
    const oracleTotal = db.prepare('SELECT COUNT(*) AS n FROM items WHERE read_at IS NULL').get().n

    const spy = counting(store)
    const dispatch = createDispatch(deps(spy.store, Config({})))
    const view = (await dispatch('overview', { from, to, todayFrom: from })).value

    // 结构性判据：带窗 + 带拆分也不许走 allItems()（10 万行一次物化就是几百毫秒与上百 MB）。
    assert.equal(spy.calls.allItems, 0, '带窗 overview 与拆分账目都不许物化全表')

    assert.equal(view.unread, oracleWindow, '窗口版总未读必须等于「按 published_at 定义」数出的窗内未读')
    assert.equal(view.unread, oracleTotal - OLD_UNREAD - NO_DATE_UNREAD,
      '窗外的更早 5 条与无日期 3 条一条都不许算进窗内账')
    assert.equal(sumUnread(view.perFeedUnread), view.unread, '每源账目之和必须等于顶栏总未读')

    assert.equal(view.items.length, DEFAULTS.maxItemsShown, '列表仍按 maxItemsShown 截断')
    for (const item of view.items) {
      assert.notEqual(item.publishedAt, undefined, '没有发布日期的条目永远不进窗')
      assert.ok(item.publishedAt >= from && item.publishedAt < to,
        '条目 ' + item.id + ' 的发布时刻 ' + item.publishedAt + ' 落在窗口 [' + from + ', ' + to + ') 之外')
    }

    // 拆分描述「全部未读」的构成（与窗口无关）：今天 = 窗内那批，更早 = 窗外旧条目，无日期单列。
    assert.deepEqual(view.unreadSplit, {
      today: oracleWindow,
      earlier: OLD_UNREAD,
      noDate: NO_DATE_UNREAD,
    }, '三联拆分必须正好接住全部未读：今天 / 更早 / 无日期')
    assert.equal(view.unreadSplit.today + view.unreadSplit.earlier + view.unreadSplit.noDate, oracleTotal,
      '拆分三分必须恒等于全部未读（spec 决策 16）')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * EXPLAIN 判据（R1 05）：窗口取页与按窗账目各自**真实 prepare 过的那条 SQL** 必须走 i2 范围扫描。
 *
 * 为什么包一层 `db.prepare` 而不是在测试里另抄一条 SQL：手抄的那份与实现里的那份可以各自漂移，
 * 断言就会对着一个没人执行的字符串全绿。语句是懒编译的（store-sqlite.ts 的语句缓存注释），
 * 所以在 dispatch 之前包一层就能录到读路径真正下发的文本 —— 这是既有的可观测接缝
 * （tests/store-sqlite.test.mjs 同款）。
 */
test('10 万行：窗口版取页与按窗账目的真实 SQL 在 EXPLAIN 下走 i2，不是全表扫描', async () => {
  const { store, db, dir } = await freshLargeStore('explain')
  try {
    const { from, to } = recentWindow()
    const captured = []
    const realPrepare = db.prepare.bind(db)
    db.prepare = (text) => { captured.push(text); return realPrepare(text) }
    try {
      const dispatch = createDispatch(deps(store, Config({})))
      const result = await dispatch('overview', { from, to })
      assert.equal(result.ok, true, '前置条件：带窗 overview 应当成功')
    } finally {
      delete db.prepare
    }

    const pageSql = captured.find((text) => text.includes('FROM items i') && text.includes('LIMIT ?'))
    const accountSql = captured.find((text) => text.includes('COUNT(*) AS unread'))
    assert.notEqual(pageSql, undefined, '必须录到窗口取页的真实 SQL（语句懒编译是这条可观测性的前提）')
    assert.notEqual(accountSql, undefined, '必须录到按窗每源账目的真实 SQL')

    const planOf = (text, args) =>
      realPrepare('EXPLAIN QUERY PLAN ' + text).all(...args).map((row) => row.detail)
    // 参数顺序与 store 的绑定顺序同源：窗口取页是 [from, to, LIMIT]（buildItemPage 首取 pageSize+1 判尾），
    // 每源账目是 [from, to]（源键域由调用方在 JS 侧裁掉，SQL 只做「读未读 + 窗口」两段谓词）。
    const pagePlan = planOf(pageSql, [from, to, DEFAULTS.maxItemsShown + 1])
    const accountPlan = planOf(accountSql, [from, to])

    assert.ok(pagePlan.some((detail) => detail.includes('SEARCH i USING INDEX i2')),
      '窗口取页必须走 i2 范围扫描，实际计划：' + pagePlan.join(' | '))
    assert.equal(pagePlan.some((detail) => detail.startsWith('SCAN')), false,
      '窗口取页不许退化成全表扫描，实际计划：' + pagePlan.join(' | '))
    assert.ok(accountPlan.some((detail) => detail.includes('SEARCH i USING INDEX i2')),
      '按窗每源账目必须走 i2 范围扫描，实际计划：' + accountPlan.join(' | '))
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
