/**
 * 「可调参数」的**唯一判据**（R11 D5 / D9，R8a 01 扩成带类型的键表）。
 *
 * 为什么单独成模块：同一份范围要同时用在三处 —— ①读 `settings.json` 时逐键校验；
 * ②`saveSettings` 的 patch 校验（02 票）；③客户端失焦时的本地校验（「非法值零请求」）。
 * 三处各写一套 min/max 时，一处放宽、一处收紧的表现是「存得下却读不回」，而且三边看代码
 * 都各自正确（ADR-0001 的老教训）。
 *
 * 为什么这里是**纯函数 + 纯数据、不 import zod**：客户端也要做同一份校验，而为一个整数范围
 * 把整包 zod 拖进浏览器 bundle 不划算。zod 形状声明仍在 host 侧（`endpoint-payloads.ts`），
 * 但它校验每个值时调用的就是这里的 `parseTunableValue` —— 规则只有这一份。
 *
 * 键表从「四个数字」扩成**带类型的键表**（R8a D2）：数字键有范围，`rsshubBase` 是字符串键、
 * 只有形态校验。判据仍只有 `parseTunableValue` 一个入口：读侧 / 写侧 / 客户端都调它，
 * 按 key 分派到各自的解析器，而不是三处各认一遍类型。
 *
 * 默认值**不在这里**：默认值由 `Config({})` 现取（settings 回包下发），否则等于把
 * 「schema 默认」抄成第二份，改 Config 时两边会静默分家（D4.1）。
 */

/**
 * 数字键（带范围）。从 R11 的四键原样搬来；`TUNABLE_RANGES` 只描述这一组。
 */
export const NUMBER_TUNABLE_KEYS = [
  'refreshFeedsPerRound',
  'refreshConcurrency',
  'minRefreshIntervalMs',
  'cleanupAfterDays',
] as const

/**
 * 字符串键（R8a D1 / D2，R7 02 扩容）。`rsshubBase` 空串 = 功能关闭；不做「猜一个公共实例」。
 * 翻译三键（provider / model / effort）空串 = 未配置 / 回落，**不做语义校验**：
 * 合法路由由模型目录在运行期裁决，抄一份目录进来就会成为第二份真相（spec §5.2）。
 */
export const STRING_TUNABLE_KEYS = [
  'rsshubBase',
  'translateProvider',
  'translateModel',
  'translateEffort',
] as const

/**
 * 布尔键（R7 02，spec §5.2）。`translateNoticeAck` 不是用户可调项：它只由首次外发确认框
 * 写入，设置页不展示开关；但必须进可写白名单，否则 06 票写不进 settings.json。
 */
export const BOOLEAN_TUNABLE_KEYS = ['translateNoticeAck'] as const

/**
 * 可覆盖键的**显式白名单**（R11 D5 / R8a D2 / R7 02）。`feeds` 永远不可覆盖；将来再加键必须同时
 * 决定它属于哪一组（数字 / 字符串 / 布尔），而不是「顺手支持任意 Config 键」。
 */
export const TUNABLE_KEYS = [...NUMBER_TUNABLE_KEYS, ...STRING_TUNABLE_KEYS, ...BOOLEAN_TUNABLE_KEYS] as const

export type NumberTunableKey = (typeof NUMBER_TUNABLE_KEYS)[number]
export type StringTunableKey = (typeof STRING_TUNABLE_KEYS)[number]
export type BooleanTunableKey = (typeof BOOLEAN_TUNABLE_KEYS)[number]
export type TunableKey = (typeof TUNABLE_KEYS)[number]

/** 每个键的取值类型（唯一定义处）。 */
export interface TunableValueByKey {
  refreshFeedsPerRound: number
  refreshConcurrency: number
  minRefreshIntervalMs: number
  cleanupAfterDays: number
  rsshubBase: string
  translateProvider: string
  translateModel: string
  translateEffort: string
  translateNoticeAck: boolean
}

/** 全部可调键的完整取值（生效值 / 默认值 / 合并后的 config 都长这样）。 */
export type TunableSettings = { [K in TunableKey]: TunableValueByKey[K] }

/** `settings.json` 的 `overrides`：只出现被改过的键（D3 的稀疏覆盖）。 */
export type TunableOverrides = Partial<TunableSettings>

/**
 * 键 → 唯一校验器（R8a 评审 7）。读侧 / 写侧 / 端点 patch / 控制器合并都只查这张表，
 * 不再各写一句 `if (key === 'rsshubBase')`。`Record<TunableKey, …>` 让新增键漏配
 * 直接编译失败 —— 表本身是完整性检查，不靠记性。
 *
 * 值的**类型**仍由上面的 `TunableValueByKey` 声明：校验器只回答「这个 unknown 能不能变成
 * 该键的值」，不复制一份类型表。
 */
export const TUNABLE_PARSERS: {
  readonly [K in TunableKey]: (value: unknown) => TunableValueByKey[K] | undefined
} = {
  refreshFeedsPerRound: (value) => parseNumberValue('refreshFeedsPerRound', value),
  refreshConcurrency: (value) => parseNumberValue('refreshConcurrency', value),
  minRefreshIntervalMs: (value) => parseNumberValue('minRefreshIntervalMs', value),
  cleanupAfterDays: (value) => parseNumberValue('cleanupAfterDays', value),
  rsshubBase: parseRsshubBase,
  translateProvider: parseTranslateText,
  translateModel: parseTranslateText,
  translateEffort: parseTranslateText,
  translateNoticeAck: parseBooleanValue,
}

/**
 * 把**已解析**的值写进目标（TunableOverrides 或 Config 都行）。
 *
 * 泛型键让 `target[key]` 保型：调用方不必为了「TS 的索引写入需要收窄」再写五个 if 分支。
 * 校验仍只发生在 `parseTunableValue`，本函数不判值。
 */
export function assignTunableValue<K extends TunableKey>(
  target: TunableOverrides,
  key: K,
  value: TunableValueByKey[K],
): void {
  target[key] = value
}

/**
 * 逐键范围（spec §4.1）。`0` 在四个键里语义不同，所以范围与「0 是否合法」必须写在一起：
 *  - `refreshFeedsPerRound = 0` ⇒ 抓全部源（合法）；999 是「源多时一轮会很慢」的上限。
 *  - `refreshConcurrency = 0` ⇒ 非法（没有「零并发」这种调度）。
 *  - `minRefreshIntervalMs = 0` ⇒ 不节流（合法）；上限一天，再大等于关掉自动刷新。
 *  - `cleanupAfterDays = 0` ⇒ **非法**：cutoff = 现在会清光所有已读条目（数据事故）。
 */
export const TUNABLE_RANGES = {
  refreshFeedsPerRound: { min: 0, max: 999 },
  refreshConcurrency: { min: 1, max: 32 },
  minRefreshIntervalMs: { min: 0, max: 86_400_000 },
  cleanupAfterDays: { min: 1, max: 3650 },
} as const satisfies Record<NumberTunableKey, { readonly min: number; readonly max: number }>

/** 认不出的键（拼错 / 降级残留）与「值不合法」是两件事，判据分开。 */
export function isTunableKey(key: string): key is TunableKey {
  return (TUNABLE_KEYS as readonly string[]).includes(key)
}

/**
 * 「页面级恢复默认会变几项」的**唯一判据**（S5）：生效值 ≠ 默认值的**数字键**，按白名单顺序。
 *
 * 为什么不含 `rsshubBase`：页面级「恢复默认」在「抓取与清理」分区里，文案与 D28 的规则都只
 * 覆盖四个数值参数；RSSHub 分区自带「恢复默认（清空）」（R8a 01）。两处操作各管各的键，
 * 避免点一次数值恢复顺手清掉实例地址。
 *
 * 客户端两处要用它 —— 恢复默认确认框列出的变化项（settings-view）与成功提示「已恢复 N 项」
 * （settings-actions）。两处各写一遍 `filter(...)` 时，判据一旦改动就可能一边算 2 项、
 * 一边说 3 项。宿主 D28 的逐键删/写规则看的是基线，不看生效值；这里只回答「界面上会看到
 * 哪几项变化」，两者职责不同但口径必须一致。
 */
export function changedNumberTunableKeys(
  effective: TunableSettings,
  defaults: TunableSettings,
): NumberTunableKey[] {
  return NUMBER_TUNABLE_KEYS.filter((key) => effective[key] !== defaults[key])
}

/**
 * 校验一个可调值；认不出返回 `undefined`（**不编造**一个夹取后的值）。
 *
 * 读侧、写侧、客户端共用这一份：`settings.json` 的坏值靠它逐键丢弃，保存靠它拒绝非法入参，
 * 界面靠它把非法输入挡在请求之前。重载让调用方按 key 拿到正确类型（数字 / 字符串 / 布尔），
 * 运行时只按 `TUNABLE_PARSERS` 分派 —— 类型判断仍只有这一处。
 */
export function parseTunableValue(key: 'rsshubBase' | 'translateProvider' | 'translateModel' | 'translateEffort', value: unknown): string | undefined
export function parseTunableValue(key: 'translateNoticeAck', value: unknown): boolean | undefined
export function parseTunableValue(key: NumberTunableKey, value: unknown): number | undefined
export function parseTunableValue(key: TunableKey, value: unknown): string | number | boolean | undefined
export function parseTunableValue(key: TunableKey, value: unknown): string | number | boolean | undefined {
  return TUNABLE_PARSERS[key](value)
}

function parseNumberValue(key: NumberTunableKey, value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  const range = TUNABLE_RANGES[key]
  return value >= range.min && value <= range.max ? value : undefined
}

/**
 * 翻译三键的唯一形状判据（R7 02，spec §5.2）：trim；长度 ≤ 200；空串合法。
 *
 * **刻意不做语义校验**：provider 是否存在、model 能不能用由模型目录在运行期裁决。
 * 在这里抄一份允许名单，等于把目录变成第二份真相 —— 模型上下线一次，设置就存不进去。
 */
export function parseTranslateText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length <= 200 ? trimmed : undefined
}

/** 布尔键的唯一判据：只认真正的 boolean，`"true"` / 1 / null 一律拒绝（不编造真值转换）。 */
export function parseBooleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * `rsshubBase` 的唯一判据（spec §4.1）：trim；空串合法；http/https；不带 path / query / hash。
 *
 * 存 `URL.origin` 而不是用户原文：末尾斜杠、默认端口、主机名大小写都在这里归一，订阅候选
 * 拼地址时只面对一种形态。带 userinfo 的地址直接拒绝 —— 它不属于「实例源站」，静默丢掉
 * 凭据会让测试连接看起来配好了却永远 401。
 */
export function parseRsshubBase(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return ''
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined
  if (url.username !== '' || url.password !== '') return undefined
  return url.origin
}
