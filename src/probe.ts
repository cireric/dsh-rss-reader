/**
 * 试读：点一下就知道某条候选**现在**能不能取到、有多少条、花多久（R15 10，spec §4.3.3）。
 *
 * 出网逻辑全部收在这里，端点只做接线。三条纪律：
 *  · `ok` 只由**解析结果**决定（复用 feed/candidate-check.ts 的同一份判定），不看 HTTP 200；
 *  · 单条超时固定 15 s —— 实测有成功路由耗时 17.5–20 s，跟着全局 timeoutMs（默认 15 s 但可配小）
 *    走会误杀；
 *  · 私网 / 回环 / 非法协议在出网前就拒，原因统一换成「目标被安全策略拒绝」：fetch 层的原始文案
 *    带 hostname，原样透出等于把内网地址回显到浏览器。
 *
 * 这里**不写库、不碰订阅状态**：试读是只读观测，候选行的「添加」仍走 addFeed 做最终校验。
 */
import type { ProbeResult } from './shared.js'
import { checkCandidate } from './feed/candidate-check.js'
import { blockedReason, fetchFeed, type FetchLimits } from './feed/fetch.js'

/**
 * 单条试读的固定超时（毫秒）。
 *
 * 不用 `min(全局 timeoutMs, 10s)`：实测 rssforever 有 3 条成功路由耗时 17.5–20 s，10 s 会误杀；
 * 全局 timeoutMs 是刷新轮的预算，试读是一次显式交互，值得等更久。
 */
export const PROBE_TIMEOUT_MS = 15000

/** 缓存 10 分钟：候选是「现在能不能用」的观测，过期太快会让用户反复点、反复出网。 */
const CACHE_TTL_MS = 10 * 60 * 1000

/** 进程内缓存上限：候选列表最多 5 条/次，50 条足够覆盖用户的连续试读，超出按插入序淘汰。 */
const CACHE_MAX_ENTRIES = 50

/** 安全策略拒绝的统一话术：不带 host / IP / 协议细节。 */
const BLOCKED_REASON = '目标被安全策略拒绝'

export interface ProbeFeedsDeps {
  /** 出网实现（测试注入桩）；缺省走真实 fetchFeed。 */
  readonly fetchImpl?: typeof fetchFeed
  /** 响应体积上限，继承全局 maxBytes。 */
  readonly maxBytes: number
}

export interface ProbeFeedsOptions {
  /** 测试注入的时钟；缺省 Date.now。缓存 TTL 与 elapsedMs 都用它。 */
  readonly now?: () => number
}

/** 不带 url 的探测结果：缓存里存这一份，url 由每次调用原样回显。 */
type ProbeOutcome = Omit<ProbeResult, 'url'>

interface CacheEntry {
  /** 写入时刻（now() 的毫秒数）。 */
  readonly at: number
  /** 在飞时同一个 Promise：同一 URL 的并发调用只出一次网。 */
  readonly promise: Promise<ProbeOutcome>
}

export type ProbeFeeds = (urls: readonly string[], deps: ProbeFeedsDeps) => Promise<ProbeResult[]>

/**
 * 造一个带独立缓存的试读器。
 *
 * 生产端用文件末尾的 `probeFeeds`（进程级缓存）；测试用工厂拿新缓存与假时钟，
 * 免得用例之间靠「换域名」互相躲缓存。
 */
export function createProbeFeeds(options: ProbeFeedsOptions = {}): ProbeFeeds {
  const cache = new Map<string, CacheEntry>()
  const now = options.now ?? Date.now

  /** 出网 + 解析；失败也走返回值，不让一条坏源炸掉整批。 */
  const runProbe = async (url: string, deps: ProbeFeedsDeps): Promise<ProbeOutcome> => {
    const startedAt = now()
    const limits: FetchLimits = { timeoutMs: PROBE_TIMEOUT_MS, maxBytes: deps.maxBytes }
    try {
      const checked = await checkCandidate(url, limits, deps.fetchImpl ?? fetchFeed)
      const elapsedMs = now() - startedAt
      if (!checked.ok) return { ok: false, reason: publicFailureReason(checked.reason), elapsedMs }
      return { ok: true, format: checked.format, itemCount: checked.itemCount, elapsedMs }
    } catch (error) {
      // 单条失败不拖垮整批（与订阅校验的失败隔离同一条纪律）；原因仍是可展示的一行。
      return {
        ok: false,
        reason: '试读失败：' + (error instanceof Error ? error.message : String(error)),
        elapsedMs: now() - startedAt,
      }
    }
  }

  const probeOne = async (raw: string, deps: ProbeFeedsDeps): Promise<ProbeResult> => {
    const startedAt = now()
    let parsed: URL
    try {
      parsed = new URL(raw.trim())
    } catch {
      return { url: raw, ok: false, elapsedMs: now() - startedAt, reason: '不是合法 URL' }
    }
    // 地址策略必须在出网前判：fetchFeed 自己也会拒，但它的失败文案带 hostname，且那时已经进了
    // DNS 解析。这里先兜住私网 / 回环 / 非法协议，统一成不回显地址的一句话。
    if (blockedReason(parsed.toString()) !== undefined) {
      return { url: raw, ok: false, elapsedMs: now() - startedAt, reason: BLOCKED_REASON }
    }

    const key = parsed.toString()
    const cached = cache.get(key)
    if (cached !== undefined) {
      if (now() - cached.at < CACHE_TTL_MS) return { url: raw, ...(await cached.promise) }
      // 过期条目先删再写：Map.set 改已有键不改变插入顺序，不删的话刚刷新的热门键会排在
      // 最旧的位置，下一次淘汰反而把它自己踢掉。
      cache.delete(key)
    }

    const promise = runProbe(key, deps)
    cache.set(key, { at: now(), promise })
    if (cache.size > CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    return { url: raw, ...(await promise) }
  }

  return async (urls, deps) => Promise.all(urls.map((url) => probeOne(url, deps)))
}

/** 进程级默认实例：缓存随进程存活，跨请求复用。 */
export const probeFeeds = createProbeFeeds()

/**
 * fetch 层失败文案里「带地址」的那几类换成统一话术。
 *
 * `blockedReason` 的原始文案是「拒绝访问内网地址 127.0.0.1」；`resolvedBlockedReason` 还会说
 * 「域名 X 解析到内网地址 Y」，重定向被拒也一样。这些都不能原样回浏览器（A15）。
 */
function publicFailureReason(reason: string): string {
  if (reason.startsWith('重定向被拒') || reason.includes('内网地址') || reason.includes('内网')) {
    return BLOCKED_REASON
  }
  return reason
}
