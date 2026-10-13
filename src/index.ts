/**
 * @dsh-external/dsh-rss-reader — host 半（M2）。
 *
 * 数据面（M1）+ 给浏览器半的读写通道（M2）：
 *   RPC '/rss-reader' 端点 overview / refresh / markRead
 *   （见 dsh-plugin-dev: references/connection-rpc.md —— 浏览器半调主进程一律走这条，
 *    不用裸 @Remote，也不手写 manifest）。
 *
 * 仍然不含定时器：刷新由「装载时」与「浏览器半打开面板时」触发，且受最小间隔节流；
 * 验收标准 §6 要求卸载不留残余，常驻轮询等确有必要时再单独设计。
 * 也不注册模型工具：模型可见即已记录（技能硬规则 #8），阅读面走 UI。
 */
import type { Context } from 'cordis'
import { recencyOf } from './shared.js'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import z from 'schemastery'
import { type ReaderStore } from './store.js'
import { storageRoot, ensureStorageRoot } from './storage/paths.js'
import { dailyLogPath, pruneOldLogs } from './storage/log-file.js'
import { openDatabase, migrateSchema } from './storage/db.js'
import { migrateFromDomainFile } from './storage/migrate.js'
import { createSqliteStore } from './store-sqlite.js'
import { normalizeFeedUrl, refreshFeeds, selectStalestFeeds, type FeedOutcome } from './refresh.js'
import { repairIdentities } from './identity-repair.js'
import { blocksToText, fetchArticle } from './article.js'
import { buildOpml, parseOpml } from './opml.js'
import { validateSubscriptions } from './subscribe.js'
import { Config } from './config.js'
import type { Config as ConfigShape } from './config.js'
// **入口必须导出 schema 本身**：宿主（含注入器）靠它给 config 补默认值。
// 2026-10-08 实测的回归：拆分把 Config 搬进 config.ts 时只 import 没再导出，于是注入器传进来的
// config 不再经过 schema —— 全字段 undefined，抓取 / 正文缓存闸门 / 清理端点三处硬故障。
export { Config }
import { createDispatch } from './endpoints.js'
import { fail } from './shared.js'
import { ROUTE_PATH, type Endpoint, type ItemView, type Overview, type RpcResult } from './shared.js'

export const name = '@dsh-external/dsh-rss-reader'

/**
 * 硬依赖：RPC 通道 + web server。
 * connection 的 rpc.handle 会把逻辑通道落成一条物理路由，因此它内部要取 ctx.webServer——
 * 自己没声明注入就抛 "cannot get property webServer without inject"（实测，注入器把这条
 * 原本会被吞掉的错误回传后一眼定位）。
 *
 * ⚠️ 这里曾声明过 `storageDomain`，Task 8 随自持存储一并摘掉：插件不再打开任何存储域，
 * 留着会让「切回存储域」看起来只差改一行代码，实际是数据已经搬走了、装回来只会读到空库。
 *
 * ⚠️ 但**依赖还在**（`package.json` 的 peerDependency + `build.sh` 的 link_pkg）：
 * `src/domain.ts` 仍 import `defineDomain`（定义 readerDomain），`src/store.ts` 仍 import type，
 * 删掉那条 link 会让从零 build 直接 TS2307（实测）。存活的唯一消费者是旧适配器 `createStore`，
 * 它只被测试当同义性基线用（见 scripts/build.sh 的注释）。**别把这三处的删除当成一步**。
 */
export const inject = ['connection', 'webServer']

function summarize(outcomes: readonly FeedOutcome[]): string {
  if (outcomes.length === 0) return '未配置订阅源（Config.feeds 为空），跳过刷新'
  const lines = outcomes.map((outcome) => {
    const head = outcome.url + ' → ' + outcome.status + (outcome.status === 'added' ? '(+' + outcome.added + ')' : '')
    const notes: string[] = []
    if (outcome.untrusted !== undefined) {
      notes.push('⚠ ' + outcome.untrusted + ' 条身份不可信（源内 id 撞车且 URL 不同，已按 URL 重算）')
    }
    if (outcome.reclaimed !== undefined) {
      notes.push('ℹ ' + outcome.reclaimed + ' 条认回老身份（源改过 id 形态或链接，未产生重复）')
    }
    if (outcome.reason !== undefined) notes.push(outcome.reason)
    return notes.length === 0 ? head : head + '（' + notes.join('；') + '）'
  })
  return '刷新完成，共 ' + outcomes.length + ' 源:\n' + lines.join('\n')
}

export function apply(ctx: Context, rawConfig: ConfigShape): void {
  // 先解析配置：下面 logFile 那一行就要用 config，所以它必须是 apply 的第一件事
  const config = Config(rawConfig ?? {} as ConfigShape)
  // 自持存储的落点：**不传 dshHome**，交给 storageRoot → resolveDshHome（Task 2 的唯一算法）。
  //
  // 这里原先还手抄过一份 `process.env.DSH_HOME || join(homedir(), '.dsh')`，只给旧日志路径用
  // （$DSH_HOME 为纯空白时它会把路径算到 CWD 上，而 resolveDshHome 把空白视为未设置 —— 见
  // src/storage/paths.ts 的注释）。日志搬进存储根之后它失去唯一用途，随之删掉：路径来源回到一份。
  const storagesRoot = storageRoot()
  // 刷新日志的落点：默认是**插件自己的存储根**下的按天文件（storages/rss-reader/reader-YYYY-MM-DD.log）。
  // 旧路径 <DSH_HOME>/state/dsh-rss-reader/reader.log 是「一个文件写到天荒地老」（本机实测 503 KB），
  // 且与用户数据分居两处，排查时得先知道路径才找得到。搬进存储根之后日志与 config.json / rss.db 同住，
  // 按天分文件也让「保留多少天」成为一条能真的执行的策略（见下面装载时的 prune）。
  //
  // 非空的 config.logFile 是一个**操作者显式指定的固定文件**：人在说话，压过按天的默认值。
  // 默认路径里的日期一律取 UTC —— 与日志行首 toISOString() 的时间戳同一口径，否则
  // 「这条日志属于哪一天」会随机器所在时区漂移（本机 CST，差 8 小时），而文件里的行仍写着 UTC。
  //
  // ⚠️ 默认落点**推迟到每次写日志时**才算（见下面的 log 函数）：DSH 是长驻进程，一跑就是几天，
  // 装载时算一次会把之后所有日志都写进「装载那天」的文件里 —— 按天分文件在常见路径上当场落空。
  const logFile = config.logFile
  // 老域文件的落点：存储域的 base bundle 把 root 设为 <DSH_HOME>/storages，域名 rss_reader
  // ⇒ <storages>/rss_reader.json。从 storageRoot 的父目录推，不另手抄一份 storages 路径 ——
  // 拼错的后果是「读不到老文件 ⇒ 静默走首装」，那在用户眼里就是订阅全没了（Review Focus 1）。
  const legacyDomainFile = join(dirname(storagesRoot), 'rss_reader.json')
  // 订阅映射与视图偏好的落点（Task 2 的 config.json）：宿主半只在装配处用它，其余读写全在 store 里
  const configFile = join(storagesRoot, 'config.json')

  /** 同一篇文章的抓取时间（内存态即可：重启后允许再抓一次）。 */
  const articleAttempts = new Map<string, number>()

  const log = (message: string): void => {
    // ⚠️ 时钟只取**一次**，行首时间戳与文件名必须来自同一个时刻。
    // 各取一次 new Date() 时，两次读取之间隔着一次 ctx.logger?.info?.() 调用 —— 它的耗时由宿主
    // 实现决定，本插件无从约束（本仓库的取向是「不假设调用方快」）。跨过 UTC 零点时就会出现
    // 「2026-10-11T23:59:59.999Z 这一行落在 reader-2026-10-12.log 里」：排障时按日期找日志
    // 会找不到那一行，而它明明在。一次取值就从根上排除这种跨界，不依赖「这两行之间足够快」。
    const at = new Date()
    const line = '[' + at.toISOString() + '] ' + message
    ctx.logger?.info?.(line)
    // 默认落点按**当天**现算（长驻进程不能只算一次，见上面的注释）
    const target = logFile === '' ? dailyLogPath(storagesRoot, at) : logFile
    try {
      // 存储根（默认落点）必须是 0700：这一行**可能早于 ensureStorageRoot 跑**（「配置未经解析」
      // 的提示就在装载最前面），而 mkdirSync 的默认权限受 umask 支配（通常 0755）。等
      // ensureStorageRoot 到时目录已存在，按它自己的规矩「已存在的目录不改权限」——
      // 存储根的 0700 会从这里被静默放宽，而目录里放的是订阅与已读态。
      // 显式指定的 config.logFile 保持旧行为（只建目录、不动权限）：那是操作者自己挑的地方。
      mkdirSync(dirname(target), logFile === ''
        ? { recursive: true, mode: 0o700 }
        : { recursive: true })
      appendFileSync(target, line + '\n')
    } catch (error) {
      // 日志写不进去要可见，但不能因此拖垮插件本身
      ctx.logger?.warn?.('[dsh-rss-reader] 写刷新日志失败：' + String(error))
    }
  }

  // ⚠️ apply 必须是**同步**的，且所有 ctx.effect 都要在同步段登记完。
  // 一旦在里面 await 过，fiber 可能已被 reload/dispose，随后的 ctx.effect 会抛
  // "cannot create effect on inactive context"（实测栈：Fiber._reload → apply → ctx.effect）。
  // 因此订阅库的打开放进 effect 的异步体，只在同步段注册资源。
  let database: DatabaseSync | undefined
  let store: ReaderStore | undefined
  let cancelled = false
  let lastRefreshCompletedAt: number | undefined
  let inFlight: Promise<void> | undefined

  /**
   * **自己解析一次配置**，不假设宿主替我们做过。
   *
   * 2026-10-08 实测：注入器路径把未经 schema 解析的 config 直接传进来（实际是 {}），于是
   * feeds / timeoutMs / maxArticleCacheChars / cleanupAfterDays 全是 undefined。后果不是「少几个
   * 功能」而是三处硬故障（逐一实测）：每次抓取在 AbortSignal.timeout(undefined) 上抛 TypeError；
   * 正文缓存闸门拿到 undefined 上限会把缓存**整份清空**；清理端点 new Date(NaN).toISOString()
   * 抛 RangeError。
   *
   * schemastery 的 schema 本身可调用且会补默认值（schema({}) 即全默认），所以在边界解析一次就够了
   * —— 比在每个字段上散 ?? 默认值更不容易漂。
   */
  // 宿主没替我们解析过 config 时要留痕（见上面 Config 导出的注释：缺了它就是这个症状）
  if (rawConfig?.feeds === undefined || rawConfig?.timeoutMs === undefined) {
    log('宿主传入的配置未经 schema 解析（' + JSON.stringify(rawConfig ?? null).slice(0, 60) + '），已按 schema 默认值补齐')
  }

  const ready = (): ReaderStore | undefined => (cancelled ? undefined : store)

  /** 把 Config.feeds 里还没落库的源幂等写进新存储（订阅源的真相在 config.json 里）。 */
  const seedConfiguredFeeds = async (target: ReaderStore): Promise<number> => {
    // 配置已在 apply 入口按 schema 解析过，所以 config.feeds 必然是 string[] —— 这里不需要再兜底。
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
    if (!options.force && lastRefreshCompletedAt !== undefined
      && Date.now() - lastRefreshCompletedAt < config.minRefreshIntervalMs) {
      // 被节流时把「还剩多久」记进日志：否则界面上只表现为「点了没反应」，
      // 用户与 agent 都无法区分「没抓」和「抓了没新内容」（用户实测踩到）。
      const waitSec = Math.ceil((config.minRefreshIntervalMs - (Date.now() - lastRefreshCompletedAt)) / 1000)
      log('刷新被节流：距上次完成不足 ' + Math.round(config.minRefreshIntervalMs / 1000) + 's（还需等 ' + waitSec + 's）')
      return false
    }
    // 取源：不是全量，而是**最旧的 K 个**（纯函数，见 refresh.ts）。一轮的时长因此与源数脱钩
    // （200 源 × 15s ÷ 5 = 600s 是一轮全抓的情形），而「没被选中的下一轮最旧」（按**上次尝试**
    // 排序，失败的尝试也算，见 refresh.ts 的 stalenessKey）保证谁都不饿死。
    // 未抓过（缺 lastFetchedAt）的源排最前；K ≥ 源数或 K ≤ 0（未配置）都退回全量，一个不丢。
    //
    // ⚠️ 与**节流/强制**各是什么关系（别把下面两段当成待修的 bug）：
    //   · `force` 只绕过节流，**不绕过**轮转：refreshOnStart 的那一轮同样只抓 K 个。
    //     首次装载 200 个源时因此只先抓到 20 个，其余分 ⌈200/20⌉ = 10 轮补齐 ——
    //     这就是「有界」的代价，也正是本任务要的形状（换成不限量就等于把 600s 还回来）。
    //   · 节流决定轮转**多快**：每轮之间至少 minRefreshIntervalMs，所以 200 源 / K=20 下
    //     全部源被摸一遍约需 10 轮。要更快就调大 refreshFeedsPerRound（它换的就是这个）。
    const subscriptions = selectStalestFeeds(target.listFeeds(), config.refreshFeedsPerRound)
    inFlight = (async () => {
      const outcomes = await refreshFeeds(subscriptions, target, {
        // 订阅源来自用户自己的配置 ⇒ 可信目标（因此允许内网自建服务）；feed 内容里的链接不受此待见
        limits: { timeoutMs: config.timeoutMs, maxBytes: config.maxBytes, trustedTarget: true },
        maxItemsPerFeed: config.maxItemsPerFeed,
        maxSeenPerFeed: config.maxSeenPerFeed,
        maxContentChars: config.maxContentChars,
        maxArticleCacheChars: config.maxArticleCacheChars,
        refreshConcurrency: config.refreshConcurrency,
      }, options.signal)
      log(summarize(outcomes))
    })()
    try {
      await inFlight
      // ⚠️ 只要这一轮**真的发起了抓取**就打上完成时间 —— 包括 K 个源全部失败的轮次。
      // 这不与「失败源不得饿死健康源」冲突：轮转仍在推进（失败的尝试也盖 lastAttemptedAt，
      // 见 refresh.ts），只是下一轮要等满 minRefreshIntervalMs。节流的目的是「别捶网络」，
      // 而这一轮确实捶了 K 次；反过来「全失败就不节流」会让一个坏源被连续快节奏重试。
      lastRefreshCompletedAt = Date.now()
      return true
    } finally {
      inFlight = undefined
    }
  }

  /** 跨源合并、按时间倒序——river of news（验收标准 §3.2）。 */
  // 端点实现搬到 endpoints.ts：这里把闭包依赖显式交出去
  const dispatch = createDispatch({ config, log, ready, refreshNow, lastRefreshCompletedAt: () => lastRefreshCompletedAt, articleAttempts })

  const readJsonBody = async (req: import('node:http').IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const buf = Buffer.from(chunk as Buffer)
      size += buf.length
      if (size > 256 * 1024) throw new Error('请求体过大')
      chunks.push(buf)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    return text === '' ? undefined : JSON.parse(text)
  }

  ctx.effect(() => {
    let dispose: (() => void) | undefined
    try {
      dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PATH,
      handler: async (req, res) => {
        // 与宿主其它路由同一套准入：Host/Origin 检查 + 浏览器鉴权
        const rejection = ctx.connection.requestRejection(req)
        if (rejection !== undefined) {
          res.writeHead(rejection, { 'content-type': 'text/plain' })
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'text/plain' })
          res.end('method not allowed')
          return
        }
        let result: RpcResult<unknown>
        try {
          const body = (await readJsonBody(req)) as { endpoint?: unknown; payload?: unknown } | undefined
          result = await dispatch(String(body?.endpoint ?? ''), body?.payload)
        } catch (error) {
          result = fail('bad-request', error instanceof Error ? error.message : String(error))
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result))
        },
      })
    } catch (error) {
      // 热重载竞态：上一代 fiber 的路由没被释放时，这里会撞 "duplicate prefix route"。
      // webServer 只提供 register(route) 返回 disposer，**没有「列出/注销路由」的公开 API**，
      // 所以插件侧无法自救（清残留路由是注入器 dev_clear_routes 的事，或重启 DSH）。
      // 但至少要响亮地说清楚发生了什么、怎么恢复 —— 而不是让 fiber 带着一条只躺在注入器日志里的
      // 错误静默死掉。2026-10-08 实测：插件因此静默宕机约 7 小时，测试全绿、插件日志毫无痕迹。
      log('HTTP 路由注册失败：' + String(error))
      log('恢复：先清残留路由再重新注入（注入器 dev_clear_routes prefix=' + ROUTE_PATH + ' → dev_inject_plugin），或重启 DSH 进程')
      throw error
    }
    return () => {
      dispose?.()
    }
  }, 'dsh-rss-reader: http route')


  // 自持存储与启动刷新：异步部分全在这个 effect 体内
  ctx.effect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        // 打开序列的顺序**不能换**（src/storage/db.ts 与 store-sqlite.ts 各有一个握手）：
        // 建目录 → 开库（跑 pragma + 版本闸）→ 建表盖章 → 迁移 → 建 store。
        // 少了 migrateSchema 会被 store 的版本握手当场拒绝（响亮的失败，好过写到一半才发现）。
        ensureStorageRoot(storagesRoot)
        // 装载时清一次超期日志（保留 14 天）。失败**不许拖垮装载** —— 与 log() 的写失败同一条纪律：
        // 日志是诊断面，不是数据面，它坏掉要可见，但不能让插件因此起不来。
        if (config.logFile === '') {
          try {
            const pruned = pruneOldLogs(storagesRoot)
            if (pruned > 0) log('清理超期日志 ' + pruned + ' 个（保留 14 天）')
          } catch (error) {
            log('清理超期日志失败（不影响装载）：' + String(error))
          }
        }
        const db = openDatabase(join(storagesRoot, 'rss.db'))
        migrateSchema(db)
        const migrated = await migrateFromDomainFile({
          domainPath: legacyDomainFile,
          db,
          configPath: configFile,
          log,
        })
        if (!migrated.skipped) {
          log('迁移完成：订阅 ' + migrated.feeds + ' 个、条目 ' + migrated.items + ' 条、去重窗口 ' + migrated.cursors + ' 个')
        }
        if (cancelled) {
          // 取消途中才建出来的库必须立刻关掉：句柄留着会让下一次装载撞 SQLITE_BUSY /
          // 上一代写队列未排空（docs/pitfalls.md §4.6 同类的坑）。关失败必须留痕，不许吞。
          try {
            db.close()
          } catch (error) {
            log('取消途中关闭订阅库失败：' + String(error))
          }
          return
        }
        database = db
        store = createSqliteStore(db, configFile)
        // 老正文缓存的规范化**搬进了迁移**（src/storage/migrate.ts 的 normalizeLegacyArticle）：
        // 库那边没有存 paragraphs 的列，所以必须在写入之前折成 blocks。这里不再全表跑一遍 ——
        // 那在 10 万行下就是一次全表扫描，而迁移之后库里已经不可能有老形态。
        const seeded = await seedConfiguredFeeds(store)
        if (seeded > 0) log('新增订阅源种子 ' + seeded + ' 个')
        // 身份修复：把历史上因「源换 id 形态」分叉出的重复条目合并回一条（幂等，跑过一次就无事可做）。
        // 放在每次建好 store 之后，是因为它不依赖网络——而分叉可能发生在任何一次抓取里。
        // ⚠️ 这行原先写「每次打开域之后」，自持存储后已经不再打开任何域（Task 8 更正）。
        const repaired = await repairIdentities(store)
        if (repaired.merged > 0) {
          log('身份修复：合并 ' + repaired.groups + ' 组重复条目（共 ' + repaired.merged + ' 条并入幸存者，用户状态已保留）')
        }
        if (config.refreshOnStart) await refreshNow({ force: true, signal: controller.signal })
        else log('refreshOnStart=false，跳过启动刷新')
      } catch (error) {
        log('装载失败：' + String(error))
      }
    })()
    return async () => {
      cancelled = true
      controller.abort()
      if (database) {
        // 同步 close：node:sqlite 的关闭是同步的，而「句柄已释放」必须在本次 teardown 返回前成立
        // （资源由 ctx.effect 负责回收，返回后再去摸它就越界了）。失败要留痕，不许吞。
        try {
          database.close()
        } catch (error) {
          log('关闭订阅库失败：' + String(error))
        }
      }
    }
  }, 'dsh-rss-reader: sqlite storage + start refresh')
}