/**
 * 「可调参数」的**唯一判据**（R11，spec D5 / D9）。
 *
 * 为什么单独成模块：同一份范围要同时用在两处 —— ①读 `settings.json` 时逐键校验；
 * ②`saveSettings` 的 patch 校验（02 票）。两处各写一套 min/max 时，一处放宽、一处收紧的
 * 表现是「存得下却读不回」，而且两边看代码都各自正确（ADR-0001 的老教训）。
 * 本模块是纯函数 + 常量，host 与 client 都能直接 import（无 node 依赖）。
 *
 * 默认值**不在这里**：默认值由 `Config({})` 现取（settings 回包下发），否则等于把
 * 「schema 默认」抄成第二份，改 Config 时两边会静默分家（D4.1）。
 */
import { z } from 'zod'

/**
 * 可覆盖键的**显式白名单**（D5）。`feeds` 永远不可覆盖；将来 R8a 的 `rsshubBase`
 * 要以显式白名单新增，不许「顺手支持任意 Config 键」。
 */
export const TUNABLE_KEYS = [
  'refreshFeedsPerRound',
  'refreshConcurrency',
  'minRefreshIntervalMs',
  'cleanupAfterDays',
] as const

export type TunableKey = (typeof TUNABLE_KEYS)[number]

/** 四个键的完整取值（生效值 / 默认值 / 合并后的 config 都长这样）。 */
export type TunableSettings = Record<TunableKey, number>

/** `settings.json` 的 `overrides`：只出现被改过的键（D3 的稀疏覆盖）。 */
export type TunableOverrides = Partial<TunableSettings>

/**
 * 逐键范围（spec §4.1）。`0` 在四个键里语义不同，所以范围与「0 是否合法」必须写在一起：
 *  - `refreshFeedsPerRound = 0` ⇒ 抓全部源（合法）；999 是「源多时一轮会很慢」的上限。
 *  - `refreshConcurrency = 0` ⇒ 非法（没有「零并发」这种调度）。
 *  - `minRefreshIntervalMs = 0` ⇒ 不节流（合法）；上限一天，再大等于关掉自动刷新。
 *  - `cleanupAfterDays = 0` ⇒ **非法**：cutoff = 现在会清光所有已读条目（数据事故）。
 */
const VALUE_SCHEMAS = {
  refreshFeedsPerRound: z.number().int().min(0).max(999),
  refreshConcurrency: z.number().int().min(1).max(32),
  minRefreshIntervalMs: z.number().int().min(0).max(86_400_000),
  cleanupAfterDays: z.number().int().min(1).max(3650),
} satisfies Record<TunableKey, z.ZodType<number>>

/**
 * 校验一个可调值；认不出返回 `undefined`（**不编造**一个夹取后的值）。
 *
 * 读侧与写侧共用这一份：`settings.json` 的坏值靠它逐键丢弃，02 票的保存靠它拒绝非法入参。
 */
export function parseTunableValue(key: TunableKey, value: unknown): number | undefined {
  const parsed = VALUE_SCHEMAS[key].safeParse(value)
  return parsed.success ? parsed.data : undefined
}
