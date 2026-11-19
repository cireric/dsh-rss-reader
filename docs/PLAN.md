# PLAN —— 架构候选的分阶段执行计划

> 来源：2026-11-14 的架构评审（8 个候选；报告是仓库外的临时 HTML，**不作为长期依赖**，
> 卡 #8 的事实摘在阶段 5 的「问题」段与 [ADR-0003](adr/0003-endpoint-payload-is-declared.md)）。本文件只列
> **尚未动工**的候选，一个候选一个阶段。用词以 [GLOSSARY.md](../GLOSSARY.md) 为准；每条决定的理由写在
> [docs/adr/](adr/)，这里不重复。完成定义见 [AGENTS.md](../AGENTS.md)（四道门槛），本文件不抄。

## 已完成（留作上下文，不再展开）

| 候选 | 结果 | 提交 |
|---|---|---|
| #2 清理判据只留一个裁决者 | 判据归位 + 契约改包含关系 + 三撤三增变异 | `420bae7` `6435e04` |
| #1 退订收成一次变更 | `deleteSubscription` 拥有条目+游标+订阅项；失败写回 | `63fdc29` `fa6aa64` |
| 阶段 1 · tag 选中被记忆静默降级 | 四种 kind 与 NavSelection 一一对应；投影收成一个穷尽函数 | `1c26275` |
| 阶段 2 · 「打开一条」五遍 | `store.activate` 成为唯一触发点；`nextExpandedOf` 收成一条规则 | `3aff807` |
| 阶段 3 · ReaderStore 契约与替身 | 36 方法可执行契约 + 内存实现升格 + 窄接口 + 判据归一 + 五份局部桩退役 | `6fbdeb0` `03af3ed` `ba96196` `6a3f470` |
| 阶段 4 · 客户端 store 依赖暗处 | ReaderStoreDeps 接缝 + 共享假通道 + overview 桩工厂；48 项动作拆到 4b | `5de290d` `29aa58f` `f994336` `986c955` `bc119a8` `16c0bb0` `ba219ff` `764f83f` |
| 阶段 4b · 48 项动作按域分家 | 标签 / 搜索 / 订阅 / 列表四域各自成文件，store 只留装配与视图记忆 | `2db1f31` `a1d98af` `0a1d45b` `62ef6ff` `855f26c` `608d50b` `25b179c` `b98bea6` `0b34671` `0b768ae` |
| 阶段 5 · 端点的入参不在 interface 里 | 28 个端点一份 payload 声明；`defineEndpoint` 解析一次 | `310ab5b` `867eacf` `7414372` `1cb3b35` `793f706` |
| 阶段 6 · 「一页条目」没有家 | 分页协议收进 `src/item-page.ts`；store 续页谓词每种语言一处 | `33a6663` `557fcdc` `7fb9306` `252696a` |
| 阶段 7 · mutation 工具五合一 | 数据表 / 运行器 / 入口三分；缓存哈希全部模块 | `972a869` `87da798` |
| 阶段 8 · `shared.ts` 抽屉 | 规则归位：cursor / preferences / unread；shared 只留 wire + 工具 | `30fb989` `8d85811` `7260879` |
| 阶段 9 · 查询栅栏两处实现 | 搜索端点与 agent 工具共用 `src/cursor-fence.ts` | `6921e87` |

## 怎么用这份文件

- 一个阶段独立交付：`build / build:client / typecheck / test / mutation` 全绿才算完成，改完勾掉并写提交号。
- 顺序按**依赖 + 风险/价值**排，不是优先级投票；跨阶段挪动请先改这里的顺序再动手。
- 每阶段开工前先 `git log --oneline -5` + `git status`，确认基线没被推走、工作区没有别人的改动。
- 阶段内的「前置决定」没拍板就不要开工 —— 那是设计问题，不是实现问题。

---

## 阶段 1 —— tag 选中在「记忆」这条接缝上被静默降级

**状态**：已完成（`1c26275`）· **规模**：小 · **来源**：评审卡 #6

**实际改动**：`ViewPreferences['navSelection']` 增加 `{ kind: 'tag'; tagId }`；`sanitizeViewPreferences` 增加第四个
判据 `isKnownTag`（store 侧查 `tags` 表、客户端用 `state.tags`）；`persistView` 的嵌套三元换成
`memorableSelectionOf`（穷尽 switch，加第五种 kind 变编译错误）；恢复侧 tag 落到 tag 光标；
标签被删 ⇒ 回落虚拟视图。测试夹具的 overview 桩补了 `tags`（原先没有，客户端根本拿不到标签目录）。

**问题**：`NavSelection` 有四种 kind（virtual / feed / folder / tag），可记忆的 `ViewPreferences` 只有三种。
`persistView` 用一条手写三元把 tag 落成 `{ kind: 'virtual' }`，并顺手覆盖上次记住的源或文件夹。
编译器帮不上忙（else 分支是合法值），`nav-persistence` 的用例里没有一条 `kind: 'tag'`。

**证据**：`src/client/store.ts:20`（四种）、`:569`（三元只认 feed/folder）、`:1089`（四种都 persist）；
`src/shared.ts:322`（三种）、`:399`（sanitize 三种）、`src/client/store.ts:538`（恢复侧三种）。

**方案**：把「选中 ⇄ 可记忆的选中」收进一个 module，内含「哪些 kind 可记忆、不可记忆时回落成什么」的判据；
`persistView` 只调它。两种形状同源后，加第五种 kind 会有人提醒。

**验收**
- [x] 用例：`selectNav(tag)` 之后落盘的是 tag —— nav-persistence「选中的标签会记住：重开后回到同一个标签」
- [x] 用例：回落规则本身可测 —— `sanitizeViewPreferences` 的标签用例 + 「标签被删掉之后」两条
- [x] 回归：`nav-persistence` / `nav-selection` 全绿（全量 556/556；mutation 238/238、幸存 0）
- [x] 变异：新增 `client-标签选中落盘成虚拟视图`、`store-viewPreferences 不校验标签`（各被抓到）；
      重锚 3 条被新判据弄失效的旧变异（`persist-宿主写侧不归一`、`persist-宿主读侧不校验`、`store-读偏好不校验形状`）

**风险 / 前置**：先定产品语义——tag 到底该不该被记住。若答案是「不该」，那就把回落写成显式规则并留下理由，
而不是继续靠三元的 else 兜底。

---

## 阶段 2 —— 「打开一条」写了五遍，其中一遍语义不同

**状态**：已完成（`3aff807`）· **规模**：小到中 · **来源**：评审卡 #5

**前置决定（已由规范回答）**：`docs/google-reader-feature-spec.md:211` 写的是「`o` / `enter` | open/close item」——
所以行内的 Enter/Space 应当是 **toggle**，此前的「恒展开」是缺陷，不是有意行为。

**实际改动**：新增 `store.activate(itemId)`（选中 + 标已读），**已读的唯一自动触发点**；行点击 / Enter / Space /
o / v / 正文加载五处全部走它。展开规则收成导出的纯函数 `nextExpandedOf`（穷尽、可测），行内与 o 键共用；
`expanded` 仍留组件 state（裁决 Q2）。文案与注释同步说明「GR 的 o 与 enter 是同一条」。

**问题**：点击行（toggle 展开 + 标已读）、行内 Enter/Space（**恒展开**）、键 o（toggle）、键 v（外部打开 + 标已读）、
正文加载（标已读）——五处各拼一遍「选中 + 展开 + 标已读」。`expanded` 住在面板的 React 局部 state，
键盘路由为此在 ctx 上搬 value + setter 一对；行内 keydown 全仓零覆盖。

**证据**：`src/client/index.tsx:650`、`:655`；`src/client/keyboard-routing.ts:171`；`src/client/store.ts:824`、`:978`；
`src/client/index.tsx:287` + `keyboard-routing.ts:41`（expanded 的局部 state）。

**方案**：一个 store 动作拥有「选中 + 标已读」与「下一个展开值」的判定，面板与键盘只传 itemId。
`expanded` 仍是组件 state（尊重 2026-10-15 键盘路由轮的裁决 Q2），只把**切换规则**收到一处。

**验收**
- [x] `.dsh-rss-row-main` 的 Enter/Space 有直接用例 —— scroll-dom「行内 Enter / Space 与 o 同义」（点击展开 → Enter 收起 → Space 再展开）
- [x] 「打开即已读」的自动触发点从五处收到一处 —— `store.activate`；o 键的用例额外钉住「不许绕过它直接调 markRead」
- [x] 回归：`scroll-dom` / `keyboard-routing` 全绿（全量 563/563；mutation 240/240、幸存 0）
- [x] 变异：新增 `client-展开永不收起`、`client-activate 不标已读`（各被抓到）

**风险 / 前置**：Enter/Space「恒展开」可能是有意的（仓库无文档、无测试说过）。开工前先定它该 toggle 还是恒展开，
再谈收敛。

---

## 阶段 3 —— ReaderStore 的契约没有家，替身是无声的部分实现

**状态**：已完成（`6fbdeb0` `03af3ed` `ba96196` `6a3f470`）· **规模**：中到大 · **来源**：评审卡 #3 + 上一轮评审留下的两笔欠账

**原来的问题**：36 个方法的 interface 有三份实现；测试替身只实现 23 个，且比生产更宽松
（`listRecent` 忽略 cursor/feedIds/tagId；`updateItem` 与 `saveReadingProgress` 不拒绝缺失键）；
另有 5 份局部桩各写一遍。「接口就是测试面」在这里失效 —— 调用方、测试、实现跨的不是同一个接缝。
另有两笔欠账：契约不对称（旧适配器自己跑一遍 `selectCleanup`）、内存桩只产出「判定集」宽度。

**实际拆分**（票据在 `.scratch/reader-store-contract/issues/`，一票一提交）：

| 票据 | 提交 | 做了什么 |
|---|---|---|
| 01 契约套件 | `6fbdeb0` | 23 条契约断言 + 两个实现工厂 + 守门用例（空实现必须全红） |
| 02 内存实现升格 | `03af3ed` | `tests/helpers/*.mjs` → `src/memory-store.ts`（tsc 盯着，少一个方法就编译失败）；补 13 个方法，修 4 处「比生产宽松」 |
| 03 窄接口 + 判据归一 | `ba96196` | 四个 `Pick` 窄接口；`selectCleanup` 从两处执行收到一处；`cleanup-endpoint` 用例 |
| 04 局部桩退役 | `6a3f470` | 五份局部桩（430 行）→ 共享实现 + 薄覆盖；两个测试钩子（慢写入、裸写偏好） |

**结果**：36 个方法 × 3 份实现跑同一套契约（sqlite / legacy / memory）；契约里 36 个方法全部被调用，
零遗漏；`grep 'selectCleanup(' src/` 只剩 `endpoints.ts:691` 一个调用点。

**两处偏离（有意的）**：
- 窄接口用 `Pick<ReaderStore, …>` 反向派生，而不是原计划的「组合」——单份清单的性质相同、diff 更小。
  若以后要「小接口是主声明」，搬运是机械动作。
- `EndpointCtx.store` 仍是完整 `ReaderStore`（收窄它要动 28 个端点），目前只有 `accountOf` 用上了
  `UnreadStore`。这是「逐步替换」的第一步，不是遗漏。

**验收**
- [x] 三份适配器跑同一套契约，缺方法或更宽松 ⇒ 当场失败（守门用例：空实现全红）
- [x] 5 份局部桩退役（无一份需要保留）
- [x] 端点那层判据在内存实现上被覆盖（`tests/cleanup-endpoint.test.mjs`：候选含受保护行，只有该删的被删）
- [x] 回归：build / build:client / typecheck / test **637** / mutation **242**（幸存 0）全绿

---

## 阶段 4 —— 客户端 store：48 项平铺名单，依赖全在暗处

**状态**：已完成（2026-11-15）· **规模**：大 · **来源**：评审卡 #4

**原来的问题**：`createReaderStore()` 收零参数，实际依赖 fetch / AbortController / setTimeout / Date /
Blob / document / window.open / console；四份测试沙箱各复制一遍装配；改一次 overview 回包形状要动四个
测试文件。

| 提交 | 内容 |
|---|---|
| `5de290d` | **ReaderStoreDeps 接缝**：8 个依赖全部可注入，默认实现与改动前逐条一致 |
| `29aa58f` `f994336` `986c955` `bc119a8` | 共享假通道；nav-selection / unread-accounting / nav-persistence / client-bundle 四份沙箱全部接入 |
| `16c0bb0` | 假通道加编排层（script / hold / release）+ 自己的四条单测 |
| `ba219ff` | 插件入口接受可选 deps：`apply(ctx, deps?)` |
| `764f83f` | overview 回包桩收成一份共享工厂（`tests/helpers/overview-fixture.mjs`） |

**验收**
- [x] 四份沙箱收成一份假通道（client-bundle 的失败从「报错」变回「断言」）
- [x] 换一次 overview 回包形状，只改一处（`overview-fixture.mjs` 是唯一实现，四份文件只做委派）
- [x] 回归：client-bundle / nav-* / unread-accounting / scroll-dom 全绿；mutation 242/242 幸存 0

**两处偏离**：① 窄接口（`Pick` 派生）见阶段 3；② 「48 项按域分家」超出本阶段验收，已拆成**阶段 4b**
（见下，2026-11-16 已完成）—— 它的结果不计入本阶段的验收项。

---

## 阶段 4b —— 48 项动作按域分家

**状态**：已完成（2026-11-16）· **规模**：大 · **来源**：阶段 4 的方案超出验收的那部分

**做法**：先用 `37ac2f2` 把「谁写谁的 state」写成边界表，再按依赖顺序一块一块搬（每块一个提交、
各自跑四道门槛）：

| 域 | 提交 | 落点 |
|---|---|---|
| 标签（4 动作 + 写盘队列/失败代数） | `2db1f31` | `src/client/tag-actions.ts` |
| 搜索（3 动作 + 在途请求/页数） | `a1d98af` `0a1d45b` | `src/client/search-actions.ts` |
| 订阅（OPML 2 / 文件夹 4 / 导航 6 / 订阅源 4） | `62ef6ff` `855f26c` `608d50b` `25b179c` `11f2981` | `opml-actions.ts` / `folder-actions.ts` / `nav-actions.ts` / `feed-actions.ts` |
| 列表（06a 选中 / 06b 账目 / 06c 取数正文） | `b98bea6` `0b34671` `0b768ae` | `src/client/list-actions.ts` |

**结果**：`store.ts` 从 1102 行降到约 500 行，只剩 state 装配、视图记忆、跨源提示、目录落地与
域工厂；公开接口 49 个键搬家前后逐项一致；全量 test 642、mutation 242（幸存 0、未应用 0）。
票据与两轴评审记录在 `.scratch/client-store-seams/issues/`。

**评审补修（2026-11-16，`518a697`）**：四个域搬完后补跑 Standards / Spec 两个只读子代理，报出的条目已全部修完——
两条变异的 `to` 仍引用搬家前的绑定（`state` / `callRpc`，属「崩溃式假通过」，会以 ReferenceError
冒充「被抓到」）、死导出 `applyAccount`、`selectionExists` 死 import、两处失效注释、边界表例外补全，
以及本文件里 `62eff6ff` 的笔误（真实 `62ef6ff`）。修复后重跑：242/242、崩了 0、未应用 0。

---

## 阶段 5 —— 端点的入参不在 interface 里

**状态**：已完成（2026-11-17）· **规模**：中 · **来源**：评审卡 #8

**前置决定（已拍板 2026-11-16）**：重开 H1 终审的「刻意不引入 zod」裁决。zod 自 `ef50cba` 起就是运行时依赖，
H1 当时（`c901727`）的 `package.json` 已含它 —— 裁决里「新增依赖 + 供应链审查成本」两条代价当时就不成立。
限定：只用仓库已有的 zod，不新增依赖、不换库。理由与决定见 [ADR-0003](adr/0003-endpoint-payload-is-declared.md)。

**问题**：28 个端点里 **23 个接 payload**（5 个零入参：`opmlExport` / `cleanup` / `viewPreferences` /
`listFolders` / `listTags`），23 处 `payload as`、7 处 `String(x ?? '')`、3 处 `map(String)`；
只有 `searchItems` 有 zod schema。「缺字段」与「空串」在这一层不可分。两个具体缺陷：
`saveViewPreferences` 缺 `preferences` 键会把默认视图写盘；`saveReadingProgress` 缺 `ratio` 会把阅读进度写回 0。

**证据**（改动前）：`src/endpoints.ts` 的 `EndpointSpec` 只有 `carriesAccount` + `to(payload: unknown)`；
`createDispatch` 拿到的是未知形状；cast 分布在各 handler 体内（23 处，`payload as`）。

**方案**：`EndpointSpec` 多一条 `payload`（zod）与 `invalidMessage`；`defineEndpoint` 工厂解析一次、
按同一个 `bad-request` 信封拒绝（`details.issues` 带字段路径）；handler 只拿解析后的值。
声明住 `src/endpoint-payloads.ts`（共享片段 + 28 个端点的声明；20 个导出的 schema 常量），零入参写 `noPayload`。
声明只判形状与类型；URL 合法性、存在性、比例夹取仍留在 handler。

**验收**
- [x] 28 个端点都有入参声明（`Record<Endpoint, …>` 穷尽性 + `tests/endpoint-payloads.test.mjs` 的契约表）
- [x] 一种失败信封；6 条端到端细节用例（5 个端点）+ 23 个端点各一条 dispatch 坏样本（契约表另有 64 条）
- [x] `saveViewPreferences` 缺 `preferences`、`saveReadingProgress` 缺 `ratio` → `bad-request`
- [x] 回归：`endpoint-payloads` / `endpoint-registry` / `*-endpoints` / `http-route` 全绿（全量 647/647；mutation 245/245、幸存 0）

**风险**：错误文案按端点收敛成一条（三条金标准文案逐字保留）；客户端零文案依赖（已核对）。
客户端 payload 类型化不在本阶段（触发条件：客户端发错字段的真实缺陷，或端点 ≥ 35）。

---

## 阶段 6 —— 「一页条目」没有家：buildOverview 把六件事塞进一个闭包

**状态**：已完成（2026-11-18）· **规模**：中到大 · **来源**：评审卡 #7

**问题（原始）**：115 行里同时有范围解析、孤儿过滤、窗口放大 ×2、多取一行判尾、ItemView 投影、
标签批量补、nextCursor 合成、未读账求和；游标围栏的编码在 `:129`、解码在 `:336`，中间隔 200 行；
同一 keyset 谓词在 `store-sqlite` 里有三个 SQL 变体、旧适配器还有一份 JS 版。要测其中任何一件，
都得起真库 + 真 dispatch。核对后谓词副本是 **5 份**（3 个 SQL 变体 + `store.ts` + `memory-store.ts`）。

**实际改动**（源码核对）：新增 `src/item-page.ts`（ADR-0004）——`PageScope` 判别联合、`fenceKeyOf`、三态
`decodePageCursor` / `encodePageCursor`、`afterCursor`、`buildItemPage`（窗口放大 + 多取一行判尾）。
`buildOverview` 从 116 行降到 83 行，只剩目录 / 账目 / refresh 装配与 `ItemView` 投影；overview 的
handler 只把三态映射成原有两条文案。store 侧续页谓词收成「每种语言一处」：`store-sqlite` 的
`AFTER_CURSOR` 片段（三个范围变体共用）+ `item-page` 的 `afterCursor`（`store.ts` / `memory-store.ts`
共用）；`ReaderStore.listRecent` 签名未动。契约补一条 scoped 分页（`feedIds` / `tagId` + 游标，三份实现同跑）。

**验收**
- [x] 分页协议只有一个 owner（编码/解码不再隔 200 行）——`src/item-page.ts:27-72`
- [x] 一页的产生可以不经真库直接测 ——`tests/item-page.test.mjs`：六个用例，纯假 `listRecent`
- [x] 回归：`overview-paging` / `overview-scale`（10 万行）全绿（全量 657/657；mutation 246/246、幸存 0 —— 均**实测**）

**与计划的偏离**：
- `buildOverview` 预计降到 ~45 行，实际 83 行：目录 / 账目 / refresh 元信息的装配与既有注释比估计重，
  但已不再含任何分页判定。
- 变异总数 245 → **246** 而不是 249：新增 4 条，重锚 **5** 条（原计划 4 条，多出 `folder-空范围回落全表`
  ——取数调用搬进 item-page 后它也要换锚），同时退役 3 条「随代码消失 / 被新条目覆盖」的
  （`folder-游标不校验范围`、`tag-浏览游标绑名称`、`paging-旧实现谓词的 id 方向写反`），逐条理由写在
  `scripts/mutation-test.mjs` 里——退役的是冗余或类型层面已不可表达的变异，判据本身没有减少。
- 提交：`33a6663`（ADR）→ `557fcdc`（模块）→ `7fb9306`（端点接入）→ `252696a`（store 谓词）→ 本提交（PLAN 结项）。

**风险 / 顺序**：这个文件刚经历过 H1（端点注册表）与阶段 5，排在阶段 5 之后做，避免连搬两次同一个文件。

---


## 阶段 7 —— mutation 工具五合一（候选池转正）

**状态**：已完成（2026-11-18）· **规模**：中 · **来源**：评审「也看到了，这轮没展开」第 5 条；
触发条件「门槛再调一次并发或判定」已在 `d940811`（判据级并发 + 增量模式）响过一次。

**问题**：2,626 行单文件 = 1,956 行数据表（246 条）+ 645 行运行器（套件判定 + worker 池 + 资源闸 +
增量缓存 + 报表 + CLI）。加一条变异要在两千行里找一个位置；改缓存、改报表与改判定挤在同一个文件里。

**实际改动**：`scripts/mutation/` 六模块 + 入口只留 `parseArgs` / `runFast` / `main`：
`table.mjs`（246 条，理由注释原样）、`host.mjs`（ROOT + 资源闸）、`suite.mjs`（`runSuite` / `classify` /
`crashName` / `judgesFromFails`）、`worker.mjs`（副本 / `applyMutation` / `partitionMutations` /
`buildWorkerScript` / `runWorker`）、`incremental.mjs`（缓存 + `--changed`）、`report.mjs`（汇总 /
`--timings` / judges 快照 / 退出码）。缓存版本改为哈希「入口 + 目录全部模块」；`--changed` 把目录算
「全部」；`mutation:calibrate` 输出从已删除的 `docs/superpowers/` 改到 `.scratch/mutation/judges-dump.json`；
结构测试改为读多文件（锚点不变，新增「入口不许回流」与「目录枚举」两条）。

**验收**
- [x] `npm test` 659/659（结构测试 14 条）
- [x] 拆分前后全量 gate 各 246/246；`--dump-judges` 逐 id 一致（忽略 `generatedAt`）
- [x] `--mode fast` / `--mutations` 子集 / `--timings` / `--incremental` / `--changed` 烟测
- [x] 变异表与判定语义零变化（246 条、0 幸存）

**偏离**：真 worker 文件与数据表分域未做（见 `.scratch/mutation-split/spec.md` 的「不在本阶段」）；
提交号见上表。


## 阶段 8 —— `shared.ts` 是 42 个导出的抽屉

**状态**：已完成（2026-11-18）· **规模**：中 · **来源**：评审「也看到了」第 4 条
（候选触发条件「阶段 3/4 落地后仍觉得概念找不到家」已满足）

**问题（细化后的口径）**：42 个导出 = 7 个概念——传输契约 6、wire 形状 16、未读判据 3、
视图/阅读偏好 7、文本工具 4、排序/游标 4、健康 2。30 个 src importer + 9 个测试文件直接 import；
其中 21 个 importer 只取 ≤4 个符号，但**带规则的概念**（游标协议 / 偏好归一化 / 未读判据）没有地址。
评审时说的「21 个文件 / 第三热」已过期：现为 30 个文件、全历史提交数排第 5（29 次），
最近 30 个提交触达 0 次。

**实际改动**：`src/cursor.ts`（`recencyOf` / `Cursor` / `encodeCursor` / `decodeCursor`）、
`src/preferences.ts`（两个偏好类型 + 5 个常量 + `sanitizeViewPreferences`）、
`src/unread.ts`（`isUnread` / `countUnreadPerFeed` / `UnreadAccount`）。
`shared.ts` 从 42 降到 **28** 个导出（传输 6 + wire 16 + 文本 4 + 健康 2），头注释改为「wire 契约 + 纯工具」。
`afterCursor` 按 ADR-0004 留在 `item-page.ts`（不在本轮范围内）。
新增 `tests/shared-boundary.test.mjs`（两条结构判据：规则不许回流、三个规则模块必须存在）；
三处变异的目标文件随符号迁移（`lib/cursor.js` / `lib/preferences.js` / `lib/unread.js`）。

**验收**
- [x] `shared.ts` 42 → 28 个导出；三个新模块各 ≤7 个导出
- [x] `npm test` 661/661；`build` / `typecheck` / `build:client` 通过
- [x] 客户端 bundle 体积未增（598.49 kB → 596.72 kB，**实测**）
- [x] 三处变异锚点随迁移命中一次；结构判据防规则回流

**偏离 / 未做**：`reading.ts`（估算/夹取/最小字符）与 `url.ts` 未拆——按拍板留到下一轮；
`UnreadAccount` 搬进 `unread.ts` 后，`shared.ts` 的 `Overview` 从它 import（单向，无环）。


## 阶段 9 —— 查询栅栏两处实现（阶段 6 欠账）

**状态**：已完成（2026-11-18）· **规模**：小 · **来源**：阶段 6 的「不在本阶段」；
触发条件「出现第三处栅栏」按字面已满足（overview 范围栅栏 + searchItems 查询栅栏 + tools.rss_search 查询栅栏）。

**问题**：`endpoints.ts` 的 searchItems 与 `tools.ts` 的 rss_search 各写一份
「哈希查询条件 → 加 `:` → 切片 → `decodeCursor` → 拼 nextCursor」。同一协议两份实现，
改一处不会让另一处红；失效形态是「换查询条件仍按旧边界续页」——不报错，只是结果错。

**实际改动**：新增 `src/cursor-fence.ts`（`queryFenceKey` / `decodeFencedCursor` / `encodeFencedCursor`）；
两个调用方改用它，错误文案各自保留；`tests/cursor-fence.test.mjs` 三条协议判据；
变异 `tools-游标不校验条件` 改为 `fence-查询栅栏不校验条件`（目标 `lib/cursor-fence.js`，
judges 同时覆盖 search.test 与 tools.test）。

**验收**
- [x] `npm test` 664/664；`build` / `typecheck` 通过
- [x] 全量 mutation：246/246、0 幸存（新锚点命中一次）
- [x] 搜索/工具行为不变（search.test / tools.test 原用例全绿）

**偏离**：`item-page` 的范围栅栏没有并入（owner 不同；wire 格式已共用）。
## 未立项的观察（候选池，不是阶段）

评审时有五条看到但没展开的；两条已转阶段（第 4 条 → 阶段 8，第 5 条 → 阶段 7），两条复核后关闭，仅剩一条：

| 观察 | 触发条件 |
|---|---|
| 搜索线程自开连接、自写 SQL、自做投影（`search-worker.ts:74-104,122`）—— schema 的第二个主人 | **加/改 `items` 列或搜索谓词时**（schema 改名/缺列会被真库用例当场抓到；新增谓词才可能悄悄漏） |

**2026-11-18 复核后关闭两条**：
- 「左栏行序与行键各写三份」——行序已单源（`nav-model.ts:27` 的 `navRowsOf`，nav-actions 与 feed-nav 共用）；
  剩下的两处是 `feed-nav.tsx:88,168` 的 DOM 字面量，测试里的字符串就是 DOM 契约本身，抽 helper 消不掉。
- 「滚动几何 7 处现场重算」——数学已单源：`list-scroll.ts`（183 行纯函数，有单测），三个调用点都走它；
  剩余只是「接口收散装 number」的审美问题，等真实缺陷再议。

## 维护约定

- 完成一个阶段：勾掉验收项、写提交号，**不要**在这里记流水账（过程写 issue，结论写提交）。
- 新增候选：先进「候选池」并写触发条件；只有当它被排期时才升成阶段。
- 与 ADR 冲突的候选（如阶段 5）：先改 ADR 再开工，不要边做边改判据。
