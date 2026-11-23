/**
 * 归档页回溯的**宿主编排**（R9 02）。
 *
 * 一次运行 = 一页归档页 + 一个篇数上限：读页 → 抽链接 → 用该源已有条目的形态筛候选 →
 * 串行抓正文与发布日期 → 入库 → 回一份逐条能读的报告（spec §4.3–4.8）。
 *
 * **全部依赖都由调用方注入**（store / config / 两个抓取实现 / now / sleep / log）：
 * 这条路径既有网络又有存储，还把 300ms 间隔与 120s deadline 写成了常量。任何一处走模块全局，
 * 测试就只能真出网、真等待，而这里要钉的恰好是「第几篇之后停」「间隔多少」「失败是否继续」。
 *
 * 依赖方向：本模块只 import 纯函数与抓取层，不 import endpoints —— 在途闸门与信封映射是端点
 * 的职责，这里只负责「一次运行」本身的语义。
 */
import { EXTRACTOR_REVISION, fetchArticle } from './article.js'
import type { Config } from './config.js'
import { sameArticleKeyOf } from './duplicates.js'
import { fetchFeed } from './feed/fetch.js'
import { deriveItemId } from './feed/item-id.js'
import { deriveLinkFilter, extractArchiveLinks, selectBackfillCandidates } from './history.js'
import type { BackfillFailure, BackfillReport } from './shared.js'
import type { ReaderStore } from './store.js'

/** 串行抓取的固定间隔（spec §4.3）：礼貌承诺，不进设置页。 */
const FETCH_INTERVAL_MS = 300

/** 单轮运行预算（spec §4.3）：到点不再发起新请求；已发起的请求由 fetch 层自己的 timeout 收尾。 */
const RUN_DEADLINE_MS = 120_000

/** 一次回溯的入参（端点的 payload 已在 `endpoint-payloads.ts` 声明形状）。 */
export interface BackfillInput {
  readonly feedId: string
  readonly archiveUrl: string
  /** 最多尝试的候选篇数（= 归档页文档顺序的前 N 条）。 */
  readonly limit: number
}

/** 一次回溯的依赖；除 store / config 外都给了生产默认值，测试可逐项替换。 */
export interface BackfillDeps {
  readonly store: ReaderStore
  readonly config: Config
  /** 归档页抓取（默认 `fetchFeed`）；测试注入桩件。 */
  readonly fetchFeedImpl?: typeof fetchFeed
  /** 文章页抓取（默认 `fetchArticle`）；测试注入桩件。 */
  readonly fetchArticleImpl?: typeof fetchArticle
  /** 时钟（默认 `() => new Date()`）：deadline 与 fetchedAt 都读它。 */
  readonly now?: () => Date
  /** 等待（默认 setTimeout）；测试用假实现记录间隔与推进时钟。 */
  readonly sleep?: (ms: number) => Promise<void>
  /** 运行日志（默认丢弃）；失败原因已经进报告，这里只留可诊断的轨迹。 */
  readonly log?: (message: string) => void
}

/** 预期内的失败码：端点据此回带 code 的失败信封，而不是 internal。 */
export type BackfillErrorCode = 'bad-request' | 'conflict' | 'not-found'

/**
 * 回溯的**预期失败**：源不存在 / 样本不足 / 上限余量为零 / 归档页读不出来。
 * 其它异常（存储写失败等）原样抛出，由 dispatch 兜成 internal —— 不把基础设施故障伪装成用户输入。
 */
export class BackfillError extends Error {
  readonly code: BackfillErrorCode

  constructor(code: BackfillErrorCode, message: string) {
    super(message)
    this.name = 'BackfillError'
    this.code = code
  }
}

/** 每源保留上限：非法 / 未配置 ⇒ 不限（与 refresh 的 prune 同一条纪律）。 */
function maxItemsOf(config: Config): number {
  const value = config.maxItemsPerFeed
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : Number.POSITIVE_INFINITY
}

/** 去重窗口上限：非法 / 未配置 ⇒ 不截断（与 refresh 写 seen 的规则逐字一致）。 */
function seenLimitOf(config: Config): number {
  const value = config.maxSeenPerFeed
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : Number.POSITIVE_INFINITY
}

/** 默认等待实现；单独一个小函数是为了让 `sleep` 的注入点只有一处。 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}

/**
 * 跑一次回溯。
 *
 * 预检（订阅存在 / 样本至少 3 条 / 每源上限有余量）**先于任何出网**：这三条都只读本地状态，
 * 不满足时用户应当马上得到「这个源现在不能回溯」，而不是先替他去抓一页归档页（spec A3 / A10）。
 */
export async function backfillHistory(input: BackfillInput, deps: BackfillDeps): Promise<BackfillReport> {
  const { store, config } = deps
  const now = deps.now ?? (() => new Date())
  const doFetchFeed = deps.fetchFeedImpl ?? fetchFeed
  const doFetchArticle = deps.fetchArticleImpl ?? fetchArticle
  const sleep = deps.sleep ?? defaultSleep
  const log = deps.log ?? (() => {})

  if (store.feed(input.feedId) === undefined) {
    throw new BackfillError('not-found', '订阅源不存在：' + input.feedId)
  }

  const startedAt = now().getTime()
  const stamp = new Date(startedAt).toISOString()

  const currentItems = store.listItems(input.feedId)
  const sampleLinks = currentItems.map(([, record]) => record.link)
  const filter = deriveLinkFilter(sampleLinks)
  if (filter === undefined) {
    throw new BackfillError('bad-request', '样本不足，无法判断文章链接形态（至少需要 3 条已有条目）')
  }

  const maxItems = maxItemsOf(config)
  const headroom = Number.isFinite(maxItems) ? Math.max(0, maxItems - currentItems.length) : Number.POSITIVE_INFINITY
  if (headroom === 0) {
    throw new BackfillError('conflict', '该源已达每源保留上限（' + maxItems + ' 条），请先调大上限或清理条目')
  }

  const archive = await doFetchFeed(input.archiveUrl, {}, {
    timeoutMs: config.timeoutMs,
    maxBytes: config.maxBytes,
    // 归档页是用户主动粘贴的目标：与 addFeed 同一策略（允许自建 / 内网）。
    // 文章页则**不带**这个标志，由 fetchArticle 走不可信目标策略（spec §4.7）。
    trustedTarget: true,
  })
  if (archive.kind === 'failed') {
    throw new BackfillError('bad-request', '读取归档页失败：' + archive.reason)
  }
  if (archive.kind === 'not-modified') {
    // 归档页请求从不带条件请求凭据，304 只能说明对方行为异常；当作读取失败而不是「没有链接」。
    throw new BackfillError('bad-request', '读取归档页失败：归档页返回 304（未传条件请求，异常）')
  }

  const links = extractArchiveLinks(archive.body, archive.finalUrl)
  const matchedLinks = links.filter(filter)

  // 已知同文键：只为报告里的 existing 计数预演一次；判重规则本身仍只在 sameArticleKeyOf 一处。
  const knownKeys = new Set<string>()
  for (const link of sampleLinks) {
    const key = sameArticleKeyOf(link)
    if (key !== '') knownKeys.add(key)
  }
  let existing = 0
  for (const link of matchedLinks) {
    const key = sameArticleKeyOf(link)
    if (key !== '' && knownKeys.has(key)) existing += 1
  }

  const candidates = selectBackfillCandidates({ links, filter, knownLinks: sampleLinks, limit: input.limit })
  // 实际抓取上限 = min(请求篇数, 余量)；候选本身已按请求篇数截断，所以 min 只需再夹一次余量。
  const attemptCap = Math.min(input.limit, headroom)
  const cursor = store.cursor(input.feedId)
  const previousSeen = cursor?.seen ?? []
  const seenIds = new Set(previousSeen)
  const failures: BackfillFailure[] = []
  const newIds: string[] = []
  let attempted = 0
  let added = 0
  let stoppedBy: 'deadline' | 'limit' | undefined

  log('回溯开始：' + input.feedId + ' ← ' + input.archiveUrl + '（样本 ' + sampleLinks.length + ' 条，候选 ' + candidates.length + ' 条）')

  let index = 0
  for (const url of candidates) {
    // 余量把候选截短了：余量用尽后不再发起请求，并如实报告「受每源上限限制」。
    if (attempted >= attemptCap) { stoppedBy = 'limit'; break }
    // 第一篇立即抓；之后每篇前等 300ms（spec §4.3 的礼貌承诺）。
    if (index > 0) await sleep(FETCH_INTERVAL_MS)
    index += 1
    // 检查必须在**发起请求之前**：到点后再发一篇就是越过了单轮预算。
    if (now().getTime() - startedAt >= RUN_DEADLINE_MS) { stoppedBy = 'deadline'; break }
    attempted += 1
    const fetched = await doFetchArticle(url, {
      timeoutMs: config.timeoutMs,
      // 正文的独立上限：单篇文章比 feed 大，沿用 article 端点的同一个配置键（spec §4.7）。
      maxBytes: config.articleMaxBytes,
    })
    if (fetched.kind === 'failed') {
      // 单篇失败只记一条、继续下一篇；不重试（spec §4.3）。
      failures.push({ url, reason: fetched.reason })
      log('回溯失败：' + url + ' → ' + fetched.reason)
      continue
    }
    const title = fetched.title?.trim() ?? ''
    if (title === '') {
      failures.push({ url, reason: '没有可识别的标题' })
      continue
    }
    const publishedAt = fetched.publishedAt
    if (publishedAt === undefined) {
      // 日期必须真实：认不出就跳过，绝不拿抓取时间冒充（spec §4.4 / A6）。
      failures.push({ url, reason: '无发布日期' })
      continue
    }

    const itemId = deriveItemId(input.feedId, { link: url })
    const key = sameArticleKeyOf(url)
    if (store.item(itemId) !== undefined || seenIds.has(itemId) || (key !== '' && knownKeys.has(key))) {
      // 判重范围 = 该源现有条目 + 本次已入库（spec §4.5）；seen 里的老 id 也算「见过」，
      // 否则回溯会把被保留量裁掉的老文章重新写成一条未读。
      existing += 1
      continue
    }

    await store.saveItem(itemId, {
      feedId: input.feedId,
      title,
      link: url,
      publishedAt,
      fetchedAt: stamp,
      starred: false,
      // 正文缓存与「打开时再抓」写的是同一份形状；revision 必须跟着抽取器走，否则下次打开会重抓。
      article: {
        fetchedAt: stamp,
        revision: EXTRACTOR_REVISION,
        title,
        blocks: fetched.blocks,
        frameable: fetched.frameable,
      },
    })
    newIds.push(itemId)
    seenIds.add(itemId)
    if (key !== '') knownKeys.add(key)
    added += 1
  }

  if (newIds.length > 0) {
    // 去重窗口的写入规则与 refresh 完全一致：本次新增在前（批次内保持归档页文档顺序），
    // 历史窗口在后，只截断最老的那批。非法上限 ⇒ 不截断。
    const seenLimit = seenLimitOf(config)
    const nextSeen = [...newIds, ...previousSeen]
    await store.saveCursor(input.feedId, {
      seen: Number.isFinite(seenLimit) ? nextSeen.slice(0, seenLimit) : nextSeen,
      ...(cursor?.cursorAt === undefined ? { cursorAt: stamp } : { cursorAt: cursor.cursorAt }),
    })
  }

  const remaining = candidates.length - attempted
  if (remaining === 0) stoppedBy = undefined
  log('回溯结束：' + input.feedId + ' 新增 ' + added + ' 篇，失败 ' + failures.length + ' 篇，剩余 ' + remaining + ' 篇')

  return {
    feedId: input.feedId,
    archiveUrl: input.archiveUrl,
    sampleCount: sampleLinks.length,
    archiveLinks: links.length,
    matched: matchedLinks.length,
    existing,
    attempted,
    added,
    failures,
    ...(stoppedBy === undefined ? {} : { stoppedBy }),
    remaining,
  }
}
