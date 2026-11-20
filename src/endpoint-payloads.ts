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

/** 零入参端点：接受并忽略 payload（与阶段 5 之前的语义一致）。 */
export const noPayload = z.unknown()

/** 单条目端点：`article` / `toggleStar` / `toggleKeepUnread`。 */
export const itemIdPayload = z.object({ itemId: z.string().min(1) })

const itemIdsShape = { itemIds: z.array(z.string().min(1)).min(1) }

/** 批量条目端点：`unmarkRead`。空数组是坏入参，不是「什么都不做」。 */
export const itemIdsPayload = z.object(itemIdsShape)

/** `markRead`：A 键会带 skipKept 与时间范围；单条打开只带 itemIds。 */
export const markReadPayload = z.object({
  ...itemIdsShape,
  skipKept: z.boolean().nullish(),
  // 空串仍是「没有范围」（旧行为）；只判类型，别让 '' 变成「一条都不标」。
  before: z.string().nullish(),
})

/** `duplicateHints`：可选批次，空数组/缺省/null 都表示「没有可提示的条目」，不是错误。 */
export const duplicateHintsPayload = z.object({ itemIds: z.array(z.string().min(1)).nullish() })

const scopeShape = {
  folder: z.string().min(1).nullish(),
  tagId: z.string().min(1).nullish(),
}

/**
 * 浏览器通道把「没有 payload」序列化成 `null`（`browserRpc` 的 `payload ?? null`），
 * 所以范围类端点必须把 `null` / `undefined` 归一成空对象 —— 这是 wire 形状，不是宽容。
 * 漏掉它，首屏与顶栏刷新（无 folder / tagId 的常态）会在真机上直接回 bad-request。
 */
const emptyAsObject = (value: unknown): unknown => (value === null || value === undefined ? {} : value)

/** `refresh`：只带浏览范围（cursor 被忽略，保持旧行为）。 */
export const scopePayload = z.preprocess(emptyAsObject, z.object(scopeShape).refine(
  (scope) => !(scope.folder != null && scope.tagId != null),
))

/** `overview`：浏览范围 + 续页游标。cursor 只判类型，认不出的格式由 decodeCursor 判。 */
export const overviewPayload = z.preprocess(emptyAsObject, z.object({
  ...scopeShape,
  cursor: z.string().nullish(),
}).refine((scope) => !(scope.folder != null && scope.tagId != null)))

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
