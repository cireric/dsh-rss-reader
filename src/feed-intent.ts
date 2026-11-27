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
       *  url 必带：FeedRecord 的必填键。previous undefined 时由本函数补；能否落库由 store 的
       *  updateFeed 裁决（refresh 意图要求源已存在，见文件头）。 */
      kind: 'refresh-success'
      url: string
      stamp: string
      title: string | undefined
      etag: string | undefined
      lastModified: string | undefined
      /** 写回当前内容版本（refresh.ts 的 CONTENT_REVISION）—— 缺了它，正文升级轮会被源 304 卡死 */
      contentRevision: number
      /** RSSHub 来源（R15 02）：新值优先，否则沿用 previous。漏了这个字段，每刷新一次来源消失一次。 */
      rsshub?: FeedRecord['rsshub']
    }
  | {
      /** 刷新 304（源说内容没变）：也是**成功** —— 同样盖两个时间戳、清 lastFailure，但保留 etag/lastModified。
       *  url 必带：FeedRecord 的必填键（previous undefined 时由本函数补；store 仍要求源已存在）。 */
      kind: 'refresh-not-modified'
      url: string
      stamp: string
      /** 升级轮被判 304 时要写回内容版本号，避免每轮重试（refresh.ts 的 needsContentUpgrade 语义） */
      contentRevision: number
      /** RSSHub 来源（R15 02）：与 200 同一份逐字段重建，必须显式带上，否则 304 一轮就丢。 */
      rsshub?: FeedRecord['rsshub']
    }
  | {
      /** 刷新失败：盖 lastAttemptedAt（失败的尝试也是一次尝试，防饿死）+ 记 lastFailure；**不**盖 lastFetchedAt。
       *  url 必带：FeedRecord 的必填键（previous undefined 时由本函数补；store 仍要求源已存在）。 */
      kind: 'refresh-failure'
      url: string
      stamp: string
      reason: string
    }
  | {
      /** 订阅落库（opmlImport / addFeed）：保留既有调度痕迹（lastAttemptedAt），title 按声明合并。
       *
       *  `folder` 只用于**新源**的初始分组；**已存在的源一律保留本地 `feed.folder`，包括本地是
       *  「未分类」的情况**。为什么不能写成 `intent.folder ?? previous?.folder`：那会让「本地未分类 +
       *  OPML 里有分组」的重复导入被套上 OPML 分组 —— 用户手动移出分类的归属会被一次导入悄悄改回去。
       *  判据：tests/folder-endpoints.test.mjs 的 OPML 用例（重复导入本地未分类）。
       *
       *  url 必带 —— upsert 的创建路径（新源）靠它，更新路径上它是幂等的同一个键。 */
      kind: 'upsert-subscription'
      url: string
      title: string | undefined
      folder: string | undefined
      /**
       * RSSHub 来源（R15 02）：只在**新源**上按识别结果写入。
       *
       * 已存在的源一律保留 previous（`previous?.rsshub ?? intent.rsshub`）—— 重复导入 OPML /
       * 重新添加不是一次新的识别，不能让「池子临时为空」把已记录的来源抹掉（与 folder 同型事故）。
       */
      rsshub?: FeedRecord['rsshub']
    }

/**
 * 按 intent 把一条 FeedRecord 合并出来。
 *
 * previous === undefined（源不存在）时，本函数本身是宽容的（纯合并，不做存在性判断）：
 *  - refresh 三种：仍按空记录起步并补 url（函数层不拒），但**两个 store 的 updateFeed 会拒绝**
 *    （refresh 意图的前提是源已在，见 src/store.ts 与 store-sqlite.ts）—— 生产路径由 lifecycle
 *    先种子、后刷新，所以正常不会撞上。
 *  - upsert-subscription：**创建**也是它的合法语义（addFeed / OPML 新源）。
 */
export function applyFeedIntent(previous: FeedRecord | undefined, intent: FeedIntent): FeedRecord {
  // previous === undefined 在**函数层**是合法输入（纯合并，不判存在性）；但「源不存在时能不能
  // 落库」由存储层裁决：refresh 三种意图会被两个 store 拒绝（种子先行），只有 upsert 允许创建。
  // 别把这段读成「refresh 首次抓取兼管创建」——那是旧实现的宽容，存储层没有实现它
  //（tests/refresh.test.mjs 的「首次抓取」夹具用的是宽容桩，生产由 lifecycle 种子保证）。
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
        // 成功即清零（不是「省略这个字段」）：省略等于退回「历史未知」，而这里我们**知道**刚成功。
        failureCount: 0,
        // 来源字段是逐字段重建里最容易被漏掉的那个（R15 02）：漏了它，200 一次就丢。
        rsshub: intent.rsshub ?? previous?.rsshub,
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
        // 304 与 200 同一份逐字段重建：漏了来源，老记录刚补上的字段下一轮 304 就消失。
        rsshub: intent.rsshub ?? previous?.rsshub,
        // 304 也是成功（源说内容没变）：连败计数同样归零，与 lastFailure 清零同一条理由。
        failureCount: 0,
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
        // 累计在这里算，调用方只声明「失败了一次」。previous.failureCount 缺省 = 历史未知，
        // 从这次开始数（1）—— 不假装知道之前的次数（见 domain.ts 的三态注释）。
        failureCount: (previous?.failureCount ?? 0) + 1,
      }
    case 'upsert-subscription': {
      // 已存在的源保留其 folder（用户可能在界面上改过，**包括改成未分类**）；title 按声明合并
      //（OPML 有声明、addFeed 用抓到的）。新源才吃 OPML 的分组。空字符串按未分类处理 ——
      // 与 buildOpml 把 '' 当未分类是同一口径，避免目录里出现一个空名项。
      const initialFolder = intent.folder === undefined || intent.folder === '' ? undefined : intent.folder
      // 显式白名单：不逐字段搬，「源刚试过一次」这个事实会被导入 OPML 抹掉，该源下一轮又被当
      // 「没试过」排到最前（调度键见 refresh.ts 的 stalenessKey）。
      return {
        url: intent.url,
        title: intent.title ?? previous?.title,
        folder: previous === undefined ? initialFolder : previous.folder,
        etag: previous?.etag,
        lastModified: previous?.lastModified,
        lastFetchedAt: previous?.lastFetchedAt,
        lastAttemptedAt: previous?.lastAttemptedAt,
        // 订阅落库（重复添加 / OPML 重导）**不是一次抓取结果**，所以它既不能清失败历史，
        // 也不能改计数：清了就等于「把源重新加一遍 = 修好了」，而源其实还是坏的（M4 02 的验收项）。
        // ⚠️ 这条在 2026-11-13 之前是反的（白名单不含 lastFailure ⇒ 落库会抹掉它），属**语义修正**，
        // 判据从「抹掉」翻成「保留」，见 tests/store-sqlite.test.mjs 的 H4 族。
        lastFailure: previous?.lastFailure,
        failureCount: previous?.failureCount,
        // 来源字段同理：已记录的来源是历史事实，重复导入 / 重新添加不许抹掉（与 folder 那次同型事故）。
        rsshub: previous?.rsshub ?? intent.rsshub,
      }
    }
  }
}
