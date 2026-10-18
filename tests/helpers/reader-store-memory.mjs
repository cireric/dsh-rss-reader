/**
 * 阅读器 store 测试的共享内存桩（2026-10-16 C4-a 从三个大文件抽出）。
 *
 * 为什么独立成模块而不是各文件留一份：与 overview-scale-fixture.mjs 同一条理由 ——
 * 桩是「合成数据的形状 + 契约的另一份实现」，分家后行为判据与桩的理解会各测各的世界
 * （docs/pitfalls.md 二、2.5 / 2.6），改一处必须两处同步的重复是漂移温床。
 *
 * 本轮的真实收敛面（逐字 diff 实测，比候选清单的原描述更细）：
 *  - `deps` **五份**逐字一致（overview-scale-fixture / endpoints-perfeed-unread /
 *    unread-accounting / article-markread-race + 本轮已接的 overview-paging）⇒ 直接收一份；
 *    例外：nav-persistence.test.mjs 的 deps(store) 是**不同形状**（单参、内联 Config({})）——
 *    C4-a' 接它不是机械动作（调用点传 config 或 helper 加默认参，届时单独裁决）。
 *    其余三份同形文件（epf / race / unread-accounting）已于 C4-a' 接入（各删 10 行本地桩）；
 *    全仓仍保留独立 deps 的只剩 nav-persistence（不同形状）与 overview-scale-fixture（本身
 *    就是 helper 性质的夹具，不反向依赖）。
 *  - `memoryStore` 六份是**带能力漂移的近亲**（nav-persistence 版多 global、race 版多
 *    articleWriteDelayMs、endpoints-perfeed-unread 与 unread-accounting 版少了 cursors、
 *    identity 版的 listCleanupCandidates 真实累计 articleChars 而非桩的恒 0 且无 viewPreferences），
 *    全部并成一份要靠 options 驱动，桩就变成第二个被测对象 —— 刻意**不合并**，这里只收
 *    refresh 的全量版（唯一带「桩也必须守契约」完整注释的一份）。
 *  - store-sqlite 的 freshStore / overview-paging 的 freshRows 没有跨文件重复，
 *    收进来只是让「一个临时库怎么造」只有一个家。
 *
 * 三个 Map（feeds / cursors / items）**刻意裸露**：用例大量直接断言 `store.items.size` /
 * `store.items.get(id)`，armConcurrentRead 也靠 `store.items.set` 做窗口注入 ——
 * 包一层访问器只会让 40+ 处用例跟着改，违背「纯搬移」。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrateSchema } from '../../lib/storage/db.js'
import { applyFeedIntent } from '../../lib/feed-intent.js'
import { writeConfigFile } from '../../lib/storage/config-file.js'
import { createSqliteStore } from '../../lib/store-sqlite.js'

/** 每个用例一个独立临时目录（前缀分文件，便于系统临时目录里辨认来源）。 */
export const tempDir = (tag) => mkdtempSync(join(tmpdir(), 'rss-store-' + tag + '-'))

/**
 * 每个用例一个全新的内存库 + 一个临时 config.json 落点。
 *
 * （原 tests/store-sqlite.test.mjs，逐字搬移 ——「逐字」是本仓库搬移轮的硬判据，
 * 见 docs/pitfalls.md：顺手简化过的搬移能让全套测试与变异门槛照常通过。）
 */
export function freshStore(tag) {
  const dir = tempDir(tag)
  const db = openDatabase(':memory:')
  migrateSchema(db)
  return { store: createSqliteStore(db, join(dir, 'config.json')), db, configPath: join(dir, 'config.json'), dir }
}

/** 以下 memoryStore / armConcurrentRead 原样自 tests/refresh.test.mjs 搬入，注释即判据，一字未动。 */

export function memoryStore() {
  const feeds = new Map()
  const cursors = new Map()
  const items = new Map()
  return {
    feeds,
    cursors,
    items,
    feed: (id) => feeds.get(id),
    saveFeed: async (id, record) => { feeds.set(id, record) },
    // 按意图变更（H4）：与生产实现同一条合并规则（applyFeedIntent）—— 桩不自己造第二套语义。
    // previous undefined 合法（refresh 首次抓取兼创建，与旧行为逐字等价，见 feed-intent.ts 注释）。
    updateFeed: async (id, intent) => {
      feeds.set(id, applyFeedIntent(feeds.get(id), intent))
    },
    cursor: (id) => cursors.get(id),
    saveCursor: async (id, record) => { cursors.set(id, record) },
    item: (id) => items.get(id),
    allItems: () => [...items.entries()],
    deleteFeed: async (feedId) => { feeds.delete(feedId); cursors.delete(feedId) },
    saveItem: async (id, record) => { items.set(id, record) },
    // 原子读改写（ReaderStore 契约的一部分）：fn 在写入槽位看到当前记录，见 src/store.ts 的注释
    updateItem: async (id, fn) => { items.set(id, fn(items.get(id))) },
    deleteItem: async (id) => { items.delete(id) },
    listItems: (feedId) => [...items.entries()].filter(([, record]) => record.feedId === feedId),
    /**
     * 清算原料（src/store.ts 的契约）：**只交出这三样，正文不许跟着出来**。
     * 桩也必须守这条 —— 否则测的其实是「桩自己把正文摊开了」，
     * 而生产实现恰恰是为了不让正文进堆才单列这条方法（docs/pitfalls.md 二、2.6）。
     */
    listArticleCacheEntries: () => {
      const entries = []
      for (const [itemId, record] of items.entries()) {
        if (record.article === undefined) continue
        const chars = (record.article.paragraphs ?? []).reduce((sum, paragraph) => sum + paragraph.length, 0)
          + (record.article.blocks ?? []).reduce((sum, block) => {
            const text = block.text
            if (typeof text === 'string') return sum + text.length
            const listItems = block.items
            if (Array.isArray(listItems)) return sum + listItems.reduce((inner, i) => inner + String(i).length, 0)
            return sum
          }, 0)
        entries.push({ id: itemId, chars, fetchedAt: record.article.fetchedAt ?? '' })
      }
      return entries
    },
    listFeeds: () => [...feeds.entries()],
    /**
     * 与自持实现同形（Task 5 的三条 SQL 取数方法）。
     *
     * 桩也必须守**同一条契约**：unreadPerFeed 先按传进来的键铺 0（0 未读的源留键）、
     * listCleanupCandidates 把 SQL 谓词多守的「保持未读不删」一并实现 —— 桩与实现各写一套
     * 语义，测出来的就只是桩的理解（docs/pitfalls.md 二、2.5 / 2.6）。
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
          id, starred: false, kept: false, read: true, recency,
          articleChars: 0, summaryChars: record.summary?.length ?? 0,
        })
      }
      return rows
    },
  }
}

/**
 * 让**下一次**对 `id` 的写入在其「窗口内」先落一次并发写（把 readAt 写进去）。
 *
 * 为什么用注入而不是真实并发：这两处的窗口只有一个微任务（读与构造之间没有 await），
 * 真实并发无法稳定复现；而缺陷的判据是明确的 —— 写入必须**合并进当前记录**，
 * 不许用写入前那份快照整体覆盖。注入把「窗口内有人写」变成确定性调度。
 *
 * ⚠️ 注入发生在写入方法内部、落盘之前：
 *   saveItem 那种「payload 早已定稿」的写法照样会把它盖掉；
 *   updateItem 的 fn 看到的则是含 readAt 的当前值 —— 这正是两者的分水岭。
 */
export function armConcurrentRead(store, id, readAt) {
  let armed = true
  const inject = (target) => {
    if (!armed || target !== id) return
    armed = false
    const record = store.items.get(id)
    if (record !== undefined) store.items.set(id, { ...record, readAt })
  }
  const originalSave = store.saveItem
  const originalUpdate = store.updateItem
  store.saveItem = async (itemId, record) => { inject(itemId); return originalSave(itemId, record) }
  store.updateItem = async (itemId, fn) => { inject(itemId); return originalUpdate(itemId, fn) }
}

/**
 * EndpointDeps 的桩（形状照 src/endpoints.ts 的 EndpointDeps，不增减字段）。
 * 六份逐字一致实测（C4-a diff）；config 由调用方给，因为各文件要的默认配置不同。
 */
export function deps(store, config) {
  return {
    config,
    log: () => {},
    ready: () => store,
    refreshNow: async () => false,
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
  }
}

/**
 * 造一个真实库：`rows` 是 [{ id, recency }]，direct 插入（单事务直灌，量的是读路径）。
 * 刻意不逐条走 saveItem：300 条以上时那是 300 次事务，与判据无关。
 * （原 tests/overview-paging.test.mjs 的 freshRows 搬移，行为等价改写仅一处：源 id 提为常量。）
 *
 * 搬移校验抓过自己一次：初版漏了 writeConfigFile —— feeds 键域是分页判据的一部分
 *（overview 的 perFeedUnread 键域 = feeds 表），没有它用例红的方式就变了。原注释里的
 * 「为什么」要和代码一起搬，指的就是这种行。
 */

/** 分页夹具唯一的源 id：测试文件与 helper 共用这一份，不再各写一个字符串。 */
export const PAGING_FEED_ID = 'https://feed0.example.com/atom.xml'

export function freshRows(tag, rows) {
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
    insert.run(row.id, PAGING_FEED_ID, '标题 ' + row.id, 'https://site.example/post/' + row.id, row.recency, row.recency)
  }
  db.exec('COMMIT')
  writeConfigFile(join(dir, 'config.json'), { version: 1, feeds: { [PAGING_FEED_ID]: { url: PAGING_FEED_ID, title: '源 0' } } })
  return { store, db, dir }
}
