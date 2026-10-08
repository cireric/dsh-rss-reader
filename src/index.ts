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
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import z from 'schemastery'
import { readerDomain, rebuildItem } from './domain.js'
import { createStore, type ReaderStore } from './store.js'
import { normalizeFeedUrl, refreshFeeds, type FeedOutcome } from './refresh.js'
import { blocksToText, fetchArticle } from './article.js'
import { articleCharsOf, selectCleanup, type CleanupRow } from './retention.js'
import { buildOpml, parseOpml } from './opml.js'
import { validateSubscriptions } from './subscribe.js'
import { ROUTE_PATH, type Endpoint, type ItemView, type Overview, type RpcResult } from './shared.js'

export const name = '@dsh-external/dsh-rss-reader'

/**
 * 硬依赖：存储域 + RPC 通道 + web server。
 * connection 的 rpc.handle 会把逻辑通道落成一条物理路由，因此它内部要取 ctx.webServer——
 * 自己没声明注入就抛 "cannot get property webServer without inject"（实测，注入器把这条
 * 原本会被吞掉的错误回传后一眼定位）。
 */
export const inject = ['storageDomain', 'connection', 'webServer']

export interface Config {
  /**
   * 订阅源种子 URL：仅用于首次把订阅落进存储域（幂等）。
   * 订阅源的真相在存储域里，M2 界面与 M4 的 OPML 导入都写同一张表。
   */
  feeds: string[]
  /** 单源超时（毫秒） */
  timeoutMs: number
  /** 单次响应体积上限（字节） */
  maxBytes: number
  /** 每源保留条目数 */
  maxItemsPerFeed: number
  /** 每源去重窗口大小（只存 id，必须远大于 maxItemsPerFeed，否则老条目会重新变未读） */
  maxSeenPerFeed: number
  /** 单条正文的存储上限（字符）：正文优先取 content 后需要有这个闸门，见 refresh.ts 注释 */
  maxContentChars: number
  /** 每个源的按需正文缓存总量上限（字符）：超限从最旧的开始清，见 refresh.ts 的 capArticleCache */
  maxArticleCacheChars: number
  /** 显式清理的天数阈值：早于「现在 − 该天数」的已读条目才可清理 */
  cleanupAfterDays: number
  /** OPML 导入时的逐源校验并发上限（≥20 源逐个抓太慢，全放出去又不友好） */
  importConcurrency: number
  /** 刷新时同时在飞的抓取数（逐源串行是 N x RTT 的线性等待，见 refresh.ts） */
  refreshConcurrency: number
  /** 按需抓原站正文的体积上限（字节）——单篇文章比 feed 大，与 maxBytes 分开 */
  articleMaxBytes: number
  /** 同一篇文章两次抓取之间的最小间隔（缓存未命中时），防连按造成的请求风暴 */
  articleCooldownMs: number
  /** 装载时刷新一次 */
  refreshOnStart: boolean
  /** 打开面板时的最小刷新间隔（毫秒）：节流不打网络，但不引入常驻定时器 */
  minRefreshIntervalMs: number
  /** 面板一次最多取多少条（跨源合并后的尾部截断） */
  maxItemsShown: number
  /** 刷新日志路径；空串 = 仅走 ctx.logger */
  logFile: string
}

export const Config: z<Config> = z.object({
  feeds: z.array(z.string()).default([]),
  timeoutMs: z.number().default(15000),
  maxBytes: z.number().default(5 * 1024 * 1024),
  maxItemsPerFeed: z.number().default(500),
  maxSeenPerFeed: z.number().default(5000),
  maxContentChars: z.number().default(50000),
  maxArticleCacheChars: z.number().default(8_000_000),
  cleanupAfterDays: z.number().default(30),
  importConcurrency: z.number().default(5),
  refreshConcurrency: z.number().default(5),
  articleMaxBytes: z.number().default(2 * 1024 * 1024),
  articleCooldownMs: z.number().default(30000),
  refreshOnStart: z.boolean().default(true),
  minRefreshIntervalMs: z.number().default(10 * 60 * 1000),
  maxItemsShown: z.number().default(300),
  logFile: z.string().default(''),
})

function summarize(outcomes: readonly FeedOutcome[]): string {
  if (outcomes.length === 0) return '未配置订阅源（Config.feeds 为空），跳过刷新'
  const lines = outcomes.map((outcome) => {
    const head = outcome.url + ' → ' + outcome.status + (outcome.status === 'added' ? '(+' + outcome.added + ')' : '')
    return outcome.reason === undefined ? head : head + '（' + outcome.reason + '）'
  })
  return '刷新完成，共 ' + outcomes.length + ' 源:\n' + lines.join('\n')
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}
function fail<T = never>(code: string, message: string, details: object = {}): RpcResult<T> {
  // details 必填：宿主信封 ConnectionRpcFailure 要求它（源码为准，技能文档样板落后）
  return { ok: false, error: { code, message, details } }
}

/**
 * 打开存储域，对 already-open 退避重试。
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

/**
 * 按需正文缓存的**内容版本**。
 *
 * 1 = 纯文本段落（已废弃）；2 = 结构化块（段落/标题/代码/图片/列表/引用）。
 * 缓存命中要求版本相等——老缓存会被判为过期并**自动重抓一次**，否则模型升级对已有缓存
 * 永远不生效（实测：库里 9 条老缓存导致「图片怎么都不显示」）。
 */
const ARTICLE_REVISION = 2

export function apply(ctx: Context, config: Config): void {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const logFile = config.logFile || join(dshHome, 'state', 'dsh-rss-reader', 'reader.log')

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
  // 因此存储域的打开放进 effect 的异步体，只在同步段注册资源。
  type OpenedDomain = Awaited<ReturnType<Context['storageDomain']['open']>>
  let domain: OpenedDomain | undefined
  let store: ReaderStore | undefined
  let cancelled = false
  let lastRefreshCompletedAt: number | undefined
  let inFlight: Promise<void> | undefined

  const ready = (): ReaderStore | undefined => (cancelled ? undefined : store)

  /** 把 Config.feeds 里还没落库的源幂等写进存储域（订阅源的真相在域里）。 */
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
        limits: { timeoutMs: config.timeoutMs, maxBytes: config.maxBytes },
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
  const buildOverview = (refreshed: boolean): Overview => {
    const target = ready()
    if (!target) return { feeds: [], items: [], unread: 0, refreshed }

    const feeds = target.listFeeds().map(([feedId, record]) => ({
      id: feedId,
      title: record.title ?? feedId,
      lastFetchedAt: record.lastFetchedAt,
      lastFailure: record.lastFailure,
    }))

    const items: ItemView[] = []
    for (const [feedId, record] of target.listFeeds()) {
      for (const [itemId, item] of target.listItems(feedId)) {
        items.push({
          id: itemId,
          feedId,
          feedTitle: record.title ?? feedId,
          title: item.title,
          link: item.link,
          publishedAt: item.publishedAt,
          fetchedAt: item.fetchedAt,
          readAt: item.readAt,
          starred: item.starred,
          summary: item.summary,
        })
      }
    }
    items.sort((a, b) => {
      const byTime = recencyOf(b).localeCompare(recencyOf(a))
      return byTime !== 0 ? byTime : a.id.localeCompare(b.id)
    })

    return {
      feeds,
      items: items.slice(0, config.maxItemsShown),
      unread: items.filter((item) => item.readAt === undefined).length,
      refreshed,
      // 让界面能说明「上次到底什么时候抓过」——否则「按住刷新没反应」无从判断
      refreshedAt: lastRefreshCompletedAt === undefined ? undefined : new Date(lastRefreshCompletedAt).toISOString(),
    }
  }

  const countUnread = (target: ReaderStore): number =>
    target.listFeeds().reduce((sum, [feedId]) => sum + target.listItems(feedId).filter(([, i]) => i.readAt === undefined).length, 0)

  // 浏览器半的读写通道：宿主自有 HTTP 路由 + connection 的准入检查（见 shared.ts 注释）。
  const dispatch = async (endpoint: string, payload: unknown): Promise<RpcResult<unknown>> => {
    // 不把异常 throw 进通道：调用方需要的是带 code 的失败信封
    try {
      const target = ready()
      if (!target) return fail('not-ready', '存储域尚未就绪，稍后重试')

      switch (endpoint as Endpoint) {
        case 'overview':
          return ok(buildOverview(false))

        case 'refresh': {
          const refreshed = await refreshNow()
          return ok(buildOverview(refreshed))
        }

        case 'markRead': {
          const itemIds = Array.isArray((payload as { itemIds?: unknown } | null)?.itemIds)
            ? ((payload as { itemIds: unknown[] }).itemIds.map(String))
            : []
          if (itemIds.length === 0) return fail('bad-request', 'markRead 需要 itemIds 数组')
          const stamp = new Date().toISOString()
          let changed = 0
          for (const itemId of itemIds) {
            const existing = target.item(itemId)
            if (existing === undefined || existing.readAt !== undefined) continue
            // 幂等：已读的原时间戳不动
            await target.saveItem(itemId, { ...existing, readAt: stamp })
            changed += 1
          }
          return ok({ changed, unread: countUnread(target) })
        }

        case 'unmarkRead': {
          // 只服务于「全部标记已读」的短时撤销
          const itemIds = Array.isArray((payload as { itemIds?: unknown } | null)?.itemIds)
            ? ((payload as { itemIds: unknown[] }).itemIds.map(String))
            : []
          if (itemIds.length === 0) return fail('bad-request', 'unmarkRead 需要 itemIds 数组')
          let changed = 0
          for (const itemId of itemIds) {
            const existing = target.item(itemId)
            if (existing === undefined || existing.readAt === undefined) continue
            // 只去掉 readAt：原先这里调的那个 helper 按 7 个字段重建，会把 article 缓存
            // 一起丢掉——撤销「全部已读」不该动内容缓存（2026-10-07 随三处重建收敛时修掉）
            await target.saveItem(itemId, rebuildItem(existing, { omit: ['readAt'] }))
            changed += 1
          }
          return ok({ changed, unread: countUnread(target) })
        }

        case 'article': {
          // 按需正文（V 键）：先看缓存，再冷却，最后才抓原站。三步都留日志——这是唯一会
          // 出网的用户手势，出问题时必须能从日志里还原过程。
          const itemId = String((payload as { itemId?: unknown } | null)?.itemId ?? '')
          if (!itemId) return fail('bad-request', 'article 需要 itemId')
          const existing = target.item(itemId)
          if (existing === undefined) return fail('not-found', '条目不存在：' + itemId)
          // 命中缓存的前提：**缓存的内容版本等于当前版本**。
          // 老缓存（升级前抓的，只有纯文本 paragraphs）没有版本号 ⇒ 判为过期、自动重抓一次。
          // 否则模型升级后老缓存会永远挡住新逻辑——实测：9 条老缓存导致「图片怎么都不显示」。
          if (existing.article !== undefined && existing.article.revision === ARTICLE_REVISION) {
            return ok({
              itemId, cached: true, title: existing.article.title,
              blocks: existing.article.blocks, paragraphs: existing.article.paragraphs,
              frameable: existing.article.frameable,
            })
          }
          if (existing.link === '') return fail('bad-request', '该条目没有可抓取的链接')

          const lastAt = articleAttempts.get(itemId)
          if (lastAt !== undefined && Date.now() - lastAt < config.articleCooldownMs) {
            const wait = Math.ceil((config.articleCooldownMs - (Date.now() - lastAt)) / 1000)
            return fail('cooldown', '刚刚取过这篇正文，请 ' + wait + ' 秒后再试')
          }
          articleAttempts.set(itemId, Date.now())

          log('取正文：' + existing.link)
          const fetched = await fetchArticle(existing.link, {
            timeoutMs: config.timeoutMs,
            maxBytes: config.articleMaxBytes,
          })
          if (fetched.kind === 'failed') {
            // 失败原因存进条目：用户重开时能看到，且不必再等一次网络往返
            await target.saveItem(itemId, { ...existing, articleFailure: fetched.reason })
            log('取正文失败：' + existing.link + ' → ' + fetched.reason)
            return ok({ itemId, cached: false, failure: fetched.reason })
          }
          const article = {
            fetchedAt: new Date().toISOString(),
            revision: ARTICLE_REVISION,
            title: fetched.title,
            blocks: fetched.blocks,
            frameable: fetched.frameable,
          }
          // 成功要清掉旧的失败原因：交给 rebuildItem（它按 schema 字段表搬运，不会漏字段）
          await target.saveItem(itemId, rebuildItem(existing, { omit: ['articleFailure'], set: { article } }))
          log('取正文成功：' + existing.link + '（' + fetched.blocks.length + ' 块 ' +
            blocksToText(fetched.blocks).length + ' 字符）')
          return ok({ itemId, cached: false, title: article.title, blocks: article.blocks, frameable: article.frameable })
        }

        case 'opmlExport': {
          const feeds = target.listFeeds().map(([feedUrl, record]) => ({
            url: feedUrl, title: record.title, folder: record.folder,
          }))
          return ok({ opml: buildOpml(feeds), feedCount: feeds.length })
        }

        case 'opmlImport': {
          // §3.1：导入时**逐源抓取校验**，坏源单独标注、不阻断其余。
          const text = String((payload as { opml?: unknown } | null)?.opml ?? '')
          if (text.trim() === '') return fail('bad-request', 'opmlImport 需要 opml 文本')
          const parsed = parseOpml(text)
          if (parsed.subscriptions.length === 0) {
            return ok({
              added: 0, existed: 0, failed: [], skipped: parsed.skipped, accepted: [],
            })
          }

          const checked = await validateSubscriptions(
            parsed.subscriptions.map((subscription) => subscription.xmlUrl),
            { limits: { timeoutMs: config.timeoutMs, maxBytes: config.maxBytes }, concurrency: config.importConcurrency },
          )

          const byUrl = new Map(parsed.subscriptions.map((subscription) => [subscription.xmlUrl, subscription]))
          const accepted: Array<{ url: string; title?: string; folder?: string }> = []
          const failed: Array<{ url: string; reason: string }> = []
          let added = 0
          let existed = 0

          for (const result of checked) {
            if (!result.ok) {
              failed.push({ url: result.url, reason: result.reason ?? '校验失败' })
              continue
            }
            const subscription = byUrl.get(result.url)
            const previous = target.feed(result.url)
            existed += previous === undefined ? 0 : 1
            added += previous === undefined ? 1 : 0
            // 已存在的源保留其 folder（用户可能在界面上改过），新源才写入 OPML 的分组
            await target.saveFeed(result.url, {
              url: result.url,
              title: result.title ?? subscription?.title ?? previous?.title,
              folder: previous?.folder ?? subscription?.folder,
              etag: previous?.etag,
              lastModified: previous?.lastModified,
              lastFetchedAt: previous?.lastFetchedAt,
            })
            accepted.push({ url: result.url, title: result.title ?? subscription?.title, folder: previous?.folder ?? subscription?.folder })
          }

          log('导入 OPML：新增 ' + added + ' 源，已存在 ' + existed + ' 源，校验失败 ' + failed.length +
            ' 源，文件内跳过 ' + parsed.skipped.length + ' 项')
          return ok({ added, existed, failed, skipped: parsed.skipped, accepted })
        }

        case 'addFeed': {
          const raw = String((payload as { url?: unknown } | null)?.url ?? '')
          const checked = await validateSubscriptions([raw], {
            limits: { timeoutMs: config.timeoutMs, maxBytes: config.maxBytes },
            concurrency: 1,
          })
          const result = checked[0]
          if (result === undefined || !result.ok) {
            return ok({ added: 0, existed: 0, failed: [{ url: raw, reason: result?.reason ?? '校验失败' }], skipped: [], accepted: [] })
          }
          const previous = target.feed(result.url)
          await target.saveFeed(result.url, {
            url: result.url,
            title: result.title ?? previous?.title,
            folder: previous?.folder,
            etag: previous?.etag,
            lastModified: previous?.lastModified,
            lastFetchedAt: previous?.lastFetchedAt,
          })
          return ok({
            added: previous === undefined ? 1 : 0,
            existed: previous === undefined ? 0 : 1,
            failed: [], skipped: [],
            accepted: [{ url: result.url, title: result.title, folder: previous?.folder }],
          })
        }

        case 'removeFeed': {
          const feedId = String((payload as { url?: unknown } | null)?.url ?? '')
          if (!feedId) return fail('bad-request', 'removeFeed 需要 url')
          const known = target.feed(feedId)
          if (known === undefined) return fail('not-found', '订阅不存在：' + feedId)
          // 连带删掉该源的全部条目与游标——留着孤儿条目只会让人困惑
          const items = target.listItems(feedId)
          for (const [itemId] of items) await target.deleteItem(itemId)
          await target.deleteFeed(feedId)
          log('退订 ' + feedId + '（连带删除 ' + items.length + ' 条条目）')
          return ok({ removed: 1, items: items.length })
        }

        case 'cleanup': {
          // 显式清理（用户点按钮触发，**不设定时器**——交接件验收项之一就是不残留定时器）。
          // 判据刻意保守：已读 + 未星标 + 早于阈值，三个条件缺一不可（见 retention.ts 注释）。
          const cutoff = new Date(Date.now() - config.cleanupAfterDays * 24 * 3600 * 1000).toISOString()
          const all = target.allItems()
          const rows: CleanupRow[] = all.map(([itemId, record]) => ({
            id: itemId,
            starred: record.starred,
            read: record.readAt !== undefined,
            recency: recencyOf(record),
            articleChars: articleCharsOf(record.article),
          }))
          const doomed = selectCleanup(rows, cutoff)
          const freedChars = rows.filter((row) => doomed.includes(row.id))
            .reduce((sum, row) => sum + row.articleChars + (target.item(row.id)?.summary?.length ?? 0), 0)
          for (const itemId of doomed) await target.deleteItem(itemId)
          log('清理：删除 ' + doomed.length + ' 条已读旧条目（阈值 ' + config.cleanupAfterDays + ' 天，释放约 ' +
            freedChars + ' 字符）')
          return ok({ deleted: doomed.length, freedChars, cutoff, unread: countUnread(target) })
        }

        case 'toggleStar': {
          const itemId = String((payload as { itemId?: unknown } | null)?.itemId ?? '')
          if (!itemId) return fail('bad-request', 'toggleStar 需要 itemId')
          const existing = target.item(itemId)
          if (existing === undefined) return fail('not-found', '条目不存在：' + itemId)
          const starred = !existing.starred
          await target.saveItem(itemId, { ...existing, starred })
          return ok({ itemId, starred, unread: countUnread(target) })
        }

        default:
          return fail('unknown-endpoint', '未知端点：' + endpoint)
      }
    } catch (error) {
      log('请求失败（' + endpoint + '）：' + String(error))
      return fail('internal', error instanceof Error ? error.message : String(error))
    }
  }

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
    const dispose = ctx.webServer.register({
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
    return () => {
      dispose()
    }
  }, 'dsh-rss-reader: http route')


  // 存储域与启动刷新：异步部分全在这个 effect 体内
  ctx.effect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const opened = await openDomainWithRetry(ctx, log, () => cancelled)
        if (cancelled) {
          // 取消途中才开出来的域必须立刻关掉：关失败会留下一个无人可及的句柄，名字被占住后
          // 下一代 fiber 会一直撞 already-open（handoff §19 记过这个坑）。所以这里不能像原先
          // 那样把错误吞掉——要和下面的正常关闭一样留下证据。
          await opened.close().catch((error: unknown) => {
            log('取消途中关闭存储域失败：' + String(error))
          })
          return
        }
        domain = opened
        store = createStore(opened)
        const seeded = await seedConfiguredFeeds(store)
        if (seeded > 0) log('新增订阅源种子 ' + seeded + ' 个')
        if (config.refreshOnStart) await refreshNow({ force: true, signal: controller.signal })
        else log('refreshOnStart=false，跳过启动刷新')
      } catch (error) {
        log('装载失败：' + String(error))
      }
    })()
    return async () => {
      cancelled = true
      controller.abort()
      if (domain) {
        // 返回并等待 close：域名字释放前不能让下一代 fiber 撞 already-open
        await domain.close().catch((error: unknown) => {
          log('关闭存储域失败：' + String(error))
        })
      }
    }
  }, 'dsh-rss-reader: storage domain + start refresh')
}