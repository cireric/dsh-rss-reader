/**
 * 自持存储与刷新的生命周期：打开 → 刷新 → 关停。
 *
 * 2026-10-15 从 src/index.ts 的 apply 闭包搬来（H2）。搬它的理由不是「文件太大」，是那七条
 * 顺序约束此前**没有任何可直测的 Interface**——它们只活在闭包与注释里，要测「teardown 不把库
 * 关在正在写的刷新底下」只能走 apply 并伪造整个宿主（tests/teardown-race.test.mjs 的 39 行假 ctx）。
 *
 * **与 ctx 无关**是刻意的：本 module 不 import cordis、不碰 webServer、不读 ctx.logger。
 * 宿主接线留在 src/index.ts（那里还要同步登记 effect）。
 *
 * 搬过来之后，下面每条约束各有一条测试（tests/lifecycle.test.mjs）：
 *  ① 打开序列 9 步的顺序不变（assertSubscriptionsNotLost 必须在建 store 之前，否则守卫抛错时
 *     这一代已半装好、ready() 会开始交出 store）；
 *  ② 守卫抛错时**自己关 db**（此刻句柄尚未登记，teardown 关不到；不关 = 每次重载漏一个连接）；
 *  ③ cancelled 为真时建出来的库立刻关掉并 return（否则下次装载撞 SQLITE_BUSY）；
 *  ④ refreshSignal 的三态不变（只有调用方的 / 只有本代的 / 两者的 any）；
 *  ⑤ refreshNow 的五个分支顺序不变；
 *  ⑥ stop = abort → 等落定 → 关句柄 → 清信号，重复调用是空操作；
 *  ⑦ ready() = cancelled ? undefined : store。
 */
import { ensureStorageRoot } from './storage/paths.js'
import { pruneOldLogs } from './storage/log-file.js'
import { openDatabase, migrateSchema } from './storage/db.js'
import { configFileMissing, readConfigFile } from './storage/config-file.js'
import { createSqliteStore } from './store-sqlite.js'
import { normalizeFeedUrl, refreshFeeds, selectStalestFeeds, type FeedOutcome } from './refresh.js'
import { repairIdentities } from './identity-repair.js'
import type { Config } from './config.js'
import type { ReaderStore } from './store.js'
import type { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

export interface LifecycleDeps {
  readonly config: Config
  readonly storagesRoot: string
  readonly configFile: string
  readonly log: (message: string) => void
  /** 每代一个 controller（不是 signal —— stop 要能 abort 它）；生产不传 */
  readonly controllerFactory?: () => AbortController
  /**
   * 刷新摘要的措辞：**必填**，虽然本 module 只负责跑与记。
   *
   * 为什么不给可选：2026-10-15 独立评审实测，「启动刷新落定」那条判据依赖的就是这行日志
   * （tests/teardown-race.test.mjs 的「在途刷新必须在 stop 内落定」读的是它）。做成可选时
   * 调用方不传就静默少一行日志——本轮 Task 4 的第一次红正是撞在这里，而新读者会以为
   * 「不传 summarize」是合法用法。措辞归宿主（人看的），但**必须给**。
   */
  readonly summarize: (outcomes: readonly FeedOutcome[]) => string
}

export interface Lifecycle {
  /** 开始这一代的装载链。同步返回 promise —— 登记 effect 的那一段不许 await。 */
  start(): Promise<void>
  /** abort → 等落定 → 关句柄。重复调用是安全的空操作。 */
  stop(): Promise<void>
  /** 未就绪或已关停时返回 undefined */
  ready(): ReaderStore | undefined
  /** 刷新全部源；返回「本次是否真的发起了抓取」（被节流或并入在途刷新时为 false） */
  refreshNow(options?: { force?: boolean; signal?: AbortSignal }): Promise<boolean>
  /** 上次刷新完成时刻（从未完成过 = undefined）—— 端点的 refreshedAt 读它 */
  lastRefreshCompletedAt(): number | undefined
  /** 正文抓取尝试时刻（内存态，每代一份；重启后允许再抓一次） */
  readonly articleAttempts: Map<string, number>
}
export function createLifecycle(deps: LifecycleDeps): Lifecycle {
  const { config, storagesRoot, configFile, log } = deps

  let database: DatabaseSync | undefined
  let store: ReaderStore | undefined
  let cancelled = false
  let lastCompletedAt: number | undefined
  let inFlight: Promise<void> | undefined
  /** 这一代装载链本身的 promise。stop 必须等它：链中间有几次 await（种子/身份修复），它们在写库。 */
  let generation: Promise<void> | undefined
  /** 这一代自己的中止信号。它的存在理由见 stop() 与 refreshSignal 的注释。 */
  let generationSignal: AbortSignal | undefined
  /** 已跑过的 start —— 重复 start 是幂等的（不重跑装载链） */
  let started = false
  let stopped = false
  /** 这一代的 controller；stop 靠它 abort 在途抓取（signal 本身没有 abort） */
  let controller: AbortController | undefined

  const articleAttempts = new Map<string, number>()

  const ready = (): ReaderStore | undefined => (cancelled ? undefined : store)

  /**
   * 「订阅映射丢了，但条目还在」必须响亮失败 —— config.json 是用户订阅的唯一可备份副本。
   * 与首次安装的区分：items 为 0 时一路放过；只有「有数据却没了订阅」才是故障。
   *
   * 必须在建 store **之前**跑：它一旦通过，后面每一步都带着一份已证明可用的订阅；放在 store
   * 之后的话，中间任何一步都可能先写库，而守卫抛错时这一代已经半装好了。
   */
  const assertSubscriptionsNotLost = (db: DatabaseSync): void => {
    if (!configFileMissing(configFile)) {
      readConfigFile(configFile)
      return
    }
    const row = db.prepare('SELECT COUNT(*) AS n FROM items').get()
    const stored = row?.n
    if (typeof stored !== 'number') {
      throw new Error('读不出订阅库的条目数（返回 ' + JSON.stringify(row) + '）：库被外部改动过？')
    }
    if (stored === 0) return
    throw new Error(
      '订阅库里有 ' + stored + ' 条条目，但订阅文件 ' + configFile + ' 不存在 —— 订阅映射无从重建。' +
        '请从备份恢复该文件。不静默继续：那会让用户看到一份空订阅列表。',
    )
  }  /** 把 Config.feeds 里还没落库的源幂等写进新存储（订阅源的真相在 config.json 里）。 */
  const seedConfiguredFeeds = async (target: ReaderStore): Promise<number> => {
    let seeded = 0
    for (const raw of config.feeds) {
      let feedId: string
      try {
        feedId = normalizeFeedUrl(raw)
      } catch {
        log('忽略非法订阅源：' + raw)
        continue
      }
      if (target.feed(feedId) === undefined) {
        await target.saveFeed(feedId, { url: feedId })
        seeded += 1
      }
    }
    return seeded
  }

  /**
   * 交给 refreshFeeds 的中止信号 = 调用方自带的 **叠加** 这一代自己的信号。
   *
   * **为什么必须叠加**（2026-10-13 真机缺陷的一半）：stop 只 abort 了 controller，而面板点刷新
   * 那条路径是 refreshNow() —— 一个 signal 都没带，于是 abort 到不了在途的抓取，stop 若不等它就会
   * 在它还在写的时候关掉句柄。两个信号都缺席时返回 undefined：fetchFeed 对 undefined 的处理与原先
   * 逐字相同（它自己还有一层 AbortSignal.timeout，不走这条路也不会挂死）。
   */
  const refreshSignal = (own?: AbortSignal): AbortSignal | undefined => {
    if (generationSignal === undefined) return own
    if (own === undefined || own === generationSignal) return generationSignal
    return AbortSignal.any([own, generationSignal])
  }

  /**
   * 刷新全部订阅源；受最小间隔节流。
   * @returns 本次是否真的发起了抓取（被节流或并入在途刷新时为 false）
   */
  const refreshNow = async (options: { force?: boolean; signal?: AbortSignal } = {}): Promise<boolean> => {
    const target = ready()
    if (!target) return false
    // 已有在途刷新：等它结束即可，不叠加第二次网络风暴
    if (inFlight) {
      await inFlight
      return false
    }
    if (!options.force && lastCompletedAt !== undefined
      && Date.now() - lastCompletedAt < config.minRefreshIntervalMs) {
      // 被节流时把「还剩多久」记进日志：否则界面上只表现为「点了没反应」，
      // 用户与 agent 都无法区分「没抓」和「抓了没新内容」。
      const waitSec = Math.ceil((config.minRefreshIntervalMs - (Date.now() - lastCompletedAt)) / 1000)
      log('刷新被节流：距上次完成不足 ' + Math.round(config.minRefreshIntervalMs / 1000) + 's（还需等 ' + waitSec + 's）')
      return false
    }
    // 取源：不是全量，而是最旧的 K 个（纯函数，见 refresh.ts）。一轮的时长与源数脱钩，
    // 而「没被选中的下一轮最旧」（按**上次尝试**排序，失败的尝试也算）保证谁都不饿死。
    // force 只绕过节流，**不绕过**轮转 —— 那不是待修的 bug，是「有界」的代价。
    const subscriptions = selectStalestFeeds(target.listFeeds(), config.refreshFeedsPerRound)
    inFlight = (async () => {
      const outcomes = await refreshFeeds(subscriptions, target, {
        limits: { timeoutMs: config.timeoutMs, maxBytes: config.maxBytes, trustedTarget: true },
        maxItemsPerFeed: config.maxItemsPerFeed,
        maxSeenPerFeed: config.maxSeenPerFeed,
        maxContentChars: config.maxContentChars,
        maxArticleCacheChars: config.maxArticleCacheChars,
        refreshConcurrency: config.refreshConcurrency,
      }, refreshSignal(options.signal))
      log(deps.summarize(outcomes))
    })()
    try {
      await inFlight
      // ⚠️ 只要这一轮**真的发起了抓取**就打上完成时间 —— 包括 K 个源全部失败的轮次。
      // 轮转仍在推进（失败的尝试也盖 lastAttemptedAt），只是下一轮要等满 minRefreshIntervalMs：
      // 节流的目的是「别捶网络」，而这一轮确实捶了 K 次；反过来「全失败就不节流」会让一个坏源
      // 被连续快节奏重试。
      lastCompletedAt = Date.now()
      return true
    } finally {
      inFlight = undefined
    }
  }

  const start = async (): Promise<void> => {
    // 重复 start 是幂等的：effect 只会登记一次，而直接驱动本 module 的测试可能调多次。
    if (started) {
      await generation
      return
    }
    started = true
    controller = deps.controllerFactory === undefined ? new AbortController() : deps.controllerFactory()
    generationSignal = controller.signal
    generation = (async () => {
      try {
        // 打开序列的顺序**不能换**（src/storage/db.ts 与 store-sqlite.ts 各有一个握手）：
        // 建目录 → 清超期日志 → 开库（pragma + 版本闸）→ 建表盖章 → 订阅守卫 → 建 store →
        // 种子 → 身份修复 → 启动刷新。少了 migrateSchema 会被 store 的版本握手当场拒绝
        // （响亮的失败，好过写到一半才发现）。
        ensureStorageRoot(storagesRoot)
        // 装载时清一次超期日志（保留 14 天）。失败**不许拖垮装载**：日志是诊断面不是数据面。
        if (config.logFile === '') {
          try {
            const pruned = pruneOldLogs(storagesRoot)
            if (pruned > 0) log('清理超期日志 ' + pruned + ' 个（保留 14 天）')
          } catch (error) {
            log('清理超期日志失败（不影响装载）：' + String(error))
          }
        }
        const db = openDatabase(join(storagesRoot, 'rss.db'))
        try {
          migrateSchema(db)
          assertSubscriptionsNotLost(db)
        } catch (error) {
          // 这个句柄此刻还**没有**登记到 database（下面的 database = db 才登记），所以 stop 的
          // 「先看 database 再 close」关不到它 —— 失败路径必须自己关。不关的后果是每失败一次泄漏
          // 一个 SQLite 连接，而守卫抛错恰恰是**最可能反复发生**的那种失败。关失败也要留痕。
          try {
            db.close()
          } catch (closeError) {
            log('装载失败后关闭订阅库也失败：' + String(closeError))
          }
          throw error
        }
        if (cancelled) {
          // 取消途中才建出来的库必须立刻关掉：句柄留着会让下一次装载撞 SQLITE_BUSY / 上一代
          // 写队列未排空（docs/pitfalls.md §4.6 同类的坑）。关失败必须留痕，不许吞。
          try {
            db.close()
          } catch (error) {
            log('取消途中关闭订阅库失败：' + String(error))
          }
          return
        }
        database = db
        store = createSqliteStore(db, configFile)
        const seeded = await seedConfiguredFeeds(store)
        if (seeded > 0) log('新增订阅源种子 ' + seeded + ' 个')
        // 身份修复：把历史上因「源换 id 形态」分叉出的重复条目合并回一条（幂等，不出网）。
        const repaired = await repairIdentities(store)
        if (repaired.merged > 0) {
          log('身份修复：合并 ' + repaired.groups + ' 组重复条目（共 ' + repaired.merged + ' 条并入幸存者，用户状态已保留）')
        }
        if (config.refreshOnStart) await refreshNow({ force: true, signal: generationSignal })
        else log('refreshOnStart=false，跳过启动刷新')
      } catch (error) {
        log('装载失败：' + String(error))
      }
    })()
    return generation
  }
  const stop = async (): Promise<void> => {
    // 重复 stop 是安全的空操作（effect 可能重放；异常路径也可能再进来一次）。
    if (stopped) {
      await Promise.all([generation, inFlight])
      return
    }
    stopped = true
    cancelled = true
    // ① 先中止：abort 让在途的抓取当场以「已中止」收束（refreshSignal 保证它到得了每一轮，
    //    含不带 signal 的面板那条）。
    controller?.abort()
    // ② 再等在途刷新与装载链**落定**，③ 最后关句柄 —— 顺序不能换。
    //
    // **病象**（2026-10-13 真机日志，两次）：两次成功装载之间夹着
    //   [..] 装载失败：Error: database is not open
    // **根因**：teardown 曾是「abort 之后同步 close」。abort 只对**真的带了这个 signal** 的调用
    // 有效，而面板点刷新那条一个 signal 都没带；refreshNow 早在进入时就把 store 抓在手里
    // （ready() 只挡得住**下一次**取 store），于是它继续在已关闭的句柄上写。
    // **修法**：abort → 等这一代落定 → close。等待是有界的：每个抓取带 AbortSignal.timeout，
    // 且 SQLite 不中断进行中的写语句，所以每一刻都有尽头。
    //
    // ⚠️ 这个 await **不许**抛出去：effect 的 teardown 抛错会把「资源已回收」变成宿主侧的失败。
    // 但也不能吞（AGENTS.md 禁空 catch）：真的以异常收尾时留痕。
    try {
      await Promise.all([generation, inFlight])
    } catch (error) {
      log('等待在途刷新结束时出错（句柄仍会被关闭，不影响本次回收）：' + String(error))
    }
    if (database) {
      try {
        database.close()
      } catch (error) {
        log('关闭订阅库失败：' + String(error))
      }
    }
    // 这一代已经收摊：信号清掉，免得这一代被复用/再次 teardown 时还看着一个已中止的信号
    //（那会让下一次抓取一出发就被 abort —— 表现为「插件重载后再也不刷新」）。
    generationSignal = undefined
  }

  return {
    start,
    stop,
    ready,
    refreshNow,
    lastRefreshCompletedAt: () => lastCompletedAt,
    articleAttempts,
  }
}
