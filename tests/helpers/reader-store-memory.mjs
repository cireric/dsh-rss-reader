/**
 * 测试用的共享存储夹具（2026-10-16 抽出；2026-11-15 票据 02/04 之后它只剩下三件事）。
 *
 * 现在这里只放「只有测试才知道怎么造」的东西：临时目录、带真 SQLite 的 freshStore、以及并发注入。
 * **内存实现本身在 src/memory-store.ts** —— 它由 tsc 盯着（少一个方法就编译失败）并通过
 * tests/store-contract.test.mjs 的整套契约，因此不再是「某个测试文件的私货」。
 *
 * 历史（免得下次有人重新发明）：2026-11-15 之前这里有六份带能力漂移的 memoryStore 副本
 * （nav 版多 global 槽、race 版多正文写入延迟、另外几份少 cursors / 少 viewPreferences），
 * 五份在票据 04 里退役，剩下的一份在票据 02 里升格为 src/memory-store.ts。
 *
 * 三个 Map（feeds / cursors / items）**刻意裸露**：用例大量直接断言 `store.items.size` /
 * `store.items.get(id)`，armConcurrentRead 也靠 `store.items.set` 做窗口注入 ——
 * 包一层访问器只会让 40+ 处用例跟着改。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrateSchema } from '../../lib/storage/db.js'
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

/** 以下 memoryStore / armConcurrentRead 搬自 tests/refresh.test.mjs；2026-11-15 给 memoryStore 加了
 * strictFeedUpdates 选项（默认关，保持既有夹具行为），其余保持原样。 */

// 2026-11-15 票据 02：实现搬到 src/memory-store.ts（由 tsc 盯着，少一个方法就编译失败），
// 这里只留一个薄适配层，保证既有 50+ 处调用点不用改。
import { createMemoryStore } from '../../lib/memory-store.js'

export { createMemoryStore }

export const memoryStore = (options = {}) => createMemoryStore(options)

/**
 * 与生产 `updateFeed` 同语义的桩：refresh 三种意图在源不存在时抛错（创建只走 upsert）。
 *
 * 为什么保留 memoryStore() 的宽容默认：50 处既有 refresh 夹具都是「空 store 直接抓」，
 * 它们测的是刷新编排而不是 updateFeed 的存在性；全量改写属于夹具重构，不是本轮缺陷修复。
 * 但凡是**要判生产行为**的新用例（退订竞态、存储失败隔离）都必须用它 —— 宽容桩会让
 * 生产上的抛错在测试里变成「悄悄创建」，那是假绿（docs/pitfalls.md 二、2.6）。
 */
export const strictMemoryStore = () => createMemoryStore({ strictFeedUpdates: true })

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
  // 每行可以带自己的 feedId（R14 的源范围分页要两源交错）；不带就落进默认源，既有用例
  // 的夹具逐字不变。feeds 键域必须覆盖出现过的每个源 —— overview 会把「不在 feeds 里的
  // 条目」当孤儿挡掉，缺一个键就会让用例红在别的理由上。
  const feedIds = []
  db.exec('BEGIN')
  for (const row of rows) {
    const feedId = row.feedId ?? PAGING_FEED_ID
    if (!feedIds.includes(feedId)) feedIds.push(feedId)
    insert.run(row.id, feedId, '标题 ' + row.id, 'https://site.example/post/' + row.id, row.recency, row.recency)
  }
  db.exec('COMMIT')
  if (feedIds.length === 0) feedIds.push(PAGING_FEED_ID)
  const feeds = {}
  feedIds.forEach((feedId, index) => { feeds[feedId] = { url: feedId, title: '源 ' + index } })
  writeConfigFile(join(dir, 'config.json'), { version: 1, feeds })
  return { store, db, dir }
}
