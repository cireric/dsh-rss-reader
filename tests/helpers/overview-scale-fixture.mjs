/**
 * 10 万行规模夹具（2026-10-15 终审 I1 拆分时抽出，内环 overview-scale 与 perf/overview-scale 共用）。
 *
 * 为什么独立成模块而不是两边各抄一份：夹具是「合成数据的形状 + 库的灌法」，两处分家后
 * 行为判据与规模判据会各测各的世界 —— 改一处必须两处同步的重复是漂移温床。
 * 规模判据的墙钟预算也住在这里：它只属于 perf 侧，内环不 import 它。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrateSchema } from '../../lib/storage/db.js'
import { writeConfigFile } from '../../lib/storage/config-file.js'
import { createSqliteStore } from '../../lib/store-sqlite.js'
import { Config } from '../../lib/config.js'

export const FEEDS = 200
export const PER_FEED = 500
export const TOTAL = FEEDS * PER_FEED

/** 默认配置读一次：截断条数这类断言从它取，默认值改了不该让无关用例跟着翻红。 */
export const DEFAULTS = Config({})

/** 源 id 与前缀：合成数据与 config.json 必须用**同一个**键，否则量到的是空结果（Task 3 踩过）。 */
export const feedIdOf = (index) => 'https://feed' + index + '.example.com/atom.xml'

/** 打开面板的耗时预算（毫秒）。改造前实测 215–238 ms ⇒ perf 侧这条会稳定翻红，而修好后 ~15 ms。 */
export const OVERVIEW_BUDGET_MS = 100

/**
 * 造一个 10 万行的真实库（单事务直灌 —— 量的是读路径，不是 saveItem 的写入成本）。
 *
 * 行形状刻意与 scripts/scale-bench.mjs 同形：1/3 没有发布时间（考排序键的 COALESCE 与
 * 「缺发布时间的行必须按抓取时间归位」），1/3 已读（考未读判据）。
 */
export async function freshLargeStore(tag) {
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
  // 在这里要花掉约 1 秒，而这是**10 万行规模**的判据，不该把预算花在夹具的 fsync 上。
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
export function counting(store) {
  const calls = { allItems: 0 }
  return {
    calls,
    store: { ...store, allItems: () => { calls.allItems += 1; return store.allItems() } },
  }
}

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

export const sumUnread = (map) => Object.values(map).reduce((acc, n) => acc + n, 0)
