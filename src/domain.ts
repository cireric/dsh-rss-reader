/**
 * 持久化域声明（host 半）。
 *
 * 用宿主自带的 ctx.storageDomain：schema 校验 + 落盘后才 resolve + domain/changed，
 * 迁移/并发/落盘语义由设施负责（交接件 §6：别自己上 SQLite）。
 *
 * 域名与表名必须匹配 UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/（连字符非法，故用下划线）。
 * 记录 schema 用 zod——设施要求；插件 Config 仍用 schemastery——宿主约定。
 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

export const feedRecordSchema = z.object({
  url: z.string().min(1),
  title: z.string().optional(),
  folder: z.string().optional(),
  /** 上次响应的 ETag，回带做条件请求 */
  etag: z.string().optional(),
  lastModified: z.string().optional(),
  lastFetchedAt: z.string().optional(),
  /**
   * 已存正文的内容版本（见 refresh.ts 的 CONTENT_REVISION）。
   * 缺省视为 1（旧的「摘要优先」解析）；版本落后时该源的第一轮抓取会绕开条件请求，
   * 否则源一直回 304、老条目的短摘要永远回填不了。可选字段 ⇒ 老记录照常通过校验。
   */
  contentRevision: z.number().optional(),
  /** 最近一次失败原因；成功后清掉（单源降级，不阻断其余源） */
  lastFailure: z.string().optional(),
}).strict()
export type FeedRecord = z.infer<typeof feedRecordSchema>

/** 抽取后的正文缓存（挂在条目上，与已读态一样只增不减）。 */
export const articleRecordSchema = z.object({
  fetchedAt: z.string(),
  /** 内容版本：缺省视为 1（纯文本老缓存）；低于当前版本时缓存判为过期并重抓 */
  revision: z.number().optional(),
  title: z.string().optional(),
  /**
   * 结构化正文块（段落/标题/代码/图片/列表/引用）。
   * 用 z.unknown() 存是因为 schema 只负责「形状合法的数组」，具体块类型由 article.ts 定义；
   * 老数据里的 paragraphs 字段保留为可选，读取时由客户端兼容（见 ArticleView）。
   */
  blocks: z.array(z.record(z.string(), z.unknown())).optional(),
  /** 站点是否允许被嵌入（决定能不能切「原站视图」）；老缓存缺此字段时按不可嵌处理 */
  frameable: z.boolean().optional(),
  /** 旧版本存过纯文本段落；保留以便读回老缓存，不再写入 */
  paragraphs: z.array(z.string()).optional(),
}).strict()
export type ArticleRecord = z.infer<typeof articleRecordSchema>

export const itemRecordSchema = z.object({
  feedId: z.string().min(1),
  title: z.string(),
  link: z.string(),
  publishedAt: z.string().optional(),
  summary: z.string().optional(),
  fetchedAt: z.string(),
  /**
   * 已读态 = 有值；未读 = 缺省（2026-10-05 定：带 readAt 时间戳粒度，
   * 为「最近已读」留门，省掉日后迁移整张已读表）。
   */
  readAt: z.string().optional(),
  starred: z.boolean(),
  /**
   * 「保持未读」——**独立于 readAt 的用户状态**（规格 §5 不变量 3：kept-unread 不等于没有 read）。
   *
   * 语义按规格 §3.3：被打上之后**直到条目被真正标记为已读才移除**。所以它只保护批量操作
   * （A 全部标为已读会跳过它），而单条打开/显式标记已读会把它一起清掉。
   * 缺省即「未保持」，所以是可选字段 —— 与 starred 的必填布尔不同，这里有「没打标」的自然表达。
   */
  keptUnread: z.boolean().optional(),
  /**
   * 按需抓取的正文缓存（D 方案：V 键触发宿主抓原站 + 抽正文）。
   * 缓存在条目上——重开不再跑网络；失败原因另存 `articleFailure`，两者互斥。
   */
  article: articleRecordSchema.optional(),
  articleFailure: z.string().optional(),
}).strict()
export type ItemRecord = z.infer<typeof itemRecordSchema>

/**
 * 把一个条目记录里的老正文缓存（paragraphs 形态）规范化成结构化块。
 *
 * 纯函数；**返回原对象表示「无需改动」**（调用方靠这个判断要不要写回），所以它可以对全表反复跑、
 * 幂等。没有 paragraphs 就原样返回。
 */
export function normalizeLegacyArticle(record: ItemRecord): ItemRecord {
  const article = record.article
  if (article?.paragraphs === undefined) return record
  // 空的 legacy 段落等于没有缓存：整份丢掉 article，用户下次打开会重抓（本来就是「降级」语义）
  if (article.paragraphs.length === 0) return rebuildItem(record, { omit: ['article'] })
  return rebuildItem(record, {
    set: {
      article: {
        fetchedAt: article.fetchedAt,
        revision: article.revision,
        title: article.title,
        frameable: article.frameable,
        // 老形态每段都是纯文本 ⇒ 一律折成段落块（客户端本来也是这样渲染它们的）
        blocks: article.paragraphs.map((text) => ({ kind: 'p', text })),
      },
    },
  })
}

/**
 * 条目记录的全部字段名，**从 schema 派生而不是手抄一份**。
 *
 * 为什么必须派生：rebuildItem 靠这张表逐字段搬运。手抄一份的话，schema 加了字段而这里忘了加，
 * 重建就会静默丢字段——那正是「手写重建散落三处」这个坏味道本身的成因。
 */
const ITEM_FIELDS = Object.keys(itemRecordSchema.shape) as Array<keyof ItemRecord>

/**
 * 显式重建条目记录：按 schema 的字段表搬运，再叠加改动。
 *
 * 为什么需要它：zod 的 .strict() 不接受 schema 之外的键，「删掉一个字段」不能靠展开加 undefined
 * 糊过去，只能重建。原先这个动作在 index.ts 与 refresh.ts 里手写了三处（去掉 readAt、清正文缓存、
 * 写入新正文），加一个字段要改三处。**而且三份拷贝里已经有一份出了事**：unmarkRead 用的那份把
 * 参数类型声明成 7 个字段，于是「反转已读」时把 article 缓存一起丢掉了（重建只搬运声明过的字段）。
 *
 * - omit：要丢掉的字段
 * - set：要覆盖/新增的字段
 */
export function rebuildItem(
  record: ItemRecord,
  change: { omit?: ReadonlyArray<keyof ItemRecord>; set?: Partial<ItemRecord> } = {},
): ItemRecord {
  const next: Record<string, unknown> = {}
  for (const field of ITEM_FIELDS) {
    if (change.omit?.includes(field) === true) continue
    const value = record[field]
    if (value !== undefined) next[field] = value
  }
  for (const [field, value] of Object.entries(change.set ?? {})) {
    if (value === undefined) delete next[field]
    else next[field] = value
  }
  return next as ItemRecord
}

export const cursorRecordSchema = z.object({
  /**
   * 去重窗口：本次新增的 id 在前（批次内保持 feed 文档顺序，不保证时间序），
   * 其后是历史窗口；截断只丢最老的那批。**只存 id**，与条目保留量解耦：
   * 交接件 §8「去重不是归档」——窗口若跟着保留量一起截短，
   * 滚出窗口的老条目会在下次抓取时被当成新条目重新变成未读。
   */
  seen: z.array(z.string()),
  cursorAt: z.string().optional(),
}).strict()
export type CursorRecord = z.infer<typeof cursorRecordSchema>

/**
 * 域版本 2 = 正文缓存从「纯文本段落」改成「结构化块」（2026-10-07）。
 *
 * 关于「什么时候能删掉 legacy 的 paragraphs 字段」——2026-10-07 实测把两条路都堵死了：
 *
 * ① **不能靠版本号**：spec 的 compatibleVersions 注释说的是「per-record backend 会读version 在列表里
 *    的文档」，而本域用的是默认的 **single** layout ⇒ 版本是**硬相等**检查。实测把 version 升到 2
 *    并声明 compatibleVersions: [1] 之后，打开域直接失败：unit 'rss_reader': stored version 1 !=
 *    expected 2（数据没被写坏，失败发生在任何写入之前，已回滚）。
 * ② **不能靠 onInvalidRecord: 'backup-and-skip'**：那是给「可丢弃的派生数据」的，而 items 表里混着
 *    用户的已读态与星标，skip 会把它们一起丢掉。
 *
 * 所以现状是：**schema 继续声明 paragraphs（只为兼容读）**，而打开域后由 normalizeLegacyArticle
 * 把老缓存就地规范化成 blocks —— 跑过一次之后数据里就不再有 paragraphs。要真正删掉字段，只剩
 * 「换 per-record layout」或「一次性数据迁移脚本」两条路，都得单独评估（不是这一版的事）。
 */
export const readerDomain = defineDomain({
  name: 'rss_reader',
  version: 1,
  tables: {
    feeds: domainTable<string, FeedRecord>(feedRecordSchema),
    items: domainTable<string, ItemRecord>(itemRecordSchema),
    cursors: domainTable<string, CursorRecord>(cursorRecordSchema),
  },
})