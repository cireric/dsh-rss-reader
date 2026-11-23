/**
 * RSSHub Radar 的**取规则**层（R8a 03）：网络 + 域名逐级回退，规则推导仍留在 rsshub.ts。
 *
 * 为什么单独一个模块而不是塞进 rsshub.ts：那个模块的承诺是「纯函数、零网络、零配置」，
 * 规则推导的正确性能用静态样本钉死，不被网络错误、缓存、超时淹没（见 rsshub.ts 顶部）。
 * 03 票只在发现流程里用一次「取一份规则表」；04 票的缓存也应当挂在这里（见交付报告的接口提示）。
 *
 * 失败分型刻意只有两级：
 *  - 空 body = **该域名没有规则**（实测实例回 200 + 空 body，不是 404）⇒ 继续下一个域名候选；
 *  - 不可达 / 非 2xx / 非 JSON ⇒ 实例级失败，整条 Radar 支路只产一条警告。
 *
 * 缓存（04 票，spec §4.4 / D8）只挂在**域名请求**这一层：同一个实例 + 同一级域名查过就不再出网。
 * 键含实例地址 ⇒ 换实例后旧条目在构造上不可能命中，不需要也不该在构造外写清空逻辑。
 */

import { fetchFeed, type FetchLimits } from './feed/fetch.js'
import { domainCandidates, type RadarRules } from './rsshub.js'
import { parseRsshubBase } from './settings-schema.js'

/** 成功（含「该域名没有规则」）缓存 6 小时。 */
const CACHE_SUCCESS_MS = 6 * 60 * 60 * 1000
/** 失败只缓存 60 秒：实例抖一下不该把整段发现流程钉死六小时。 */
const CACHE_FAILURE_MS = 60 * 1000
/** 键上限 64；超了按 Map 的插入序删最旧。 */
const CACHE_MAX_ENTRIES = 64

/**
 * 单个「实例 + 域名」的结果。刻意只有规则 / 空 / 失败三种 —— 不放 limits、fetchImpl 或任何
 * 调用方参数：缓存的是**这个实例对这个域名的答案**，不是某一次调用的请求条件。命中后直接返回
 * 数据；真正的出网请求（以及私网地址判定）只发生在未命中时，且用本次调用重建的 limits。
 */
type DomainOutcome =
  | { kind: 'rules'; rules: RadarRules }
  | { kind: 'empty' }
  | { kind: 'failure'; reason: string }

interface CachedOutcome {
  value: DomainOutcome
  /** 过期时刻（毫秒，取自可注入时钟）。 */
  expiresAt: number
}

/** 进程内缓存，不落盘；重启即空。键 = 实例地址 + '\n' + 实际请求的域名。 */
const radarCache = new Map<string, CachedOutcome>()

/**
 * 清空进程内缓存——**只给测试隔离用**。生产路径不需要它：换实例由键里的实例地址自然隔离，
 * 过期由每条记录自己的 expiresAt 处理。测试文件之间共享同一个进程模块实例，必须显式复位。
 */
export function clearRadarCache(): void {
  radarCache.clear()
}

/** `lookupRadarRules` 的可选参数：缓存判定用的时钟可注入，测试不必 sleep。 */
export interface RadarLookupOptions {
  now?: () => number
}

/**
 * 一次 Radar 查询的结果：命中某个注册域 / 确认没有规则 / 实例级失败。
 *
 * 三态用联合而不是三个可选字段：可选字段允许「既没有规则也没有失败」这种第四个状态，
 * 调用方必须自己约定「都缺省 = 没规则」，两处理解一漂就分不清「查空」与「没查」。
 */
export type RadarRulesLookup =
  | { readonly kind: 'rules'; readonly domain: string; readonly rules: RadarRules }
  | { readonly kind: 'empty' }
  | { readonly kind: 'failure'; readonly reason: string }

/**
 * 实例的规则地址：`{base}/api/radar/rules/{domain}`。
 *
 * 这是**唯一**拼法：`testRsshub` 探活与发现流程的取规则都调它，否则两处各自拼字符串，
 * 一处加尾斜杠处理、一处忘了，就会出现「测试通过但发现请求打到别的路径」。
 */
export function radarRulesUrl(base: string, domain: string): string {
  return base + '/api/radar/rules/' + domain
}

/**
 * 这份 JSON 是不是一份**可用**的 Radar 规则表：非 null、非数组对象，且至少有一个数组桶。
 *
 * 为什么不能只判 `JSON.parse` 成功：`[]` / `null` / `{}` / 只有 `_name` 的空壳都会通过，
 * 一个返回任意 JSON 的网关就会被 testRsshub 判成 RSSHub。发现流程与 testRsshub 共用这一份判据。
 */
export function isRadarRules(value: unknown): value is RadarRules {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return hasRuleBuckets(value as Record<string, unknown>)
}

/**
 * 逐级回退取规则：`{base}/api/radar/rules/{domain}`，最短域名优先，**第一个非空规则表胜出即停**。
 *
 * 为什么最短优先：实例端不做子域回退（实测 `www.zhihu.com` → 空、`zhihu.com` → 2.9KB），
 * 所以必须从注册域那层往上加；`domainCandidates` 已把候选封顶 4 个（最多 4 次请求）。
 *
 * 出网安全（spec §4.6 / A9）：这里**重建** limits，只带超时与体积 —— 调用方给页面用的
 * `trustedTarget: true` 绝不能顺延到实例地址上，否则 `http://127.0.0.1:1200` 会被放行。
 * 重建而不是 `{...limits, trustedTarget: false}`：白名单式传参，将来 fetch 层加字段也不会被
 * 悄悄继承（Radar 的目标由用户配置的实例地址决定，不是「用户配置的订阅目标」那类可信目标）。
 */
export async function lookupRadarRules(
  base: string,
  hostname: string,
  limits: FetchLimits,
  fetchImpl: typeof fetchFeed = fetchFeed,
  options: RadarLookupOptions = {},
): Promise<RadarRulesLookup> {
  // 归一化只认 parseRsshubBase 这一份（settings 面与这里共用）：profile patch 直接塞
  // `https://x/api` 时在这里就被判非法，既不会拼出 `…/api/api/radar/…`，也不会发出请求。
  // 空串是「未配置」，由发现流程早退；这里不替调用方兜底 —— 漏判应该以一次可见的请求暴露，
  // 而不是被本层悄悄吞成一条失败警告。
  const origin = base === '' ? '' : parseRsshubBase(base)
  if (origin === undefined) {
    return { kind: 'failure', reason: '实例地址不合法（只支持 http(s) 源站，不能带路径 / 查询 / 参数）' }
  }
  // 每次调用都重建：白名单式只带超时与体积，调用方的 trustedTarget 永远不进 Radar 请求，
  // 也不进缓存（缓存里只有 DomainOutcome）。
  const radarLimits: FetchLimits = { timeoutMs: limits.timeoutMs, maxBytes: limits.maxBytes }
  const now = options.now ?? Date.now

  for (const domain of domainCandidates(hostname)) {
    const key = origin + '\n' + domain
    const cached = readCached(key, now())
    if (cached !== undefined) {
      if (cached.kind === 'failure') return { kind: 'failure', reason: cached.reason }
      if (cached.kind === 'rules') return { kind: 'rules', domain, rules: cached.rules }
      // 空结果 = 这个域名没有规则，继续回退到下一个候选。
      continue
    }

    const fetched = await fetchImpl(radarRulesUrl(origin, domain), {}, radarLimits)
    if (fetched.kind === 'not-modified') {
      // 发现请求不带条件头，正常不该出现 304；出现了当实例故障上报，不静默当成「没有规则」
      return cacheFailure(key, '实例返回了 304（发现请求不应带条件头）', now())
    }
    if (fetched.kind === 'failed') return cacheFailure(key, fetched.reason, now())
    if (fetched.body.trim() === '') {
      writeCached(key, { kind: 'empty' }, CACHE_SUCCESS_MS, now())
      continue
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(fetched.body)
    } catch {
      return cacheFailure(key, '响应不是 Radar 规则 JSON', now())
    }
    if (isRadarRules(parsed)) {
      writeCached(key, { kind: 'rules', rules: parsed }, CACHE_SUCCESS_MS, now())
      return { kind: 'rules', domain, rules: parsed }
    }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // 是对象但没有规则桶（如只有 `_name` 的空壳）⇒ 这个域名没有规则，继续回退 ——
      // 否则一个域名的空壳会把更具体的域名候选（可能真有规则）挡在后面。
      writeCached(key, { kind: 'empty' }, CACHE_SUCCESS_MS, now())
      continue
    }
    return cacheFailure(key, '响应不是 Radar 规则对象', now())
  }
  return { kind: 'empty' }
}

/** 命中才返回；过期条目顺手删掉（下次写回会排到插入序末尾）。 */
function readCached(key: string, now: number): DomainOutcome | undefined {
  const entry = radarCache.get(key)
  if (entry === undefined) return undefined
  if (now < entry.expiresAt) return entry.value
  radarCache.delete(key)
  return undefined
}

/** 写入并维持 64 键上限：按插入序删最旧，命中不刷新顺序（spec 要求的是插入序）。 */
function writeCached(key: string, value: DomainOutcome, ttlMs: number, now: number): void {
  // 先删再写：过期键重新请求后必须回到插入序末尾，否则「删最旧」会先误杀刚刷新过的键。
  radarCache.delete(key)
  radarCache.set(key, { value, expiresAt: now + ttlMs })
  while (radarCache.size > CACHE_MAX_ENTRIES) {
    const oldest = radarCache.keys().next().value
    if (oldest === undefined) break
    radarCache.delete(oldest)
  }
}

/** 失败结果统一按短 TTL 缓存，并把原因原样交给调用方。 */
function cacheFailure(key: string, reason: string, now: number): RadarRulesLookup {
  writeCached(key, { kind: 'failure', reason }, CACHE_FAILURE_MS, now)
  return { kind: 'failure', reason }
}

/** 规则表里是否至少有一个桶（`_name` 与桶共用一层键，不能假设「非 _name 即数组」）。 */
function hasRuleBuckets(rules: Record<string, unknown>): boolean {
  return Object.keys(rules).some((key) => key !== '_name' && Array.isArray(rules[key]))
}
