/**
 * 候选的「抓一次 + 按解析结果判定」。
 *
 * 订阅发现（页面声明的候选）与试读（R15 10）问的是同一个问题：「这个地址现在能不能当 feed」。
 * 这条判定原先私有在 subscribe.ts 里；试读要复用它，就提到这里 —— 两处各写一份的话，
 * 「HTTP 200 的 HTML 算不算 feed」「304 怎么报」迟早会给出两套答案。
 */
import type { fetchFeed, FetchLimits } from './fetch.js'
import { NOT_A_FEED_REASON, parseFeed } from './parse.js'

export type CandidateCheck =
  | { ok: true; title: string | undefined; format: string; itemCount: number }
  | { ok: false; reason: string }

/**
 * 抓一个候选并**按解析结果**判定它是不是 feed（不看状态码：有些站点对任意路径都回 200 HTML）。
 * 失败一律带可直接展示的原因 —— 发现列表与试读都要把「这个候选为什么不行」逐条列出来。
 */
export async function checkCandidate(
  candidate: string,
  limits: FetchLimits,
  fetchImpl: typeof fetchFeed,
): Promise<CandidateCheck> {
  const attempt = await fetchImpl(candidate, {}, limits)
  if (attempt.kind === 'failed') return { ok: false, reason: attempt.reason }
  if (attempt.kind === 'not-modified') return { ok: false, reason: '校验请求收到了 304（不应发生）' }
  const parsed = parseFeed(attempt.body, candidate)
  if (parsed.format === 'unknown') return { ok: false, reason: NOT_A_FEED_REASON }
  return { ok: true, title: parsed.title, format: parsed.format, itemCount: parsed.items.length }
}
