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
   * 按需抓取的正文缓存（D 方案：V 键触发宿主抓原站 + 抽正文）。
   * 缓存在条目上——重开不再跑网络；失败原因另存 `articleFailure`，两者互斥。
   */
  article: articleRecordSchema.optional(),
  articleFailure: z.string().optional(),
}).strict()
export type ItemRecord = z.infer<typeof itemRecordSchema>

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

export const readerDomain = defineDomain({
  name: 'rss_reader',
  version: 1,
  tables: {
    feeds: domainTable<string, FeedRecord>(feedRecordSchema),
    items: domainTable<string, ItemRecord>(itemRecordSchema),
    cursors: domainTable<string, CursorRecord>(cursorRecordSchema),
  },
})