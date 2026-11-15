# PLAN —— 架构候选的分阶段执行计划

> 来源：2026-11-14 的架构评审（8 个候选，报告是 /tmp 下的临时 HTML，**不作为长期依赖**）。本文件只列
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

**状态**：未开始 · **规模**：大 · **来源**：评审卡 #4

**问题**：`createReaderStore()` 收零参数，实际依赖 `fetch` / `AbortController` / `setTimeout` / `Date` / `Blob` /
`document` / `window.open` / `console`；四份测试沙箱各复制一遍装配；`account-mirror` 的 `deps.callRpc` 只有 store
一个 adapter，是**假想**接缝。改一次 overview 回包形状要动四个测试文件。

**证据**：`src/client/store.ts:268`（零参数）、`:1409`（48 个成员）；`tests/nav-selection.test.mjs:63`、
`tests/unread-accounting.test.mjs:290`、`tests/nav-persistence.test.mjs:390`、`tests/client-bundle.test.mjs:41`；
`src/client/account-mirror.ts:59`。

**方案**：在构造处画一条真接缝——把通道、时钟、opener 作为**显式依赖**注入；内部按列表 / 搜索 / 订阅管理 / 标签分家，
各自只暴露自己那几项。可复用阶段 3 的「契约 + 替身」写法。

**验收**
- [ ] 四份沙箱收成一份假通道（`client-bundle` 的失败必须从「报错」变回「断言」）
- [ ] 换一次 overview 回包形状，只改一处
- [ ] 回归：`client-bundle` / `nav-*` / `unread-accounting` / `scroll-dom` 全绿

**风险**：动了构造函数 ⇒ 所有客户端用例的 setup 跟着改。一次性改完、单独提交，不要和别的阶段混。

---

## 阶段 5 —— 端点的入参不在 interface 里

**状态**：未开始 · **规模**：中 · **来源**：评审卡 #8

**问题**：28 个端点里 27 个的 payload 形状只能从 handler 体内的 cast 反推（**23 处** `payload as`），
`String(x ?? '')` 让「缺字段」与「空串」不可分；只有 `searchItems` 有 zod schema。

**证据**：`src/endpoints.ts:73`（EndpointSpec 只有 carriesAccount + to）、`:290`（唯一 schema）、`:917`（createDispatch）；
23 处 cast：`:134` `:367` `:400` `:528` `:616` `:711` `:743` `:878`（其余同形）。

**前置决定（必须先拍板）**：与 H1 终审的执行期 Ruling「刻意不引入 zod」冲突——当时是 6 处，现在是 23 处。
建议重开并限定「只用仓库已有的 zod，不新增依赖」，同时补一条 ADR 记录这次重开。**没拍板不开工。**

**方案**：`EndpointSpec` 多一条入参声明；`createDispatch` 解析一次、按同一个 `bad-request` 信封拒绝；
handler 只拿解析后的值。

**验收**
- [ ] 28 个端点都有入参声明（`Record<Endpoint, …>` 的穷尽性会替我们盯着）
- [ ] 一种失败信封；至少 5 个端点有「坏入参」用例
- [ ] 回归：`endpoint-registry` / `*-endpoints` / `http-route` 全绿

**风险**：错误文案会变。客户端若有按 message 判断的地方，先盘点再改。

---

## 阶段 6 —— 「一页条目」没有家：buildOverview 把六件事塞进一个闭包

**状态**：未开始 · **规模**：中到大 · **来源**：评审卡 #7

**问题**：115 行里同时有范围解析、孤儿过滤、窗口放大 ×2、多取一行判尾、ItemView 投影、标签批量补、
nextCursor 合成、未读账求和；游标围栏的编码在 `:129`、解码在 `:336`，中间隔 200 行；同一 keyset 谓词在
`store-sqlite` 里有三个 SQL 变体、旧适配器还有一份 JS 版。要测其中任何一件，都得起真库 + 真 dispatch。

**证据**：`src/endpoints.ts:167`（buildOverview 到 :282）、`:217`（window *= 2）、`:255`（nextCursor 合成）；
`src/store-sqlite.ts:163`；`src/store.ts:332`。

**方案**：把「(范围, 游标, 页大小) → 条目 + 下一游标」收成一个 module，窗口补偿与游标围栏一起住进去；
store 退化成只回答「这个范围里排在 X 之后的下一批行」。

**验收**
- [ ] 分页协议只有一个 owner（编码/解码不再隔 200 行）
- [ ] 一页的产生可以不经真库直接测
- [ ] 回归：`overview-paging` / `overview-scale`（10 万行）全绿

**风险 / 顺序**：这个文件刚经历过 H1（端点注册表）与阶段 5，排在阶段 5 之后做，避免连搬两次同一个文件。

---

## 未立项的观察（候选池，不是阶段）

评审时有五条看到但没展开的；先记在这里，**不排期**，等触发条件出现再立项：

| 观察 | 触发条件 |
|---|---|
| `src/shared.ts` 是 42 个导出的抽屉，21 个文件 import（第三热的文件） | 阶段 3/4 落地后仍觉得概念找不到家 |
| 搜索线程自开连接、自写 SQL、自做投影（`search-worker.ts:4,95,115`）—— schema 的第二个主人 | 改表结构，或搜索变慢 |
| 左栏行序与行键各写三份（`store.ts:62` / `feed-nav.tsx:76` / 测试里硬编码） | 加第五种虚拟视图，或改行键编码 |
| 滚动几何在 7 处现场重算（`article-pane` ×5、`keyboard-routing` ×2） | 再出一次「贴底 / 恢复位置」类缺陷 |
| `scripts/mutation-test.mjs` 2037 行的五合一（1600 行数据表 + 判定 + worker 池 + 资源闸 + CLI） | 门槛再调一次并发或判定 |

## 维护约定

- 完成一个阶段：勾掉验收项、写提交号，**不要**在这里记流水账（过程写 issue，结论写提交）。
- 新增候选：先进「候选池」并写触发条件；只有当它被排期时才升成阶段。
- 与 ADR 冲突的候选（如阶段 5）：先改 ADR 再开工，不要边做边改判据。
