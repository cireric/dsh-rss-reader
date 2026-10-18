/**
 * 「按意图变更订阅」的字段合并规则（2026-10-18 H4，从五个调用点的镜像白名单收拢）。
 *
 * 病象：saveFeed 的调用方各自手写「这次要写哪些字段」的显式白名单（refresh 失败/304/200 三处 +
 * opmlImport / addFeed 两处），字段集五处镜像、合并语义靠注释逐处重申 —— 新增 FeedRecord 字段
 * （如未来加 lastErrorCount）要人肉同步五处，漏一处就是静默语义漂移（304 横幅残留事故正是
 * 「展开 previous 把 lastFailure 带回来」这一形态的前科，refresh.ts:296-299 的注释即契约）。
 *
 * 设计（产品拍板 A，2026-10-18）：**判别联合 intent** —— 调用方声明「这次是什么事」，字段合并
 * 规则按 kind 分派在**本文件一处**；漏分支是编译错误（FeedIntent 联合类型 + switch exhaustive），
 * 不是运行期静默漂移。
 *
 * 边界：lifecycle.ts 的种子（saveFeed(feedId, { url })）是**创建**语义，不走这里；
 * FeedRecord schema 不动（存储形状不变，只改写入路径）。
 *
 * 纯 Node ESM、无 IO：合并是纯函数（record in → record out），单测直接喂两侧同输入断言同输出。
 */
import type { FeedRecord } from './domain.js'

export type FeedIntent =
  | {
      /** 刷新成功（200，真的抓到了新内容）：盖两个时间戳、写版本号、**清 lastFailure**。
       *  url 必带：refresh 的首次抓取兼管创建（previous undefined 合法），url 是 FeedRecord 必填键。 */
      kind: 'refresh-success'
      url: string
      stamp: string
      title: string | undefined
      etag: string | undefined
      lastModified: string | undefined
      /** 写回当前内容版本（refresh.ts 的 CONTENT_REVISION）—— 缺了它，正文升级轮会被源 304 卡死 */
      contentRevision: number
    }
  | {
      /** 刷新 304（源说内容没变）：也是**成功** —— 同样盖两个时间戳、清 lastFailure，但保留 etag/lastModified。
       *  url 必带：首次抓取即创建是 refresh 的既有宽容语义。 */
      kind: 'refresh-not-modified'
      url: string
      stamp: string
      /** 升级轮被判 304 时要写回内容版本号，避免每轮重试（refresh.ts 的 needsContentUpgrade 语义） */
      contentRevision: number
    }
  | {
      /** 刷新失败：盖 lastAttemptedAt（失败的尝试也是一次尝试，防饿死）+ 记 lastFailure；**不**盖 lastFetchedAt。
       *  url 必带：失败分支的 ...(previous ?? {}) 旧形态允许首次抓取即失败即创建。 */
      kind: 'refresh-failure'
      url: string
      stamp: string
      reason: string
    }
  | {
      /** 订阅落库（opmlImport / addFeed）：保留既有调度痕迹（lastAttemptedAt），title/folder 按声明合并。
       *  url 必带 —— upsert 的创建路径（新源）靠它，更新路径上它是幂等的同一个键。 */
      kind: 'upsert-subscription'
      url: string
      title: string | undefined
      folder: string | undefined
    }

/**
 * 按 intent 把一条 FeedRecord 合并出来。
 *
 * previous === undefined（源不存在）时的行为按各 kind 的既有语义：
 *  - refresh 三种：此前 refresh 只对已存在的源跑（种子先行），previous undefined 不是合法输入，
 *    按空记录起步让 schema 校验挡住缺 url 的情况（url 由本函数补）。
 *  - upsert-subscription：**创建**也是它的合法语义（addFeed 新源）。
 */
export function applyFeedIntent(previous: FeedRecord | undefined, intent: FeedIntent): FeedRecord {
  // previous === undefined 是**合法输入**：refresh 的首次抓取本来就兼管创建（旧实现
  // 失败分支 ...(previous ?? {})、成功分支 saveFeed 整体写，tests/refresh.test.mjs 的
  // 「首次抓取」用例从未预置源记录）。宽容与旧行为逐字等价；「先种子后刷新」的编排纪律
  // 由 lifecycle 既有代码保证，不在存储层装闸（装闸=改变 refresh 既有语义=行为漂移）。
  // 因此 refresh 三分支的 url 一律取 intent.url（previous 可能没有）；upsert 同理（创建路径）。
  switch (intent.kind) {
    case 'refresh-success':
      // 字段必须显式列出，不能展开 previous：展开会把上一次失败留下的 lastFailure 一起带回来，
      // 于是「502 一闪而过、之后一路 304 成功」的源会永远挂着失败横幅（用户实测：月光博客连续
      // 十几次 not-modified，横幅仍写 HTTP 502）。契约：lastFailure 反映**最近一次**真实结果，
      // 成功（含 304）后清掉 —— 那条「为什么」原是各调用点的注释，现在是本分支的合并语义。
      return {
        url: intent.url,
        title: intent.title ?? previous?.title,
        folder: previous?.folder,
        etag: intent.etag,
        lastModified: intent.lastModified,
        lastFetchedAt: intent.stamp,
        // 调度排序键同样要盖：200 是一次成功的尝试
        lastAttemptedAt: intent.stamp,
        contentRevision: intent.contentRevision,
      }
    case 'refresh-not-modified':
      // 304：保留既有 etag/lastModified（源没给新的），写回 contentRevision 避免每轮重试；
      // lastFailure 同样必须清（304 也是成功，按 domain.ts 的契约）。
      return {
        url: intent.url,
        title: previous?.title,
        folder: previous?.folder,
        etag: previous?.etag,
        lastModified: previous?.lastModified,
        lastFetchedAt: intent.stamp,
        lastAttemptedAt: intent.stamp,
        contentRevision: intent.contentRevision,
      }
    case 'refresh-failure':
      // ⚠️ 失败也要盖 lastAttemptedAt（调度排序键），但**不**盖 lastFetchedAt（那是「上次成功」）。
      // 少了这一行，永久失败的源在调度里永远最旧，≥ K 个就能永久霸占每一轮的窗口 —— 健康源
      // 全军覆没（评审实测：200 源 / 20 个永久失败 / K=20 ⇒ 60 轮覆盖 0/180）。这条分支同时是
      // 「失败源不会被饿死」的唯一承重点，判据在 tests/refresh.test.mjs。
      return {
        ...(previous ?? {}),
        url: intent.url,
        lastAttemptedAt: intent.stamp,
        lastFailure: intent.reason,
      }
    case 'upsert-subscription':
      // 已存在的源保留其 folder（用户可能在界面上改过）；title 按声明合并（OPML 有声明、addFeed 用抓到的）。
      // 显式白名单：不逐字段搬，「源刚试过一次」这个事实会被导入 OPML 抹掉，该源下一轮又被当
      // 「没试过」排到最前（调度键见 refresh.ts 的 stalenessKey）。
      return {
        url: intent.url,
        title: intent.title ?? previous?.title,
        folder: intent.folder ?? previous?.folder,
        etag: previous?.etag,
        lastModified: previous?.lastModified,
        lastFetchedAt: previous?.lastFetchedAt,
        lastAttemptedAt: previous?.lastAttemptedAt,
      }
  }
}
