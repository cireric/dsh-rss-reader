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
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import z from 'schemastery'
import { readerDomain } from './domain.js'
import { createStore, type ReaderStore } from './store.js'
import { refreshFeeds, type FeedOutcome } from './refresh.js'
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

export function apply(ctx: Context, config: Config): void {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const logFile = config.logFile || join(dshHome, 'state', 'dsh-rss-reader', 'reader.log')

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
        feedId = new URL(raw.trim()).toString()
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
      return false
    }
    const subscriptions = target.listFeeds().map(([feedId]) => feedId)
    inFlight = (async () => {
      const outcomes = await refreshFeeds(subscriptions, target, {
        limits: { timeoutMs: config.timeoutMs, maxBytes: config.maxBytes },
        maxItemsPerFeed: config.maxItemsPerFeed,
        maxSeenPerFeed: config.maxSeenPerFeed,
        maxContentChars: config.maxContentChars,
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
    const recencyOf = (item: ItemView): string => item.publishedAt ?? item.fetchedAt
    items.sort((a, b) => {
      const byTime = recencyOf(b).localeCompare(recencyOf(a))
      return byTime !== 0 ? byTime : a.id.localeCompare(b.id)
    })

    return {
      feeds,
      items: items.slice(0, config.maxItemsShown),
      unread: items.filter((item) => item.readAt === undefined).length,
      refreshed,
    }
  }

  /** 显式重建记录并去掉 readAt：zod .strict() 下不该塞一个 undefined 键进去。 */
  const withoutReadAt = (record: {
    feedId: string; title: string; link: string; publishedAt?: string
    summary?: string; fetchedAt: string; starred: boolean
  }): {
    feedId: string; title: string; link: string; publishedAt?: string
    summary?: string; fetchedAt: string; starred: boolean
  } => ({
    feedId: record.feedId,
    title: record.title,
    link: record.link,
    publishedAt: record.publishedAt,
    summary: record.summary,
    fetchedAt: record.fetchedAt,
    starred: record.starred,
  })

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
            await target.saveItem(itemId, withoutReadAt(existing))
            changed += 1
          }
          return ok({ changed, unread: countUnread(target) })
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
          await opened.close().catch(() => undefined)
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