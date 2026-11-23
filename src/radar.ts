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
 */

import { fetchFeed, type FetchLimits } from './feed/fetch.js'
import { domainCandidates, type RadarRules } from './rsshub.js'

/** 一次 Radar 查询的结果：命中某个注册域，或什么都没命中，或实例级失败。 */
export interface RadarRulesLookup {
  /** 命中的注册域（`domainCandidates` 里的那一个）；没有规则时为 undefined */
  domain?: string
  rules?: RadarRules
  /** 实例级失败的可读原因；有它时 domain / rules 必缺省 */
  failure?: string
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
): Promise<RadarRulesLookup> {
  const origin = base.replace(/\/+$/, '')
  const radarLimits: FetchLimits = { timeoutMs: limits.timeoutMs, maxBytes: limits.maxBytes }

  for (const domain of domainCandidates(hostname)) {
    const fetched = await fetchImpl(origin + '/api/radar/rules/' + domain, {}, radarLimits)
    if (fetched.kind === 'not-modified') {
      // 发现请求不带条件头，正常不该出现 304；出现了当实例故障上报，不静默当成「没有规则」
      return { failure: '实例返回了 304（发现请求不应带条件头）' }
    }
    if (fetched.kind === 'failed') return { failure: fetched.reason }
    if (fetched.body.trim() === '') continue

    let parsed: unknown
    try {
      parsed = JSON.parse(fetched.body)
    } catch {
      return { failure: '响应不是 Radar 规则 JSON' }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { failure: '响应不是 Radar 规则对象' }
    }
    const rules = parsed as RadarRules
    // 「非空规则」= 除 `_name` 外至少有一个数组桶。只有 `_name` 的对象等于没规则，继续回退 ——
    // 否则一个域名的空壳会把更具体的域名候选（可能真有规则）挡在后面。
    if (hasRuleBuckets(rules)) return { domain, rules }
  }
  return {}
}

/** 规则表里是否至少有一个桶（`_name` 与桶共用一层键，不能假设「非 _name 即数组」）。 */
function hasRuleBuckets(rules: RadarRules): boolean {
  return Object.keys(rules).some((key) => key !== '_name' && Array.isArray(rules[key]))
}
