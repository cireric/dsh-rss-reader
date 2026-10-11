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
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import z from 'schemastery'
import { readerDomain } from './domain.js'
import { type ReaderStore } from './store.js'
import { storageRoot, ensureStorageRoot } from './storage/paths.js'
import { openDatabase, migrateSchema } from './storage/db.js'
import { migrateFromDomainFile } from './storage/migrate.js'
import { createSqliteStore } from './store-sqlite.js'
import { normalizeFeedUrl, refreshFeeds, type FeedOutcome } from './refresh.js'
import { repairIdentities } from './identity-repair.js'
import { blocksToText, fetchArticle } from './article.js'
import { articleCharsOf, selectCleanup, type CleanupRow } from './retention.js'
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
 * 硬依赖：存储域 + RPC 通道 + web server。
 * connection 的 rpc.handle 会把逻辑通道落成一条物理路由，因此它内部要取 ctx.webServer——
 * 自己没声明注入就抛 "cannot get property webServer without inject"（实测，注入器把这条
 * 原本会被吞掉的错误回传后一眼定位）。
 */
export const inject = ['storageDomain', 'connection', 'webServer']

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

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 打开存储域，对 already-open 退避重试。
 *
 * ⚠️ **已经没有任何调用方了**（Task 4 的切换把入口换成自持存储 + 迁移），保留它是**刻意的**：
 * 计划把它交给 Task 8 与 `inject` / `peerDependencies` / `build.sh` 的三处装配引用一起摘 ——
 * 现在单独删掉，等于在 cutover 这一步顺手拆掉中途回退的把手。**不要**因为「没人调用」就删它。
 *
 * 热重载时上一代 fiber 的 close() 可能还在排空写队列，新 fiber 立刻 open 同名域
 * 会撞 `already-open`——这不是配置错误，等一下就好。超过重试次数仍然失败就把
 * 最后一次错误抛出去（响亮失败），并已逐次写进日志。
 */
async function openDomainWithRetry(
  ctx: Context,
  log: (message: string) => void,
  isCancelled?: () => boolean,
): Promise<Awaited<ReturnType<Context['storageDomain']['open']>>> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    if (isCancelled?.()) throw new Error('装载已取消（fiber 已卸载）')
    try {
      return await ctx.storageDomain.open(readerDomain)
    } catch (error) {
      lastError = error
      const alreadyOpen = error instanceof Error && error.message.includes('already open')
      log('打开存储域失败（第 ' + attempt + '/6 次）：' + String(error))

      // 重载器丢弃了上一代 fiber、它的 disposer 又没跑到时，域句柄会变成
      // 无人可及的孤儿，名字被永久占用。设施把已打开的域作为诊断面暴露
      // （DomainFacility.get），这是唯一能在进程内收尾的口子。只在前几次
      // 退避仍失败后动手，且必须响亮记录——它不是正常路径。
      if (alreadyOpen && attempt === 3) {
        const orphan = ctx.storageDomain.get(readerDomain.name)
        if (orphan) {
          log('上一代 fiber 遗留域句柄（无持有者），接管并关闭：' + readerDomain.name)
          try {
            await orphan.close()
            log('孤儿域句柄已释放')
          } catch (closeError) {
            log('释放孤儿域句柄失败：' + String(closeError))
          }
        } else {
          log('设施报告域被占用，但取不到句柄：等待排空')
        }
      }

      if (attempt < 6) await delay(200 * attempt)
    }
  }
  throw lastError
}

export function apply(ctx: Context, rawConfig: ConfigShape): void {
  // 先解析配置：下面 logFile 那一行就要用 config，所以它必须是 apply 的第一件事
  const config = Config(rawConfig ?? {} as ConfigShape)
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const logFile = config.logFile || join(dshHome, 'state', 'dsh-rss-reader', 'reader.log')
  // 自持存储的落点：**不传 dshHome**，交给 storageRoot → resolveDshHome（Task 2 的唯一算法）。
  // 上面那份手抄的 dshHome 只留给日志；在 $DSH_HOME 为纯空白时它会把路径算到 CWD 上，
  // 而 resolveDshHome 会把空白视为未设置（src/storage/paths.ts 的注释就是记的这件事）。
  const storagesRoot = storageRoot()
  // 老域文件的落点：存储域的 base bundle 把 root 设为 <DSH_HOME>/storages，域名 rss_reader
  // ⇒ <storages>/rss_reader.json。从 storageRoot 的父目录推，不另手抄一份 storages 路径 ——
  // 拼错的后果是「读不到老文件 ⇒ 静默走首装」，那在用户眼里就是订阅全没了（Review Focus 1）。
  const legacyDomainFile = join(dirname(storagesRoot), 'rss_reader.json')
  // 订阅映射与视图偏好的落点（Task 2 的 config.json）：宿主半只在装配处用它，其余读写全在 store 里
  const configFile = join(storagesRoot, 'config.json')

  /** 同一篇文章的抓取时间（内存态即可：重启后允许再抓一次）。 */
  const articleAttempts = new Map<string, number>()

  const log = (message: string): void => {
    const line = '[' + new Date().toISOString() + '] ' + message
    ctx.logger?.info?.(line)
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, line + '\n')
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
    const subscriptions = target.listFeeds().map(([feedId]) => feedId)
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
        // 放在每次打开域之后，是因为它不依赖网络——而分叉可能发生在任何一次抓取里。
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