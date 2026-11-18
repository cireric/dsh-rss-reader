# 功能状态

> 版本 **0.1.0** · 更新 2026-11-14 · **未发布**（无 tag、无 npm publish、无远端推送）
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
| 本地备份与恢复（F09） | 已落地 · **隔离 smoke（待真机）** | `docs/ops/backup-restore.md`、`scripts/verify-backup.mjs` | `tests/backup-verify.test.mjs` 9 条；真库副本演练（M5 04 轮）；**真灾难恢复未演练** |
| 可复现构建（F09） | 已落地 · 隔离 smoke | `scripts/build.sh`、`dsh-version.json`、`scripts/gate.sh` | `docs/ops/build-reproducibility.md` 的干净目录退出码表 |
| CI 分层（F09） | **待拍板** | `docs/ops/build-reproducibility.md` §7.2 | 未接入任何 CI 服务；L1 已由 `scripts/gate.sh` 覆盖 |
| 宿主定期同步（F06 调度） | **已跳过** | — | M4 03 票：用户 2026-11-13 决定不做 |

## 没覆盖到的（别把隔离烟测写成生产部署）

- **宿主组合**：全部验证都发生在同一台机器 —— macOS + DSH `0.2.1-rc.5`（tag，HEAD `b830ec9`）+ Node v26.13.0。
  其他操作系统、其他 dsh 版本、没有 nvm 全局 tsc 的环境**都没验过**。
- **真实语料**：中文源的大样本实测在 M1 之前做过（`docs/misc/zh-rss-feeds.md`，近 200 个源、按插件 UA 复测），
  M2–M5 的新功能**没有重跑**那批源。新功能里的「跨源重复」在真库上也没有命中样本（582 条里跨源同链接的数量未统计）。
- **浏览器观感**：主题对比度、窄窗口折行、长文 + 懒加载图片时的进度恢复跳动 —— 只有结构保证，没有真人验收。
- **大库**：10 万条量级的搜索、分页、`VACUUM INTO`、`link_key IN (…)` 时延，本机只有 ≤ 600 条的真实数据和合成夹具。

## 发布前要做的事（清单，未执行）

1. `bash scripts/gate.sh`（L1：build → build:client → typecheck → test）全绿；
2. `npm run mutation -- --workers 1` 按批跑完（本机内存 < 6 GB，见 `docs/pitfalls.md` §1.3）；
3. 真机三步：`dev_reload_package`（前后 `[active]`）→ 当天日志无「装载失败」→ 路由回 401；
4. 备份演练：按 `docs/ops/backup-restore.md` §3/§4 取一份快照并校验（**升级前必做**）；
5. 版本号与 `CHANGELOG.md` 一致（当前 `0.1.0`）；
6. **发布动作（打 tag / npm publish / 推远端）另行授权** —— 本文件不代表已经发布。
