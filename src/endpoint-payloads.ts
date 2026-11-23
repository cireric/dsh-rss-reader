/**
 * 端点入参的**形状声明**（阶段 5，ADR-0003）。
 *
 * 这里只判形状与类型：键在不在、类型对不对、以及不读任何外部状态的组合规则
 * （folder 与 tagId 互斥、from ≤ to）。业务判定 —— URL 合法性、文件夹/标签/条目是否存在、
 * 比例夹取 —— **仍在 handler**：那些要么读 store、要么读配置，搬进来会让「声明」变成
 * 第二个裁决者（ADR-0001 的教训）。
 *
 * 为什么单独一个文件：共享片段有真实复用（itemId、itemIds、浏览范围、name 各被
 * 多个端点用到），写在 ENDPOINTS 旁边会把同一份形状抄几遍；这里只依赖 zod，
 * `tests/endpoint-payloads.test.mjs` 可以不经 store 直接验契约。
 *
 * 解析只发生一次：`defineEndpoint`（src/endpoints.ts）拿本文件的 schema 做 safeParse，
 * 失败回统一的 bad-request 信封，成功才把已解析的值交给 handler。
 */
import { z } from 'zod'
import { isTunableKey, parseTunableValue } from './settings-schema.js'
import type { TunableOverrides } from './settings-schema.js'

/** 零入参端点：接受并忽略 payload（与阶段 5 之前的语义一致）。 */
export const noPayload = z.unknown()

/**
 * 显示窗的**传输时刻**：只认 `toISOString()` 的形态（毫秒三位 + `Z`）。
 *
 * 为什么收得这么紧（ADR-0005 决定 3）：库里 `published_at` 由 `toIsoUtc` 归一成同一形态，
 * 所以窗口比较才能是**字符串比较**。无毫秒（`...T00:00:00Z`）、带偏移（`+08:00`）、只有日期
 * 这三种形态一旦混进来，比较会静默错位 —— 只有日期的 `'2026-11-20'` 是完整时刻串的前缀
 *（`'2026-11-20' < '2026-11-20T00:00:00.000Z'`，看起来「同一天」却排在最前），带 `+08:00`
 * 偏移的串按字典序排不等于按时间排。这类输入一律在入参层拒绝，绝不进 SQL。
 */
const transferInstant = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  // 形状对、日期不存在的串（如 2026-02-30T00:00:00.000Z）也必须挡住：Date.parse 给 NaN。
  .refine((value) => !Number.isNaN(Date.parse(value)))

/**
 * 显示窗入参片段（ADR-0005 决定 2）：overview / refresh 与五个带账端点**共用同一段**声明。
 *
 * `todayFrom` 只喂未读三联拆分（只在请求给了它时回 `unreadSplit`）；本轮与 from / to 一起在
 * 入参层校验，免得「形状对但值非法」的阈值漏到 04 票的聚合 SQL 里。
 */
const windowShape = {
  from: transferInstant.nullish(),
  to: transferInstant.nullish(),
  todayFrom: transferInstant.nullish(),
}

/**
 * 显示窗的组合规则：`from` / `to` **同进同出**，且给了就必须 `from < to`。
 *
 * 只读入参、不碰外部状态，所以归形状声明（ADR-0003）。`null` 与缺席同义 ——
 * 浏览器通道把缺省序列化成 null 的先例见 emptyAsObject。
 * 「只有一半」是坏入参而不是「半开窗口」：下界与上界缺一，窗口要么无意义、要么退化成全量。
 */
const windowRule = (input: { readonly from?: unknown; readonly to?: unknown }): boolean => {
  const from = input.from ?? undefined
  const to = input.to ?? undefined
  if (from === undefined && to === undefined) return true
  // 类型由 windowShape 的 transferInstant 保证；这里只再核一遍，是为了让 withWindow 的泛型
  // 推断不依赖某一组具体字段（否则 refine 回调的类型会跟着 T 漂移）。
  if (typeof from !== 'string' || typeof to !== 'string') return false
  return from < to
}

/**
 * 带账端点的共用形状：端点自己的字段 + **同一段**显示窗声明（R1 02 决策 14）。
 *
 * 五个带账端点（markRead / unmarkRead / cleanup / toggleKeepUnread / toggleStar）共用下面这份
 * `windowShape` 与 `windowRule`（前四个经 withWindow 组装；cleanup 没有业务字段，直接用它）。
 * 手抄一份 from/to 的后果是某个端点悄悄漏掉 `windowRule`，而那只在坏入参时才显形
 * （ADR-0003 的「声明不是第二个裁决者」）。
 */
const withWindow = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ ...shape, ...windowShape }).refine(windowRule)

/** 单条目端点：`article`（不带账，因此不挂窗口）。 */
export const itemIdPayload = z.object({ itemId: z.string().min(1) })

/**
 * `toggleStar` / `toggleKeepUnread`：单条目 + 账目窗口。
 *
 * 这两个端点不改读态、但回包的账目仍必须按当前窗口算 —— 否则星标一次就把左栏角标打回全量。
 */
export const itemIdWindowPayload = withWindow({ itemId: z.string().min(1) })

const itemIdsShape = { itemIds: z.array(z.string().min(1)).min(1) }

/** 批量条目端点：`unmarkRead`。空数组是坏入参，不是「什么都不做」；带账 → 窗口片段。 */
export const unmarkReadPayload = withWindow(itemIdsShape)

/**
 * `markRead`：两代语义并存（ADR-0008）。
 *
 * - **itemIds**：单条打开 / 搜索态快照（行为逐字不变）；
 * - **范围**（`feedId` / `folder` / `tagId`）或 `all: true`：A 的宿主求值路径 —— 宿主按
 *   「范围 × 过滤 × 显示窗 × before × 未读且非保持未读」在**库全量**上选 id，客户端不再拼 id。
 *
 * `itemIds` / 范围 / `all` **恰好一个**：三者都给就等于「用哪个集合」有两个答案。
 * `dryRun` 只服务确认框的条数（只数不写），只能与范围/all 同用 —— itemIds 的条数客户端自己知道。
 */
const markScopeShape = {
  feedId: z.string().min(1).nullish(),
  folder: z.string().min(1).nullish(),
  tagId: z.string().min(1).nullish(),
  all: z.boolean().nullish(),
}

export const markReadPayload = withWindow({
  // 范围路径下 itemIds 缺席；null 与缺席同义（浏览器通道把缺省序列化成 null）。
  itemIds: z.array(z.string().min(1)).min(1).nullish(),
  skipKept: z.boolean().nullish(),
  // 空串仍是「没有范围」（旧行为）；只判类型，别让 '' 变成「一条都不标」。
  before: z.string().nullish(),
  ...markScopeShape,
  /** 过滤=星标时 true：只标星标的未读条目（与客户端 `visible()` 的过滤同一判据）。 */
  starred: z.boolean().nullish(),
  /** 只数不写：确认框的 N。 */
  dryRun: z.boolean().nullish(),
}).superRefine((value, ctx) => {
  const hasIds = value.itemIds !== undefined && value.itemIds !== null
  const scopes = [value.feedId, value.folder, value.tagId]
    .filter((entry) => entry !== undefined && entry !== null && entry !== '')
  const hasAll = value.all === true
  if (scopes.length > 1) {
    ctx.addIssue({ code: 'custom', path: ['folder'], message: '范围三选一（feedId / folder / tagId）' })
    return
  }
  if ((hasIds ? 1 : 0) + (scopes.length > 0 ? 1 : 0) + (hasAll ? 1 : 0) !== 1) {
    ctx.addIssue({ code: 'custom', path: ['itemIds'], message: 'itemIds / 范围 / all 必须恰好给一个' })
    return
  }
  if (hasIds && value.dryRun === true) {
    ctx.addIssue({ code: 'custom', path: ['dryRun'], message: 'dryRun 只能与范围或 all 同用' })
  }
})

/** `duplicateHints`：可选批次，空数组/缺省/null 都表示「没有可提示的条目」，不是错误。 */
export const duplicateHintsPayload = z.object({ itemIds: z.array(z.string().min(1)).nullish() })

const scopeShape = {
  folder: z.string().min(1).nullish(),
  tagId: z.string().min(1).nullish(),
}

/** 浏览类端点共用的形状：范围（folder / tag 互斥）+ 显示窗（半开区间）。 */
const browseShape = { ...scopeShape, ...windowShape }

/**
 * 浏览器通道把「没有 payload」序列化成 `null`（`browserRpc` 的 `payload ?? null`），
 * 所以范围类端点必须把 `null` / `undefined` 归一成空对象 —— 这是 wire 形状，不是宽容。
 * 漏掉它，首屏与顶栏刷新（无 folder / tagId 的常态）会在真机上直接回 bad-request。
 */
const emptyAsObject = (value: unknown): unknown => (value === null || value === undefined ? {} : value)

/**
 * `cleanup`：唯一业务入参是 `dryRun`（R11 04 / D27.1），但预演与执行**共用同一个端点、同一份
 * selectCleanup** —— 不新开 cleanupPreview 端点，否则「数」与「删」会变成两套判据。
 * 它仍是五个带账端点之一：窗口片段与其它四个共用同一段声明，`null` / 缺省 / 带无关键的对象
 * 必须继续接受（浏览器通道把「没有 payload」序列化成 null）；坏窗口则回自己的 invalidMessage。
 */
export const cleanupPayload = z.preprocess(emptyAsObject, z.object({
  /** 只算不删；缺省 false = 现有执行语义（不传即执行）。 */
  dryRun: z.boolean().optional(),
  ...windowShape,
}).refine(windowRule))

/**
 * `refresh`：浏览范围 + 显示窗（cursor 被忽略，保持旧行为）。
 *
 * refresh 必须带窗口：它回的是同一页 + 同一份账，不带窗口时按一次刷新就把视图从「今天」
 * 悄悄放回「全部」，而按钮上没有任何东西提示这件事（spec 补充说明）。
 */
export const scopePayload = z.preprocess(emptyAsObject, z.object(browseShape)
  .refine((scope) => !(scope.folder != null && scope.tagId != null))
  .refine(windowRule))

/** `overview`：浏览范围 + 显示窗 + 续页游标。cursor 只判类型，认不出的格式由 decodeCursor 判。 */
export const overviewPayload = z.preprocess(emptyAsObject, z.object({
  ...browseShape,
  cursor: z.string().nullish(),
})
  .refine((scope) => !(scope.folder != null && scope.tagId != null))
  .refine(windowRule))

/** `saveReadingProgress`：ratio 是必需键 —— 缺省 0 会把阅读进度静默写回开头。 */
export const saveReadingProgressPayload = z.object({
  itemId: z.string().min(1),
  contentVersion: z.string().min(1),
  ratio: z.number(),
})

export const opmlImportPayload = z.object({ opml: z.string() })

/** `addFeed`：空串仍交给 URL 校验（回 ok + failed），所以这里只要求是字符串。 */
export const addFeedPayload = z.object({ url: z.string() })

export const removeFeedPayload = z.object({ url: z.string().min(1) })

/** `discoverFeeds`：直接给出去空白后的地址（旧行为是 handler 里 trim）。 */
export const discoverFeedsPayload = z.object({ url: z.string().trim().min(1) })

/**
 * `testRsshub`（R8a 01）：只声明「base 是字符串」。
 *
 * 地址形状（http/https、无 path / query / hash）仍由 handler 用 `parseTunableValue` 判 ——
 * 与保存 / 读取是同一份判据；这里若再抄一份，就会出现「测试连接通过、保存被拒」的分家。
 * 空串是合法形状：handler 回一条「未配置」的可展示原因，而不是坏入参。
 */
export const testRsshubPayload = z.object({ base: z.string() })

/** `saveViewPreferences`：preferences 是必需键 —— 缺键会把默认视图静默写盘。值本身仍由 store 归一。 */
export const saveViewPreferencesPayload = z.object({ preferences: z.unknown() })

export const namePayload = z.object({ name: z.string() })

export const idPayload = z.object({ id: z.string() })

export const renameFolderPayload = z.object({ from: z.string(), to: z.string() })

export const renameTagPayload = z.object({ id: z.string(), name: z.string() })

/** `moveFeedToFolder`：folder 键必须显式给出（null = 未分类），缺键 ≠ 移到未分类。 */
export const moveFeedToFolderPayload = z.object({
  feedId: z.string().min(1),
  folder: z.string().nullable(),
})

/**
 * `reorderFeeds`：ids 是必需键，**允许空数组**（= 什么都没点名 ⇒ 不写盘，回当前顺序）。
 * 未知 id 与空串不在这里判：它们是归一问题，不是形状问题 —— 归属 store（src/feed-order.ts）。
 */
export const reorderFeedsPayload = z.object({ ids: z.array(z.string()) })

/** `setItemTags`：tagIds 的形状在这里判；去重与存在性仍在 store（normalizeTagIds）。 */
export const setItemTagsPayload = z.object({
  itemId: z.string().min(1),
  tagIds: z.array(z.string()),
})

const searchDay = z.iso.date().optional()

/** `searchItems`：从 H1 轮沿用下来的唯一一份 schema，规则不变。 */
export const searchQueryPayload = z.object({
  text: z.string().trim().min(1).refine((text) => [...text].length <= 120),
  feedId: z.string().optional(),
  feedIds: z.array(z.string()).optional(),
  tagId: z.string().min(1).optional(),
  read: z.enum(['read', 'unread']).optional(),
  starred: z.boolean().optional(),
  from: searchDay,
  to: searchDay,
  cursor: z.string().max(2048).optional(),
}).refine(({ from, to }) => !from || !to || from <= to)

/**
 * `saveSettings` 的逐键 patch（R11 02，spec D4.1 / D5 / D9）。
 *
 * 形状（record）在这里判，**每个值仍走 `parseTunableValue`** —— 范围判据只有
 * `settings-schema.ts` 一份。用 `superRefine` 而不是给四个键各写一遍 `.min().max()`：
 * 后者就是第二份范围表，改一处漏一处时表现为「存得下却读不回」。
 *
 * 空 patch **合法**（D4.1 的 `Partial<Record<Key, number>>` 允许空对象）：它是「没有要改的项」，
 * 由 `settings-control.ts` 明确处理成无操作成功 —— 不写盘、不改内存。未知键仍然 rejected：
 * 「空」与「乱写」是两件事，只有前者能安全地当空操作。
 */
const tunablePatch = z.record(z.string(), z.unknown()).superRefine((patch, ctx) => {
  for (const [key, value] of Object.entries(patch)) {
    if (!isTunableKey(key)) {
      ctx.addIssue({ code: 'custom', path: [key], message: '不是可设置的键' })
      continue
    }
    if (parseTunableValue(key, value) === undefined) {
      ctx.addIssue({ code: 'custom', path: [key], message: '值不合法' })
    }
  }
}).transform((patch): TunableOverrides => {
  // superRefine 通过后才跑到这里：此时每个键都是白名单键、每个值都能被同一判据解析成整数。
  // 仍然复用 isTunableKey / parseTunableValue 做收窄与取值，不 cast、不另写一套判断。
  const overrides: TunableOverrides = {}
  for (const [key, value] of Object.entries(patch)) {
    if (!isTunableKey(key)) continue
    // 数字键与字符串键分开写只为让 TS 的索引写入收窄；取值仍来自同一个 parseTunableValue。
    if (key === 'rsshubBase') {
      const parsed = parseTunableValue('rsshubBase', value)
      if (parsed !== undefined) overrides.rsshubBase = parsed
      continue
    }
    const parsed = parseTunableValue(key, value)
    if (parsed !== undefined) overrides[key] = parsed
  }
  return overrides
})

/**
 * `saveSettings` 入参（R11 02，spec D4.1）：`{ patch }` 与 `{ resetToDefaults: true }` **二选一**。
 *
 * 为什么用 union 而不是一个可选字段对象 + refine：union 让 handler 能按分支窄化类型，
 * 不必再写一个「patch 可能缺席」的死分支。`resetToDefaults` 的逐键「删覆盖 / 写默认」判断在
 * `settings-control.ts`（D28）：端点只验 `true` 字面量，把动作转成信封。
 */
export const saveSettingsPayload = z.union([
  z.strictObject({ patch: tunablePatch }),
  z.strictObject({ resetToDefaults: z.literal(true) }),
])
