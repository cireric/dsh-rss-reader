# 功能状态

> 版本 **0.1.0**（工作树已含 R1–R6、R11、R12、R8a 与 R9，尚未发版）· 更新 2026-11-24 · **本地 main 已合入 R12，未 push**（origin/main 停在 `bb89995`）· 未打 tag、无 npm publish
>
> 状态词只有五个，按「证据离真机有多远」排：
> **已落地**（代码在 `src/`、门槛绿）→ **隔离 smoke**（测试或合成夹具通过）→ **真机确认**（活体宿主装载过）→
> **待拍板** / **已跳过**。
> 证据写**来源**（哪个测试文件 / 哪一轮真机），不写「已验证」这种没有落点的话。
> 源码位置写**文件 + 符号**，不写行号 —— 行号会漂，符号不会（`docs/pitfalls.md` §1.1 的同类教训）。

## 能力清单

| 能力 | 状态 | 源码落点 | 证据 |
|---|---|---|---|
| 本地全文搜索（F01） | 已落地 · 隔离 smoke | `src/search-worker.ts`、`src/search.ts`、端点 `searchItems` | `tests/search.test.mjs`、`tests/search-upgrade.test.mjs`（含 v1 旧库升级） |
| 文件夹导航与筛选（F02） | 已落地 · 隔离 smoke | `src/folders.ts`、`src/client/feed-nav.tsx`、端点 `listFolders/createFolder/renameFolder/deleteFolder/moveFeedToFolder` | `tests/folder-storage.test.mjs`、`folder-browse.test.mjs`、`folder-endpoints.test.mjs` |
| 文章标签（F03） | 已落地 · 隔离 smoke | `src/tags.ts`、`tags`/`item_tags` 表、端点 `listTags/createTag/renameTag/deleteTag/setItemTags` | `tests/tag-storage.test.mjs`、`tag-browse.test.mjs`、`tag-endpoints.test.mjs` |
| Agent 只读工具（F04） | 已落地 · **真机确认** | `src/tools.ts`（`rss_search`/`rss_list_feeds`/`rss_read_article`） | `tests/tools.test.mjs`；M3 03 轮真机工具面 56 个工具 |
| `rss_update_item`（F04 写工具） | 已落地 · **真机确认** | `src/tools.ts`（逐次审批的 `pre-execute`） | `tests/tools.test.mjs`；M3 03 轮真机 |
| 订阅前发现候选（F05） | 已落地 · **真机确认** | `src/subscribe.ts` 的 `discoverCandidates`、端点 `discoverFeeds` | `tests/discover.test.mjs`、`subscribe.test.mjs`；M4 01 轮真机 |
| 订阅健康与刷新反馈（F06） | 已落地 · **真机确认** | `src/feed-intent.ts`、`src/shared.ts` 的 `feedHealthOf`、`RefreshRun` | `tests/refresh.test.mjs`、`store-sqlite.test.mjs`；M4 02 轮真机 |
| 阅读偏好与预计时长（F07） | 已落地 · **真机确认** | `src/preferences.ts` 的 `ReadingPreferences`、`src/shared.ts` 的 `estimateReadingMinutes`、`src/client/article-pane.tsx` | `tests/reading.test.mjs`、`nav-persistence.test.mjs`、`scroll-dom.test.mjs`；M5 01 轮真机 |
| 已缓存正文阅读进度（F07） | 已落地 · **真机确认** | `src/article.ts` 的 `contentVersionOf`、`reading_progress` 表、端点 `saveReadingProgress` | `tests/reading-progress.test.mjs`；M5 02 轮真机（真实库已写入 1 条进度） |
| 跨源重复提示（F08） | 已落地 · **真机确认** | `src/duplicates.ts`、`items.link_key` 派生列、端点 `duplicateHints` | `tests/duplicates.test.mjs`；M5 03 轮真机（真实库 link_key 无空值） |
| 时间范围筛选与未读拆分（R1） | 已落地 · **真机确认** | `src/display-window.ts`（日界唯一裁决者）、`src/client/window-control.ts`（唯一窗口载荷构造器）、`src/unread.ts` 的 `accountOf` / `unreadSplitSql` / `countUnreadSplit`、`src/store-sqlite.ts` 的 `WINDOW_FILTER`、`src/item-page.ts` 的 `fenceKeyOf` | `tests/display-window.test.mjs` 8 条（含 `TZ=America/New_York` 的 23/25 小时日）、`time-window-endpoints.test.mjs` 15 条、`unread-accounting.test.mjs` 17 条、`scroll-dom.test.mjs` 的 `R1-03`/`R1-04` 用例；`tests/perf/overview-scale.test.mjs`（10 万行索引计划与耗时预算）；真机三步 2026-11-21 复核通过（装载 / 日志 / 路由；行为面见下「没覆盖到的」） |
| 阅读位置恢复（R2） | 已落地 · **真机确认** | `src/preferences.ts` 的 `ViewPreferences.lastItemId` / `lastListScrollTop`、`src/client/store.ts` 的 `applyRestoredView` / `takeListScrollTop` / `flushViewMemory`、`src/client/list-actions.ts` 的 `leaveTransientViews`（经 `nav-actions.ts` 的 `selectNav` 调用） | `tests/nav-persistence.test.mjs` 38 条、`list-scroll.test.mjs` 16 条、`scroll-dom.test.mjs` 的 `R2-01` / `R2-02` 与「切作用域回列表」用例；真机三步 2026-11-21 复核通过（装载 / 日志 / 路由；行为面见下「没覆盖到的」） |
| 订阅源排序（R3） | 已落地 · **真机确认** | `src/feed-order.ts`（`deriveFeedOrder` / `reorderFeedOrder` / `withoutFeedOrder` / `orderedFeedEntries`）、端点 `reorderFeeds`、`config.json` 的可选 `feedOrder` | `tests/feed-order.test.mjs` 17 条、`feed-order-client.test.mjs` 5 条、`scroll-dom.test.mjs` 的订阅管理页 ↑↓ 5 条；真机三步 2026-11-21 复核通过（装载 / 日志 / 路由；行为面见下「没覆盖到的」） |
| 正文抓取失败回退（R4） | 已落地 · **真机确认** | `src/client/article-pane.tsx` 的 `bodyState` 判别式与 `paragraphBlocks`、`src/html-text.ts` 的 `paragraphsOf`、`src/shared.ts` 的 `hasBodyText` / `MIN_CONTENT_CHARS` | `tests/scroll-dom.test.mjs` 的「正文失败回退」7 条（够门槛 / 不到门槛 / 缺失 / 空串 / 重试打对条目 / 空 blocks / 偏好与空格滚动）、`article.test.mjs` 的 `paragraphsOf` 与 `hasBodyText` 边界；真机三步 2026-11-21 复核通过（装载 / 日志 / 路由；行为面见下「没覆盖到的」） |
| 正文内联语义（R5） | 已落地 · 隔离 smoke | `src/article.ts` 的内联解析（`parseInlineRuns` / `parseSegment` / `normalizeRuns`）、`src/article-text.ts` 的 `InlineRun` 与 `runsToText`、`src/client/article-pane.tsx` 的 `InlineRunsView` | `tests/article.test.mjs` 的「内联」族 16 条（五种 run / 相对与非法链接 / 嵌套取最外层 / 未知标签 / 相邻合并 / 不变量 / 归一化顺序 / 占位符 / 门槛）、`tests/scroll-dom.test.mjs` 的渲染 6 条、`tests/tools.test.mjs` 的 link 摊平；变异 `inline-*` 6 条各被抓住 |
| 正文表格块（R5） | 已落地 · 隔离 smoke | `src/article.ts` 的 `tableBlockOf` / `layOutRow` / `alignFieldOf`、`src/article-text.ts` 的 `tableToText`、`src/client/article-pane.tsx` 的 `TableBlockView` | `tests/article.test.mjs` 的表格 9 条（三种表头 / colspan / rowspan 占位 / 畸形行 / 超表尾 / align / figure 三形态）、`tests/retention.test.mjs` 与 `tests/store-sqlite.test.mjs` 的字符口径、`tests/search.test.mjs` 的表格命中、`tests/tools.test.mjs` 的 Markdown 表格、`tests/reading.test.mjs` 的时长；变异 `table-*` / `figure-*` / `chars-*` / `align-*` 各被抓住；**窄栏观感未做真人验收** |
| 作者元数据与作者搜索（R12） | 已落地 · **真机确认（2026-11-22）** | `src/author.ts` 的 `normalizeAuthor`（唯一归一化实现，refresh / store 读侧 / 搜索 worker 三处共用）、`items.author` 列与 `src/storage/db.ts` 的四条升级路径（v1/v2/v3/v4 → v5）、`src/store-sqlite.ts` 的 `ITEM_SELECT` / `UPSERT_ITEM` / `toItemRecord` / `writeItem`、`src/refresh.ts` 的落库与机会式补全、`src/identity-repair.ts` 的 `mergeItemRecords`、`src/search-worker.ts` 的作者谓词与 `ItemView` 组装、`src/client/index.tsx` 的列表行、`src/client/article-pane.tsx` 的正文 header、`src/tools.ts` 的 `digestOf` 与 `rss_read_article` 的 `base` | `tests/migration-author.test.mjs` 9 条（四条升级路径各自「迁移前夹具真的没有 `author` 列」+ 旧行全 NULL + 其余列逐项相等、迁移幂等、升级后 `listItems()` / `item()` 不抛 `no such column`、索引集合与 v4 相同、v5 通过 `verify-backup`）、`tests/parse.test.mjs` 的四种格式与「无作者不编造」、`tests/domain.test.mjs` 的 `normalizeAuthor` 三条边界与 schema 空白拒绝、`tests/store-sqlite.test.mjs` 3 条（往返 / `ON CONFLICT` 覆写 / 读侧空串归一化）、`tests/refresh.test.mjs` 5 条（RSS 2.0 与 Atom 落库端到端 / 补上 / 不覆盖 / 304 不写 / 只一次 `updateItem`）、`tests/identity.test.mjs` 合并保留作者、`tests/search.test.mjs` 2 条（作者命中 + NULL 安全 + 读侧归一化）、`tests/scroll-dom.test.mjs` 4 条（跨源 / 单源 / 超长 `title` / 正文 header 文案）、`tests/tools.test.mjs` 3 条（摘要 / 工具描述 / 正文元数据）；**2026-11-22 真机：库 v4→v5、reload 前后 `[active]`、日志 0 条「装载失败」、路由 401、580 条 / 34 位作者 / 438 已读 / 3 星标未变** |
| 阅读器内设置页（R11） | 已落地 · **真机验收可用（用户人工验收 2026-11-22）** | `src/settings-schema.ts`（四个可调键的范围唯一判据）、`src/storage/settings-file.ts`（settings.json 原子写 0600 / 读侧四类失败）、`src/settings-control.ts`（先落盘再改内存 / 恢复默认的删覆盖与写默认规则）、端点 `settings` / `saveSettings`、`src/client/settings-view.tsx` / `settings-actions.ts`（串行保存 / 逐项校验）、`src/client/confirm-dialog.tsx`（三处确认框共用） | `tests/settings-file.test.mjs`、`settings-endpoints.test.mjs`（含 A8 config.json 逐字节不变、A1 在途刷新不受新值影响）、`settings-page-dom.test.mjs`、`settings-agent-help.test.mjs`；变异 `settings-*` / `cleanup-预演真删` / `prefs-showUnread 类型` 各被抓住。全量变异 360/360 应用 · 0 幸存 · 恢复后基线仍绿。**已验**：真机三步 2026-11-22（`dev_reload_package` 前后 `[active]` / 当日日志 0 条「装载失败」/ `POST /rss-reader-api` 401）；用户人工验收可用。**未验**：`<460px` 容器查询的实际堆叠观感、settings.json 在真实 `$DSH_HOME` 上的 0600 权限、真实重启插件后仍保持（测试里模拟过 apply） |
| RSSHub Radar 发现（R8a） | 已落地 · 真机三步 + 真实实例验收（GUI 走查未做） | `src/rsshub.ts`（纯规则引擎：域名候选 / 桶 / 模板匹配 / 拼地址）、`src/radar.ts`（取规则 + 6h/60s 缓存 + `radarRulesUrl` / `isRadarRules` 单一判据）、`src/subscribe.ts` 的 Radar 支路、`settings.json` 的 `rsshubBase`（`parseRsshubBase` 唯一校验）、端点 `testRsshub`、设置页 RSSHub 分区、候选来源徽标 | `tests/rsshub.test.mjs` 30 条、`radar-discovery.test.mjs`、`radar-cache.test.mjs` 8 条、settings 三件套、`scroll-dom.test.mjs`；变异 `rsshub-*` 8 条全 caught，全量 368/368 · 0 幸存。**已验**：真机三步（reload 前后 `[active]` / 当日日志 0 条「装载失败」/ 路由 401）；真实实例（经代理）—— GitHub 页面 5 条 rsshub 候选且 `github/branches/DIYgod/RSSHub` 校验 `rss2`/14 条、B 站空间页出 `/bilibili/user/dynamic/2`、36kr 缺参跳过、私网实例被拒、未配置与同域第二次均零请求。**未验**：真实 GUI 走查（playwright 在本沙箱 target crashed）、「添加」未在真实订阅列表落一条、`settings.json` 真实重启保持 |
| 归档页回溯（R9） | 已落地 · 真机三步 + 真实站点（库快照）验收（GUI 走查未做） | `src/history.ts`（链接抽取 / 形态过滤 / 候选选择）、`src/article-date.ts`（五级日期来源）、`src/backfill.ts`（编排 / headroom / 300ms / 120s / 入库）、`src/duplicates.ts` 的 `sameArticleKeyOf`、端点 `backfillHistory`、`src/client/feeds-view.tsx` 行内表单 | `tests/history.test.mjs` 15 条、`tests/backfill.test.mjs`、`backfill-endpoint.test.mjs`、`backfill-dom.test.mjs`；全量 **1191/1191**；变异 `history-*` 9 条全部 caught，全量变异 **378/378 应用 · 0 幸存 · 恢复后基线仍绿**。**已验**：真机三步（reload 前后 `[active]` / 当日日志 0 条「装载失败」/ 路由 401）；真实站点（经本机代理，用构建产物对真实库快照，665 条）—— 阮一峰月份页抓回 8 篇（日期来自 `abbr.published`，正文缓存 rev 5）、云风月份页抓回 2 篇（日期来自可见文本）、重复执行 0 篇、`limit=3` 时 `remaining=5`。**未验**：真实 GUI 走查（playwright target crashed）、未写用户实时库、`meta article:published_time` 与 URL 完整日期两级无真实站点样本 |
| 订阅源范围分页（R14） | 已落地 · 隔离 smoke（真实库快照） | `src/item-page.ts` 的 `PageScope` 源态与 `feed:<id>` 栅栏、`src/endpoint-payloads.ts` 的 `feedId` 与互斥判据、`src/endpoints.ts` 的 `overviewScopeOf`、`src/client/list-actions.ts` 的 `load` / `loadMore`、`src/client/nav-actions.ts` 的 `scopeChanged`、`src/client/list-actions.ts` 的恢复重取 | `tests/overview-paging.test.mjs`（源页分页 / 跨源游标失配 / 未知源）、`tests/nav-selection.test.mjs`（选源发 `feedId` / 续页带 `feedId` / 恢复后按范围重取）、`tests/nav-persistence.test.mjs`（未知 feedId 不许发出源请求）、`tests/endpoint-payloads.test.mjs`；全量 **1197/1197**；变异 **381/381 应用 · 0 幸存**（`paging-源范围不落到查询` / `client-选源不重取` 均 caught）；真实库快照（648 条）源页 27 条、`nextCursor` 缺省。**未验**：真实 GUI 点击与观感（playwright target crashed） |
| 本地备份与恢复（F09） | 已落地 · **真机确认（取快照 + 校验，2026-11-22）** | `docs/ops/backup-restore.md`、`scripts/verify-backup.mjs` | `tests/backup-verify.test.mjs` 9 条；真库副本演练（M5 04 轮）；R12 升级前在真实库上取过快照并通过 `verify-backup`（`~/rss-backup-2026-11-22/`）；**真灾难恢复未演练** |
| 可复现构建（F09） | 已落地 · 隔离 smoke | `scripts/build.sh`、`dsh-version.json`、`scripts/gate.sh` | `docs/ops/build-reproducibility.md` 的干净目录退出码表 |
| CI 分层（F09） | **待拍板** | `docs/ops/build-reproducibility.md` §7.2 | 未接入任何 CI 服务；L1 已由 `scripts/gate.sh` 覆盖 |
| 宿主定期同步（F06 调度） | **已跳过** | — | M4 03 票：用户 2026-11-13 决定不做 |

## 没覆盖到的（别把隔离烟测写成生产部署）

- **宿主组合**：全部验证都发生在同一台机器 —— macOS + Node v26.13.0；DSH 宿主随轮次演进（R3 轮为 `0.2.2-rc.5`，
  见根目录 `dsh-version.json` 的 `tested`）。其他操作系统、其他 dsh 版本线、没有 nvm 全局 tsc 的环境**都没验过**。
- **真实语料**：中文源的大样本实测在 M1 之前做过（`docs/misc/zh-rss-feeds.md`，近 200 个源、按插件 UA 复测），
  M2–M5 的新功能**没有重跑**那批源。新功能里的「跨源重复」在真库上也没有命中样本（582 条里跨源同链接的数量未统计）。
- **浏览器观感**：主题对比度、窄窗口折行、长文 + 懒加载图片时的进度恢复跳动 —— 只有结构保证，没有真人验收。
- **大库**：10 万条量级的搜索、分页、`VACUUM INTO`、`link_key IN (…)` 时延，本机只有 ≤ 600 条的真实数据和合成夹具。
  R1 的显示窗索引计划与耗时预算是在**合成 10 万行**上钉的（`tests/perf/overview-scale.test.mjs`），真实大库未验。
- **R1–R4 的真机验收口径**：三步（reload / 日志 / 401）证明**插件装载与路由活着**，不等于每条行为都在真人手里走过一遍。
  R2 的列表滚动恢复、R1 的窄面板控件紧凑度仍只有 jsdom 结构保证（`docs/pitfalls.md` §2.2）。
- **Atom 的 feed 级 `<author>` 不回落（R12 的已知边界）**：解析只读 `entry.author[0].name`，只在 `<feed>` 上声明
  作者的源（Jekyll 一类生成器）**本期所有条目都没有作者**。这是有意不做——feed 级署名对同一源所有条目同值，
  对「区分同一个源里的不同作者」零增益，还可能给多作者博客一个不符的署名（见 ADR-0009「已知边界」）。
  不是待修 bug；要做需单独立项。
- **R12 的真人 GUI 走查还没做**：真机三步（reload / 日志 / 401）、真实库副本迁移与工具面（`rss_search` / `rss_read_article` 带 author）都已实测；
  列表行 / 正文 header / 搜索的**观感**仍待你在真机上过一遍（步骤见 `.scratch/r12-author/issues/08-*.md` 与交接说明）。
  真机快照留在 `~/rss-backup-2026-11-22/`（v4，回滚用，别删）。

## 发布前要做的事（2026-11-22 状态）

- [x] 1. `bash scripts/gate.sh`（L1：build → build:client → typecheck → test）全绿 —— R1 05 票终检实测（L1 全过、`npm test` 806/806、`npm run test:perf` 11/11）；2026-11-21 复跑 `npm test` **806/806**；**R12 终检（2026-11-22）：build / build:client / typecheck 通过、`npm test` 983/983（0 skipped）**；
- [x] 2. `npm run mutation -- --workers 1` 全量跑完 —— R1 05 票终检实测：应用 **272/272**、0 幸存、恢复后基线仍绿；**R12 终检（2026-11-22，`--workers 2`）：应用 342/342、0 幸存、恢复后基线仍绿**；
- [x] 3. 真机三步：`dev_reload_package` 前后 `[active]` → 当天日志 0 条「装载失败」→ 路由 401（2026-11-21 复核：日志 `reader-2026-11-20.log` 的「装载失败」计数 0、`POST /rss-reader-api` 返回 401、插件条目 `[active]`）；
- [x] 4. 备份演练：按 `docs/ops/backup-restore.md` §3/§4 取一份快照并校验 —— **R12 票 08 兑现（2026-11-22）**：
      快照 `~/rss-backup-2026-11-22/`（0700/0600，`verify-backup` 退出码 0，v4、580 条 / 7 源）；
      副本演练通过后才 reload（库 v4→v5、行数与已读/星标计数不变、`integrity_check=ok`）；
      演练记录 `.scratch/r12-author/migration-rehearsal.md`。**快照保留作回滚点，别删**；
- [ ] 5. 版本号与 `CHANGELOG.md` 一致 —— `package.json` 仍是 `0.1.0`，而 R1–R4 已合入但**未发版**：
      发版时要抬版本号并在 `CHANGELOG.md` 补对应小节（当前那条记为「未发布」）；
- [ ] 6. **发布动作（打 tag / npm publish）另行授权** —— 已推送 `main`（R1 收尾 `bb89995`），未打 tag、无 npm publish。
