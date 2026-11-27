# PLAN —— 功能开发进度

> **用途**：按阶段跟踪本插件的产品功能交付，供「逐一开发 + 进度感知」使用。
> **状态词**：`已完成` / `进行中` / `未开工` / `待拍板` / `暂缓`。
> **完成定义**：按 [AGENTS.md](../AGENTS.md) 的四道门槛（`build` / `build:client` / `typecheck` / `test`，关键判定另有 `mutation`）+ 真机三步（reload / 日志 / 路由）。本文件不抄门槛，只记结果与遗留。
> **票据唯一真相**：`.scratch/<slug>/issues/`；本文件只做阶段索引，阶段内的行为规范、验收与变异归属看 spec / 票据，不在这里复制。
> **基线**：main（v0.2.0 tag `516a79b` + R11 merge `68f0b12` + R8a merge `de72059` + R9/R14 merge `a59baf4` + R7 merge `784a2fc`，2026-11-27）——R1–R7、R8a/R8b、R9、R11、R12、R14 已合入；R7 版本线为 0.3.0，未 push。
> **定位变更**：自 2026-11-22 起本文件改为产品功能进度计划；原「架构候选」计划保存在 git 历史（`git show fd139c6:docs/PLAN.md`），不再在本文件维护。

## 总览

| 阶段 | 功能 | 状态 | 票据 | 证据 / 遗留 |
|---|---|---|---|---|
| R1 | 时间范围筛选与未读拆分 | 已完成 | 5/5 `done` | 真机三步复核（2026-11-21）；行为面未逐条真人走查 |
| R2 | 阅读位置恢复 | 已完成 | 3/3 `done` | 真机三步；列表滚动恢复的 `scrollTop` 夹取未真人验收 |
| R3 | 订阅源排序 | 已完成 | 4/4 `done` | 真机三步；`config.json` 的 `feedOrder` 可选字段 |
| R4 | 正文抓取失败回退 | 已完成 | 2/2 `done` | 真机三步；回退内容不写正文缓存 |
| R5 | 正文内联语义与表格 | 已完成 | 6/6 `done` | 隔离 smoke；窄栏表格观感未真人验收 |
| R6 | 图片折叠与灯箱 | 已完成 | 8/8 `resolved` | 门槛/真机三步已过；图片观感、灯箱尺寸已 GUI 走查（2026-11-27）；仅 Referer 实发未验 |
| R12 | 作者元数据与作者搜索 | 已完成 | 8/8 `resolved` | v4→v5 真机升级；GUI 观感已走查（2026-11-27） |
| R11 v1 | RSS 设置页 v1（入口 B） | 已完成 | 7/7 `resolved` | `settings.json` 稀疏覆盖 + `settings` / `saveSettings` 端点 + 五分区设置页；1054/1054、变异 360/360、真机三步；用户人工验收可用（2026-11-22）。遗留：`<460px` 观感、真实 0600 权限位、真实重启保持未单独复核 |
| R8a | RSSHub Radar 发现（公共实例） | 已完成 | 5/5 `resolved` | 1142/1142、全量变异 368/368 · 0 幸存、真机三步；真实实例验收（GitHub 端到端 / B 站 / 36kr 缺参 / 私网拒绝 / 缓存）。遗留：GUI 走查（playwright target crashed）、添加未落真实订阅列表、settings 真实重启未验 |
| R9 | 归档页回溯更早文章 | 已完成 | 4/4 `resolved` | 1191/1191、全量变异 378/378 · 0 幸存、真机三步；真实站点（真实库快照）阮一峰 8 篇 / 云风 2 篇 / 重复 0；GUI 走查（2026-11-27）。遗留：未写实时库、两级日期规则无真实样本 |
| R8b | RSSHub 路由表探索 | 已完成 | 5/5 `resolved` | 1271/1271、全量变异 392/392 · 0 幸存、真机三步；真实实例（`rsshub.rssforever.com`，经代理）1589 站 / 3136 路由 / 24 分类，首拉 7.9 s；GitHub 端到端拼出 `/github/branches/DIYgod/RSSHub` 并抓回 11 条。遗留：GUI 观感（playwright target crashed）、152 条多路径路由按 §4.2 跳过 |
| R7 | 一键翻译 | 已完成 | 7/7 `resolved` | 1380/1380、全量变异 407/407 · 0 幸存（评审修复后实跑，3 workers）、真机三步（reload 前后 `[active]` / 当日日志 0 条「装载失败」/ 路由 401）；真模型三篇：短 265 字 1 批 5.2 s，中 1896 字 2 批 27.2 s（首批 truncated → 会话 effort 外溢修复后同批 9.8 s），长 8235 字 8 批 94.5 s 全过；原文 / 对照、视口优先、确认框与进度条已 GUI 走查（2026-11-27）。遗留：译文刷新即丢（设计） |
| R10 | 右侧边栏单栏 | 暂缓 | — | 第二套 UI；现有 `u` 已收左栏 |
| R13 | `/rss` 命令 | 暂缓 | — | 与 4 个 Agent 工具重复 |
| R14 | 订阅源范围宿主分页 | 已完成 | 1/1 `resolved` | 648 条库 / 27 条源：源页 27 无续页；1197/1197、全量变异 381/381 · 0 幸存 |

**进度**：已交付 13 个阶段、65 张票（R1–R7、R11、R12、R8a、R9、R14、R8b）；**R7 已完成（7/7 `resolved`）**，R10/R13 暂缓。**当前阶段：无（R7 已合入并发布 0.3.0；R10/R13 暂缓）。**

## 已完成阶段（留作上下文）

### R1 时间范围筛选与未读拆分

- **状态**：已完成（`.scratch/r1-time-range/issues/` 5/5 `done`）。
- **交付**：`src/display-window.ts`、`src/client/window-control.ts`、`src/unread.ts` 的 `accountOf` / `unreadSplitSql` / `countUnreadSplit`、`src/store-sqlite.ts` 的 `WINDOW_FILTER`、`src/item-page.ts` 的 `fenceKeyOf`。
- **证据**：`tests/display-window.test.mjs`、`time-window-endpoints.test.mjs`、`unread-accounting.test.mjs`、`scroll-dom.test.mjs` 的 R1 用例、`tests/perf/overview-scale.test.mjs`（10 万行）；真机三步。
- **遗留**：窄面板下的控件紧凑度、真人逐条行为走查未做。

### R2 阅读位置恢复

- **状态**：已完成（3/3 `done`）。
- **交付**：`ViewPreferences.lastItemId` / `lastListScrollTop`、`applyRestoredView` / `takeListScrollTop` / `flushViewMemory`、`leaveArticleForScope`。
- **证据**：`nav-persistence.test.mjs` 38 条、`list-scroll.test.mjs` 16 条、`scroll-dom.test.mjs` 的 R2 用例；真机三步。
- **遗留**：真实浏览器里的 `scrollTop` 夹取未做真人验收（jsdom 无布局）。

### R3 订阅源排序

- **状态**：已完成（4/4 `done`）。
- **交付**：`src/feed-order.ts`、`reorderFeeds` 端点、`config.json` 可选 `feedOrder`、订阅管理页 ↑/↓。
- **证据**：`feed-order.test.mjs` 17 条、`feed-order-client.test.mjs` 5 条、`scroll-dom.test.mjs` 5 条；真机三步。
- **遗留**：拖动排序未做，当前只有 ↑/↓（按 spec 允许）。

### R4 正文抓取失败回退

- **状态**：已完成（2/2 `done`）。
- **交付**：`article-pane.tsx` 的 `bodyState` / `paragraphBlocks`、`html-text.ts` 的 `paragraphsOf`、`shared.ts` 的 `hasBodyText` / `MIN_CONTENT_CHARS`。
- **证据**：`scroll-dom.test.mjs` 的「正文失败回退」7 条、`article.test.mjs` 边界；真机三步。
- **遗留**：无。

### R5 正文内联语义与表格

- **状态**：已完成（6/6 `done`）。
- **交付**：`article.ts` 的内联解析与 `tableBlockOf`、`article-text.ts` 的 `InlineRun` / `runsToText` / `tableToText`、`article-pane.tsx` 的 `InlineRunsView` / `TableBlockView`。
- **证据**：`article.test.mjs` 内联 16 条 + 表格 9 条、`scroll-dom.test.mjs` 6 条、`tools.test.mjs`、`search.test.mjs`、`reading.test.mjs`；变异 `inline-*` / `table-*` / `figure-*`。
- **遗留**：窄栏表格横向滚动的真人观感未验收；`article.ts` 已超 1000 行，拆分有触发条件，不在本轮。

### R6 图片折叠与灯箱

- **状态**：已完成（8/8 `resolved`）。
- **交付**：`article-pane.tsx` 的图片折叠 / 三态 / 灯箱、`preferences.ts` 的 `expandImages`、`keys.ts` 的 `i` 键、`referrerPolicy`。
- **证据**：R6 票 01–08 的测试与变异（新增 15 条，全量复核 0 幸存）；`gate.sh` 全绿；真机三步。
- **遗留**：图片观感与灯箱尺寸已由用户 GUI 走查（2026-11-27）；`Referer` 实发仍需抓包 / 服务器日志。`CHANGELOG` / `feature-status` 已于 2026-11-27 回填。

### R12 作者元数据与作者搜索

- **状态**：已完成（8/8 `resolved`）。
- **交付**：`src/author.ts` 的 `normalizeAuthor`、`items.author` + v1–v4→v5 四条升级路径、store 读写、refresh 落库 / 机会式补全、identity 合并、搜索谓词、列表 / 正文 / 工具投影。
- **证据**：`migration-author.test.mjs` 9 条、`parse.test.mjs`、`domain.test.mjs`、`store-sqlite.test.mjs`、`refresh.test.mjs`、`identity.test.mjs`、`search.test.mjs`、`scroll-dom.test.mjs`、`tools.test.mjs`；全量 `npm test` 983/983、变异 342/342、0 幸存；真机 v4→v5 升级（580 条 / 34 位作者 / 438 已读 / 3 星标不变）。
- **遗留**：Atom feed 级 `<author>` 不回落（ADR-0009 已知边界，不是 bug）；GUI 走查已由用户完成（2026-11-27）。

### R11 v1 阅读器内设置页（入口 B）

- **状态**：已完成（`.scratch/r11-settings-page/issues/` 7/7 `resolved`；已合入 `main` `68f0b12`）。
- **交付**：`src/settings-schema.ts`（四个可调键的范围唯一判据）、`src/storage/settings-file.ts`（`settings.json` 原子写 0600 / 读侧 absent·ok·corrupt·unreadable）、`src/settings-control.ts`（先落盘再改内存 / 恢复默认的删覆盖与写默认规则 / 关于区只读数据）、端点 `settings` / `saveSettings`（29 → 31）、`src/client/settings-view.tsx` + `settings-actions.ts`（五分区 / 串行保存 / 逐项校验）、`src/client/confirm-dialog.tsx`（三处确认框共用）、`src/agent-help.ts`（Agent 文案单源）；`cleanup` 增加 `dryRun` 预演；`ViewPreferences.showUnread`。
- **证据**：`settings-file.test.mjs`、`settings-endpoints.test.mjs`（含 A8 `config.json` 逐字节不变、A1 在途刷新不受新值影响）、`settings-page-dom.test.mjs`、`settings-agent-help.test.mjs`；`npm test` 1054/1054、全量变异 360/360 应用 · 0 幸存；真机三步（reload 前后 `[active]` / 当日日志 0 条「装载失败」/ `POST /rss-reader-api` 401）；用户人工验收可用（2026-11-22）。
- **遗留**：`<460px` 容器查询的实际堆叠观感、真实 `$DSH_HOME` 上 `settings.json` 的 0600 权限位、真实重启插件后的保持未单独复核；界面不显示来源层、v1 无单项清除（spec 已知边界）。

### R7 一键翻译

- **状态**：已完成（`.scratch/r7-translate/issues/` 7/7 `resolved`；开发分支 `feat/r7-translate`，代码基线 commit `26ab6ad`，已合入 main `784a2fc`）。
- **交付**：`src/translate.ts`（prompt 指令内联进 user / `maxTokensFor` / 60 s deadline / 流拼装 / 四类失败 / `resolveTranslateRoute` 两层路由与 `routeOfSessionDefault` 只取 provider+model）、`src/translate-blocks.ts`（可翻块筛选 / `applyBatch` 编号对齐 / 12 块 ×2000 字符分批 / 单块三档 / 30000 上限）、`src/translate-copy.ts`（5 语言与中文文案）、端点 `translateBatch` / `translateInfo`（35 → 37）、`src/client/translate-actions.ts`（串行编排 / 视口首批 / 失败批重试 / 连败 3 批停止 / 中止与继续 / 全局单任务）、`src/client/translate-entry.ts`（回包对齐 / 按块 model）、`src/client/translate-state.ts`（条目 / 两态共享状态）、`src/client/translate-toolbar.tsx`（工具栏控件）、`src/client/article-pane.tsx`（原文 / 对照两态与单枚切换、进度、失败批重试入口、翻译中占位）、首次外发确认框与设置页模型选择器、正文工具栏的裸语言下拉、`src/keys.ts` 的 `t`（原文 / 对照切换 / 缺块继续 / 无译文时触发）。
- **证据**：`tests/translate-*.test.mjs` 12 个文件 101 条；全量 `npm test` **1380/1380**（本轮评审修复新增 5 条）；全量变异 **407/407 应用 · 0 幸存 · 恢复后基线仍绿**（评审修复后实跑，3 workers；R7 15/15 caught）；真机三步（`dev_reload_package` 前后 `[active]` / 当日 `reader-2026-11-25.log` 0 条「装载失败」/ `POST /rss-reader-api` 401）；真模型三篇（同一套 `articleTranslatePlanOf` / `pickBatch` 直调 `lib/translate.js`）：短 265 字 1 批 5.2 s、中 1896 字 2 批 27.2 s（批 0 在会话 effort:max 下 20.1 s truncated；同批显式无 effort A/B 9.8 s 成功，据此修掉会话 effort 外溢）、长 8235 字 8 批 94.5 s 全部成功（每批 4.6–15.7 s，id 全对齐、无空译文、`model=deepseek-v4.1-flash`）。
- **遗留**：译文纯内存、刷新即丢，纯文本丢链接与内联样式，未做表格 / 图片 alt 翻译（spec 已知限制）；输出预算按字符估且与 reasoning 共用 `maxTokens`，超长批仍可能 truncated（真机样本已在 CHANGELOG 记）。

## 第三批（R8a / R9 / R8b 已完成）

> R11 已交付（见上）；本批剩余三项按原编号保留（`第三批 2/3/4`），避免 spec 与历史引用的编号漂移。

### 第三批 2 — R8a：RSSHub Radar 发现（公共实例）

- **状态**：**已完成**（`.scratch/r8a-radar/` 5/5 `resolved`；**已合入 `main`**（merge `de72059`，17 个提交 / 37 文件 / +3042 −179））。
- **交付**：`src/rsshub.ts`（纯规则引擎：域名候选 / 桶 / 匹配 / 拼地址）、`src/radar.ts`（取规则 + 缓存 + `radarRulesUrl` / `isRadarRules` 的单一判据）、`src/subscribe.ts` 的 Radar 支路、`settings.json` 的 `rsshubBase`（`parseRsshubBase` 唯一校验）、端点 `testRsshub`（31 → 32）、设置页 RSSHub 分区（含 `cfd2d8a` 的实例地址输入框宽度修复）、候选来源徽标。
- **证据**：`tests/rsshub.test.mjs` 30 条、`radar-discovery.test.mjs`、`radar-cache.test.mjs` 8 条、settings 三件套、`scroll-dom.test.mjs` 1 条；`npm test` **1142/1142**；全量变异 **368/368 应用 · 0 幸存**（R8a 新增 8 条 `rsshub-*`）；真机三步（reload 前后 `[active]` / 当日日志 0 条「装载失败」/ 路由 401）；真实实例（经代理，2026-11-23）—— GitHub 页面出 5 条 rsshub 候选、`github/branches/DIYgod/RSSHub` 校验 `rss2` 14 条；B 站空间页出 `/bilibili/user/dynamic/2`；36kr 缺参跳过；私网实例被拒；未配置零请求；同域第二次零请求。
- **遗留**：真实 GUI 走查未做（playwright 在本沙箱 target crashed）；「添加」只验到 `addFeed` 之前的校验层，未在真实订阅列表落一条；`settings.json` 真实重启保持未单独复核。
- **目标**：在「粘贴网页 → 列出可订阅源」里补上 RSSHub 这一路；没有 RSS 的站点也能给出候选。
- **前置（第 0 步，0.5–1 天）**：**已完成**（2026-11-23 实测）。公共实例三家可用（`rsshub.rssforever.com` / `hub.slarker.me` / `rsshub.isrss.com`），**`rsshub.app` 对程序化访问 403**（官方限流页 + Cloudflare 挑战）⇒ 默认实例改为「空 = 关闭」。规则接口形态、规则表统计、校验成本见 spec §1.1；`/api/namespace` 未测（属 R8b 前置）。
- **范围**：
  1. 配置 `rsshubBase`：只用公共实例，**默认空 = 功能关闭**（设置页填 / 清空，带测试连接）；不做自建 / 私网实例，不开口子网 SSRF 例外。
  2. `discoverFeeds` 返回两组候选：页面自身声明（权威，排前）+ RSSHub Radar（补充，带来源标签、**不做取回校验**）；用户手动选择，不自动订阅。
  3. 域名逐级回退（短优先，不引多段后缀表 —— 实测 1310 个规则 key 全是注册域）；规则缓存 6h，失败 60s。
  4. 只推荐能拼出的地址；缺参路由跳过并警告，绝不返回带 `:param` 的模板。
  5. 实例不可达时页面自身声明仍正常返回；错误作为 warning，不把发现判失败。
  6. 出网走现有 `normalizeFeedUrl` / SSRF 策略。
- **非目标**：整张路由表探索（R8b）；自动订阅；自建实例。
- **验收**：粘贴无 RSS 站点返回 RSSHub 候选且来源标签正确；实例不可达时页面候选仍在 + warning；缺参路由不出现；缓存命中不重复请求、换实例清缓存；私网 / 公网地址策略各有测试。
- **票据**：新建 `.scratch/r8a-radar/`（spec + issues）。
- **风险**：公共实例限流 / 下线 / 大陆网络不可达（未测）；Radar 规则社区维护可能过期。

### 第三批 3 — R9：归档页回溯更早文章

- **状态**：**已完成**（`.scratch/r9-archive/issues/` 4/4 `resolved`；已合入 main `a59baf4`）。
- **前置（第 0 步，0.5–1 天）**：**已完成**（2026-11-23 实测）。阮一峰 `atom.xml` 恰好 3 条、`archives.html` 形态命中 20 / 新 17，月份页 2020/01 新 8，日期用 `abbr.published`；云风 `atom.xml` 15 条、首页是月份索引、月份页 2026/10 新 1，日期只有可见文本「提交于 October 11, 2026 07:30 PM」。形态规则（整路径形状 / 目录形状+扩展名）两家都成立。
- **拍板**：D1–D10 见 `.scratch/r9-archive/spec.md` §11（一次一页、行内入口、日期三级来源、同文键忽略协议、未读、headroom 预检、同步 + 120s deadline、N = 尝试数、归档页可信 / 文章页不可信、无时区按 +08:00）。
- **交付**：`src/history.ts`（链接抽取 / 形态过滤 / 候选）、`src/article-date.ts`（五级日期来源）、`src/backfill.ts`（编排）、`src/duplicates.ts` 的 `sameArticleKeyOf`、`fetchArticle.publishedAt`、端点 `backfillHistory`（32→33）、`feeds-view` 行内表单；无迁移、无新依赖。
- **证据**：`npm test` **1191/1191**；`gate.sh` 四条全过；全量变异 **378/378 · 0 幸存**（新增 9 条 `history-*` 全部 caught）；真机三步；真实站点（经代理，真实库快照 665 条）阮一峰月份页 8 篇 / 云风 2 篇 / 重复执行 0 / `limit=3` 时 `remaining=5`。
- **遗留**：未写用户实时库、`meta article:published_time` 与 URL 完整日期两级无真实站点样本（`docs/pitfalls.md` §八）；GUI 走查已由用户完成（2026-11-27）。

### 第三批 4 — R8b：RSSHub 路由表探索

- **状态**：**已完成**（`.scratch/r8b-explore/issues/` 5/5 `resolved`；已合入 main `f7c8274`，开发分支已清理）。
- **前置 spike（已完成，2026-11-24 实测）**：`rsshub.rssforever.com/api/namespace` → 200 · **1589 站 / 3288 路由 / 28 分类**；裸 3 289 636 B · gzip 638 090 B；首拉 23.5 s（裸）/ **8.9 s**（gzip，本机经代理）。`example` 3026/3288、`parameters` 2092/3288、路由级 `categories` 2940/3288（站点级仅 206 站且与站内路由完全一致）。参数语法 `:name` 1341 / `:name?` 1624 / `{.+}` 类 126（其中 118 是 `.+`·`.*`）。**「可选段后跟必填段」实测 0 例** ⇒ 省略可选段 = 从尾部剥，无需特例。
- **拍板（D1–D15，见 spec §11）**：独立 `view: 'explore'`；单级扁平 + 站点名钻取；目录缓存 12 h 硬编码不设键；拉表专用 60 s / 16 MiB；constraint 不校验正则；订阅后不关视图；分类只按**路由级**；搜站点名命中该站全部路由；三筛 AND；分类单选；未配置实例入口不可见；下发行裁剪（丢 `description` / `location` / `maintainers` / `radar`）；`siteTotal`·`routeTotal` 与 `matched` 分口径；视图状态不持久化。
- **交付**：`src/explore-catalog.ts`（投影 / 检索 / 游标栅栏 / 拼地址）、`src/explore-template.ts`（模板解析 + example 预填，host 与 client 共用一份）、`src/explore-catalog-fetch.ts`（取表 + 12 h 实例键缓存）、端点 `exploreCatalog` / `exploreBuildUrl`（33 → 35）、客户端 `view: 'explore'`（探索视图 + 两处入口 + 连续订阅）。
- **票据**：01 纯函数投影与拼装 → 02 取表与缓存（并行）→ 03 端点 → 04 客户端 → 05 真机；评审修复 1 轮（入口判据统一 / 站点名回落 / 拼地址竞态 / 预填提示 / 客户端变异）。
- **证据**：`npm test` **1271/1271**（探索相关 25 + 14 + 21 + 13 条）；全量变异 **392/392 应用 · 0 幸存**（新增 10 条 `explore-*` 全部 caught）；真机三步（reload 前后 `[active]` / 日志无装载失败 / `curl` 401）。真实实例（经代理）：首拉 **7.9 s**、`siteTotal 1589 / routeTotal 3136 / 分类 24`、`limit=30` 回包 **10 569 B**、`limit=100` **33 781 B**；3 页 90 条 0 重复；`category=programming` 203 条且逐条含该分类；GitHub 端到端 addFeed `added: 1` + 抓回 **11 条**；私网 `127.0.0.1:1200` 与不可达域名各自明确报错且失败不缓存。
- **实测修正**：真实回包里 **152 条路由的 `path` 是数组**（多路径路由），按 spec §4.2「`path` 不是字符串 ⇒ 跳过」计入 `invalid`，所以真实 `routeTotal = 3136`（不是 3288）；路由级分类并集 **24**（spec §1.1 的 28 未复现）。
- **遗留**：真实 GUI 观感（列表密度 / 窄栏表单堆叠 / 100 条滚动）未验 —— `playwright-cli` 起浏览器即 `Target crashed`（本机沙箱，与 R8a / R9 同因）；HTTP 面只验了 401 与热重载，端到端走的是注入进程内的 dispatch。
- **修正**：原写「整表约 3.3MB、首次约 1 秒」——**「1 秒」不实**，实测 8.9 s（gzip）/ 23.5 s（裸，本机经代理）。3.3MB 是解压后体积，传输 638KB。

### 修复轮 — R14：订阅源范围改为宿主分页

- **状态**：**已完成**（`.scratch/r14-feed-scope/issues/` 1/1 `resolved`；已合入 main `a59baf4`）。
- **病象**：选中阮一峰（库里 27 条）时顶栏「已加载 300 条」、列表只有 2 条，点两次「加载更多」才全。
- **根因**：源范围没有宿主分页——`PageScope` 只有 folder/tag，客户端选源不重取，`inScope()` 在全局第一页上按 feedId 过滤。R9 回溯按真实日期补进旧条目后暴露。
- **交付**：`PageScope` 增加 feed 态（栅栏 `feed:<id>`）、`overview`/`refresh` 接受 `feedId`（与 folder/tagId 互斥、未知源 not-found）、客户端选源/取消/续页都带 `feedId`，**恢复到非虚拟范围时首屏之后按范围重取**。
- **证据**：`npm test` **1197/1197**；`gate.sh` 四条全过；全量变异 **381/381 应用 · 0 幸存**（新增 2 条 + 重锚 2 条全部 caught）；真实库快照源页 `count=27 / nextCursor=null`、跨源页 300 + 续页、未知源 not-found。
- **遗留**：无（GUI 点击已由用户走查，2026-11-27）。

## 暂缓 / 不做

| 项 | 状态 | 理由 |
|---|---|---|
| R10 右侧边栏单栏 | 暂缓 | 第二套 UI 的维护成本；主面板左栏已有 `u` 收起；三个宿主座位是实验性服务面 |
| R13 `/rss` 命令 | 暂缓 | 4 个 Agent 工具已覆盖；FYKANG 的 `refresh 源名` 实际刷全部，不照抄 |
| 后台定时刷新 | 已跳过 | 2026-11-13 已决定不设常驻定时器 |
| 源改名 / 元数据编辑 | 暂缓 | 无真实「标题乱码必须改名」样本 |
| 抓取代理 | 暂缓 | 工程 / 网络环境项，需重做 SSRF / DNS 策略，不顺手加 |

## 怎么更新这份文件

1. **开工前**：建 / 扩展 `.scratch/<slug>/spec.md` 与 `issues/`；把对应阶段状态改为 `进行中`，写明当前票据。
2. **每票完成**：改票面 `Status` 与 `issues/README.md` 的表；本文件只在该阶段全部票据完成后改 `已完成`。
3. **阶段收尾**：按 AGENTS.md 跑 `bash scripts/gate.sh` + 全量 `npm run mutation -- --workers 2`（内存 < 6GB 用 `--workers 1`）+ 真机三步；在本文件写「证据 / 遗留」。
4. **未验项**：一律写进「遗留」，不得把「真机三步」当成「每条行为都走过」。
5. **共享文件**：`scripts/mutation/table.mjs`、`src/client/index.tsx` 等跨阶段文件按票序串行，避免并行分支互相覆盖。

## 拍板记录

| 日期 | 事项 | 结论 |
|---|---|---|
| 2026-11-25 | R7 一键翻译 | 译文纯内存不落盘（不建表、不升 schema）；分块 ≤12 块且 ≤2000 字符、视口优先、单块 2000/6000 三档；5 语言 + 原文 / 对照两态（2026-11-26 收成一枚切换按钮）；模型路由两层（`settings.json` > 会话默认）且服务全走 `ctx.get()` 可选获取；失败 `translate-failed` + 四类 reason 按批重试（spec D1–D20） |
| 2026-11-24 | R8b 路由表探索 | 独立 `view:'explore'`；单级扁平+站点钻取；缓存 12h 硬编码（**推翻原「可配置」**）；拉表 60s/16MiB 专用预算；constraint 不校验；分类仅路由级；三筛 AND；未配置实例入口不可见；下发行裁剪（spec D1–D15） |
| 2026-11-23 | R9 归档页回溯 | 一次一页；日期三级来源、月级不补；同文键忽略协议（ADR-0011）；未读；headroom 预检；同步 + 120s；N=尝试数；归档页可信 / 文章页不可信（spec D1–D10） |
| 2026-11-22 | RSSHub 实例 | 只用公共实例，不自建；不开口子网 SSRF 例外 |
| 2026-11-23 | R8a 默认实例 | 空 = 关闭，不写死公共实例（`rsshub.app` 实测 403）；Radar 候选不做取回校验（ADR-0010） |
| 2026-11-22 | 设置页入口 | B：独立 `view: 'settings'` 视图 |
| 2026-11-22 | R12 基线 | R12 已完成，作为 v0.2.0 基线 |
| 2026-11-21 | R6 图片默认值 | `expandImages` 默认 `true`，`i` 键切换整篇 |
| 2026-11-21 | R1 时间范围默认值 | 默认「全部」，不改变打开面板第一屏 |

## 账目 / 已知不一致

- **v0.2.0**：git tag `v0.2.0` 在 `516a79b`（2026-11-22），该 tag 的 `package.json` 仍是 `0.1.0`；`0.3.0` 发布账目已建立（CHANGELOG 0.3.0 小节、package 0.3.0），历史 tag 内容不可改写。
- **R7 发布账目**：R7 已合入 main `784a2fc`（代码基线 `26ab6ad`）；`package.json` 已抬到 `0.3.0`，`CHANGELOG.md` 已建立 `0.3.0 — 2026-11-27` 小节；本地 tag `v0.3.0` 已创建，未 push。
- **R6 文档面**：`CHANGELOG.md` / `docs/feature-status.md` 已补 R6；`spec.md` 头已回填 `resolved（8/8）`。
- **R6 真机**：图片观感与灯箱尺寸已 GUI 走查（2026-11-27）；`Referer` 实发仍需抓包验证。
- **R9 / R14 账目**：R9（评审修复 `e317e73`）与 R14（`6153927`）已合入 **main `a59baf4`**，随 `0.3.0` tag 发布、未 push；`CHANGELOG.md` 已补两节，`docs/feature-status.md` 已加两行。真机与真实站点证据在 `.scratch/r9-archive/issues/04-real-device.md` 与 `.scratch/r14-feed-scope/issues/01-feed-scope.md`。
- **R11 版本账目**：R11 已合入 `main`（`68f0b12`），随 `0.3.0` 一起发布；`CHANGELOG.md` 的 R11 小节已归入 0.3.0。功能状态见 `docs/feature-status.md` 的 R11 行（真机验收可用 + 三项细项未复核）。
