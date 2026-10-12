/**
 * 记录 schema 的家（host 半）。
 *
 * **本模块现在是「类型与纯函数的归属」，不再是落盘方案的声明。** 插件的真实数据面已
 * 100% 自持（node:sqlite，落点 $DSH_HOME/storages/rss-reader/，DDL 在 src/storage/db.ts），
 * `ctx.storageDomain` 不再参与运行（见 docs/superpowers/specs/2026-10-11-large-scale-storage.md）。
 * 原来的「别自己上 SQLite」那条约定已作废，理由与实测数字记在 docs/pitfalls.md §4.9。
 *
 * 为什么这些 zod schema 仍然留着（它们是下游真在用的东西）：
 *   - `feedRecordSchema` / `itemRecordSchema` / `cursorRecordSchema` 仍被
 *     src/storage/config-file.ts（写前校验订阅）、src/storage/migrate.ts（读老域文件）、
 *     src/store-sqlite.ts（行记录与 zod 记录的互转）import —— 库侧把行读成这些 zod 类型，
 *     保证「同一份形状」两处不漂。
 *   - `rebuildItem` / `normalizeLegacyArticle` 是纯函数，被 refresh / endpoints /
 *     identity-repair / migrate 直接调用。
 *   - 下文的 `readerDomain`（`defineDomain`）目前**仅**由 src/store.ts 的 `createStore`
 *     使用，而 createStore 是**旧存储域适配器**，只为测试里的「旧实现 ↔ 自持实现」同义性
 *     断言保留（见 tests/overview-paging.test.mjs，也是 scripts/mutation-test.mjs 的判据）。
 *     它已不在生产路径上，但**它让本模块仍 import 存储域包**（defineDomain/domainTable 是
 *     运行期符号，不是类型）⇒ `package.json` 的 peerDependency 与 `build.sh` 的 link_pkg
 *     **暂时都不能删**（删了从零 build 报 TS2307，Task 8 实测）。删它要连 createStore 一起走。
 *
 * 记录 schema 用 zod——与设施的老约定一致，且 z.infer 出的类型是 store/端点/迁移三方
 * 共享的那一份；插件 Config 用 schemastery——那是宿主约定，别混。
 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { DEFAULT_VIEW_PREFERENCES } from './shared.js'

export const feedRecordSchema = z.object({
  url: z.string().min(1),
  title: z.string().optional(),
  folder: z.string().optional(),
  /** 上次响应的 ETag，回带做条件请求 */
  etag: z.string().optional(),
  lastModified: z.string().optional(),
  /** 上次**成功**抓取的时间（200 / 304 都算）；从未成功 ⇒ undefined（界面据此说「没抓过」） */
  lastFetchedAt: z.string().optional(),
  /**
   * 上次**尝试**抓取的时间：成功、304、失败都盖。**陈旧度调度的排序键是它**，不是 lastFetchedAt。
   *
   * 为什么必须是两个字段（2026-10-11 任务 10 修复轮 1，评审实测抓出）：调度若只看「上次成功」，
   * **永久失败**的源永远排在最前 —— 它永远拿不到那个时间戳。这类源一旦 ≥ 每轮上限 K，
   * 每一轮选中的就是同一批失败源，所有健康源从此再也抓不到（实测复现：200 源 / 20 个永久失败 /
   * K=20 ⇒ 60 轮覆盖 0/180 健康源；3 源 / 1 个永久失败 / K=1 ⇒ 0/2）。
   * 「失败的尝试也是一次尝试」—— 盖上尝试时间，它就排到没试过的那些后面去。
   *
   * 为什么不把 lastFetchedAt 直接改成「成功或失败都盖」：那样 UI 契约（shared.ts 的
   * 「从未成功抓取过则为 undefined」）会当场变成谎话 —— 静默改一个已有字段的语义，
   * 正是本仓库反复吃过的漂移。另开一列，两个问题各自只有一个答案。见 docs/pitfalls.md §5.8。
   */
  lastAttemptedAt: z.string().optional(),
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
   * 「去重不是归档」（见 docs/pitfalls.md §5.2）——窗口若跟着保留量一起截短，
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
  /**
   * UI 偏好的**单例槽**（两列布局任务 7 的视图记忆）。
   *
   * 为什么走 global 而不是新增一张表：global 与 tables 并列，**不是表**，所以它既不触发
   * 「域的表集合」变更、也与 version 无关 —— 老用户不必升级数据。原先只有「加表」与
   * 「塞进 Config」两条路，前者要动 schema、后者会把 UI 状态混进订阅源配置面。
   *
   * schema 刻意是 **z.unknown() + 非 null 细化**，不是逐字段的严格形状。两个理由：
   *
   * ① 设施**要求**它拒绝 null（lib/types/spec.d.ts:83-89）：媒介用 null 表示「从未写过」，
   *    可空就会让「存进去的 null」与「没写过」不可区分，重开后静默变回 initial。
   *    所以这条细化只做一件事 —— 把 null 挡在外面。
   * ② 校验分两层：这里只管**媒介层面的合法性**（非 null、任何值都能存），形状归一化交给
   *    shared.ts 的 sanitizeViewPreferences 在**读写两端**做。若把严格形状写在这里，一条存坏的
   *    偏好就会让整个域打不开（invalid-record 是开域失败，不是「这一项读不出来」）——
   *    拿用户的面板当赌注去换一个「schema 更严谨」的外观，不值。
   *
   * ⇓ 老用户（域文件里没有 global）能否打开：**2026-10 实测可以**。构造真实老文件
   *（unit v1、有表无 global，以及 global: null 两种形态），经真实 JsonStorageBackend +
   * DomainFacility 打开：两者都成功，global.get() 回落到 initial，原有表记录原样在，
   * 首次 set 后文件被就地补上 global 且 version 仍是 1。判据在
   * tests/nav-persistence.test.mjs 的「老域（文件里没有 global）能正常打开并回落到 initial」。
   * **不要**因为「文档说可以」就省掉这条用例 —— 这正是本仓库升 version 那次翻车的同一类赌注。
   */
  global: {
    schema: z.unknown().refine((value) => value !== null),
    initial: DEFAULT_VIEW_PREFERENCES as unknown,
  },
  tables: {
    feeds: domainTable<string, FeedRecord>(feedRecordSchema),
    items: domainTable<string, ItemRecord>(itemRecordSchema),
    cursors: domainTable<string, CursorRecord>(cursorRecordSchema),
  },
})