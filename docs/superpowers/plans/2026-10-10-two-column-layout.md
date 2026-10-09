# 阅读区两列布局 实施计划

> **面向 Agent 执行者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 按任务逐项实现本计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 把主栏 RSS 阅读区从单列改成两列——左侧「订阅导航」（虚拟视图 + 订阅源 + 未读角标），右侧文章列表；点左侧某项即按「源 x 顶栏过滤」叠加过滤右侧列表。

**架构：** 前端在现有 store 上新增一条**导航轴**（navSelection），`visible()` 在其上叠加 feedId 条件。per-feed 未读数由 host 在 overview 端点的既有单趟遍历里算出、随 payload 下发（客户端 items 被 maxItemsShown 截断，前端派生会与总数不一致）。布局在 index.tsx 由单列 flex 改为「左栏 + 右栏」横向 flex，左栏新建独立组件文件。

**技术栈：** Node ESM + React 18（无第三方库；客户端 bundle 禁引外部依赖）；zod 域 schema；tsc（host）+ tsdown（client 单文件 bundle）；node:test 套件跑 `lib/` 产物。

**规格：** docs/specs/two-column-layout-spec.md（下称「本功能 spec」）。计划以规格为依据进行论证，故规格须随计划一起流转；执行者两者都要读。史料依据：docs/google-reader-feature-spec.md（下称「GR spec」）。踩坑清单：docs/pitfalls.md。

## 全局约束

- 客户端 bundle 除 `tsdown.config.ts` 的 neverBundle 外**不许引第三方库**。
- `as any` / `@ts-ignore` / `@ts-expect-error` 一律禁止（strict: true）。
- 禁止空 catch；异常必须有可见后果（日志 / 重抛 / 界面报错）。
- 测试跑的是 `lib/` 产物：改完 `src/` 必须 `npm run build`；动过 `src/client/**` 必须再跑 `npm run build:client`。
- `npm run mutation` 会临时改坏 `lib/`，**必须在 /tmp 隔离副本里跑**（软链 node_modules；重跑前从源目录重新拷 lib）。
- 键位改动必须**四处同步**：src/keys.ts、src/client/index.tsx 的帮助行、README 键位表、界面标签 —— 否则复发「标签写 R、实现只认 shift+R」那类缺陷。
- 样式沿用现有约定：inline style + `dsh-rss-` 前缀类 + `color-mix(in srgb, currentColor N%, transparent)` 跟随宿主主题，不碰宿主视觉 token。
- **禁止动 domain schema 的版本号或新增表**：本域是 single layout、版本硬相等，实测升版会直接打不开域（src/domain.ts:154-169）。
- 注释与 commit message 写中文、写「为什么」；commit 结构：病象 -> 根因 -> 修法 -> 证据。

## Review Focus

1. **持久化数据不可信**：旧的或已损坏的布局偏好被读回来时，理性期待是**无声回落默认值**并照常使用，而不是抛错或打不开域。落在任务 7。
2. **未读账目漂移**：某源已退订但条目仍在 items 里，或受 maxItemsShown 截断影响——理性期待是左栏角标之和恒等于顶栏总未读。落在任务 1、任务 5。
3. **切到某个源后 selectedId 指向被过滤掉的条目**：理性期待是选中项自动落到新列表第一条，而不是空列表下按 j/k 崩溃或选中一个不可见条目。落在任务 2。
4. **u 键改用途后标签不同步**：理性期待是键位、帮助行、README、标签四处一致。落在任务 6。
5. **左栏常驻后滚动容器语义漂移**：理性期待是订阅管理页行为不变，n/p 与空格只作用于右栏，不误滚左栏。落在任务 4。

---

### 任务 1：per-feed 未读数（host 侧）

**文件：**
- 修改：`src/shared.ts`（Overview 接口）
- 修改：`src/endpoints.ts` 的 buildOverview
- 测试：`tests/endpoints-perfeed-unread.test.mjs`（新建）

**接口：**
- 消费：src/endpoints.ts 里既有的单次全表遍历（`target.allItems()` 循环）。
- 产出：`Overview.perFeedUnread: Record<string, number>`（feedId 到该源未读数的映射）。任务 2、5 依赖它。

- [ ] **步骤 1：编写失败的测试**

新建 `tests/endpoints-perfeed-unread.test.mjs`，装配 EndpointDeps 的桩依赖后调 createDispatch 的 overview 端点：

```js
test('perFeedUnread：各源未读数之和 === 顶栏总未读', () => {})
test('perFeedUnread：条目数超过 maxItemsShown 时仍按全量统计（不跟随 items 截断）', () => {})
test('perFeedUnread：已退订源（items 里还剩条目）不出现在 map 里', () => {})
```

- [ ] **步骤 2：跑测试，确认它失败**

运行：`npm run build && node --test tests/endpoints-perfeed-unread.test.mjs`
预期：FAIL（perFeedUnread 不存在）

- [ ] **步骤 3：加字段并累加**

在 src/shared.ts 的 Overview 加 `perFeedUnread: Record<string, number>`。在 buildOverview 的同一次 `for (const [itemId, item] of target.allItems())` 循环里，对**已确认所属源还在**的条目累计：`item.readAt === undefined` 则该源 +1。写在 items 被截断之前，与 unread 用同一份判断，避免两处漂移。

- [ ] **步骤 4：跑全量测试，确认通过**

运行：`npm run build && node --test tests/`
预期：PASS，既有测试全绿

- [ ] **步骤 5：提交**

```bash
git add src/shared.ts src/endpoints.ts tests/endpoints-perfeed-unread.test.mjs
git commit -m "feat(host): overview 下发 per-feed 未读数"
```

---

### 任务 2：store 的导航轴（navSelection + 叠加过滤）

**文件：**
- 修改：`src/client/store.ts`（ReaderState、visible()、新动作与导出）
- 测试：`tests/nav-selection.test.mjs`（新建）

**接口：**
- 消费：任务 1 的 Overview.perFeedUnread（在 applyOverview 里落到 state）。
- 产出：navSelection、perFeedUnread、`selectNav(next)`、`toggleNav()`；visible() 在 filter 之上叠加 feedId 条件。类型：

```ts
type NavSelection = { kind: 'virtual' } | { kind: 'feed'; feedId: string }
```

任务 4、5、6、7 消费这些。

- [ ] **步骤 1：编写失败的测试**

新建 `tests/nav-selection.test.mjs`，沿用 tests/client-bundle.test.mjs 里 driveStore 那套「真 store + 桩 fetch」风格：

```js
test('选源后 visible() 只含该源条目', async () => {})
test('叠加：源 + 未读 filter 只显示该源未读', async () => {})
test('虚拟视图与既有 setFilter 等价，不留两套状态', async () => {})
test('再点已选中的源 = 取消选中，回到虚拟视图', async () => {})
test('切到源后 selectedId 落到新列表第一条', async () => {})
```

- [ ] **步骤 2：跑测试，确认它失败**

运行：`npm run build && npm run build:client && node --test tests/nav-selection.test.mjs`
预期：FAIL（selectNav 未定义）

- [ ] **步骤 3：实现 navSelection 与叠加过滤**

ReaderState 加 `navSelection: NavSelection`（初值 `{ kind: 'virtual' }`，等价现有 filter 行为）与 perFeedUnread。selectNav(next) 写入并在 `kind === 'virtual'` 时同步 filter。visible() 的 matches 在现有逻辑之后追加：`if (state.navSelection.kind === 'feed' && item.feedId !== state.navSelection.feedId) return false`。

**不要新增第四个「当前视图」概念**：view 管面板、layout 管条目密度、navSelection 管导航选中，三条轴各管一件事。

- [ ] **步骤 4：跑全量测试，确认通过**

运行：`npm run build && npm run build:client && node --test tests/`
预期：PASS。既有断言若因 visible() 语义变化而红，**不许放宽断言**，先判断是不是真回归。

- [ ] **步骤 5：提交**

```bash
git add src/client/store.ts tests/nav-selection.test.mjs
git commit -m "feat(store): 加导航轴 navSelection，源 x filter 叠加过滤"
```

---

### 任务 3：左右分栏布局（index.tsx + 新左栏组件）

**文件：**
- 新建：`src/client/feed-nav.tsx`（FeedNav 组件）
- 修改：`src/client/index.tsx`（根布局改横向 flex，插入左栏）
- 测试：`tests/scroll-dom.test.mjs`（追加断言）

**接口：**
- 消费：任务 2 的 navSelection / selectNav / perFeedUnread，以及 state.feeds、state.filter、state.showUnread。
- 产出：`export const LEFT_NAV_WIDTH = 240`（折叠时**不占宽度**，不是 width:0）；FeedNav 被 index.tsx 渲染。任务 4 的容器标记依赖本任务的 DOM 结构。

- [ ] **步骤 1：编写失败的测试**

在 tests/scroll-dom.test.mjs（真实 React 18 + jsdom 层）追加：

```js
test('左栏渲染：虚拟视图三行 + 每个订阅源一行', () => {})
test('隐藏未读计数时左栏角标也消失（GR spec 不变量 8）', () => {})
test('点击某个源：右栏列表只剩该源条目', () => {})
```

- [ ] **步骤 2：跑测试，确认它失败**

运行：`npm run build && npm run build:client && node --test tests/scroll-dom.test.mjs`
预期：FAIL（左栏未渲染）

- [ ] **步骤 3：实现布局与 FeedNav**

index.tsx 外层改为「横向 flex（左栏 + 右栏）」包住现有纵向结构——**右侧内容不动**，只套一层横向容器。FeedNav 按现有 STYLE 约定写 inline style；源行含标题 + 未读角标（取自 perFeedUnread）；showUnread 为 false 时不渲染角标。三段式演进余地留给后续：此刻**不要**引入第三个分支或新的 view 值。

- [ ] **步骤 4：跑全量测试，确认通过**

运行：`npm run build && npm run build:client && node --test tests/`
预期：PASS

- [ ] **步骤 5：提交**

```bash
git add src/client/feed-nav.tsx src/client/index.tsx tests/scroll-dom.test.mjs
git commit -m "feat(client): 阅读区改两列，新增左栏订阅导航"
```

---

### 任务 4：滚动容器语义同步

**文件：**
- 修改：`src/list-scroll.ts`（scrollSelectorFor）
- 修改：`src/client/index.tsx`（容器标记）
- 测试：`tests/list-scroll.test.mjs`、`tests/scroll-dom.test.mjs`

**接口：**
- 消费：任务 3 的 DOM 结构；`scrollSelectorFor(view: string): string | undefined` 签名不变。
- 产出：列表类视图命中**右栏**容器；feeds 仍返回 undefined（保持「该视图本就没有滚动容器」的既有不变量）。

- [ ] **步骤 1：编写失败的测试**

纯函数层（tests/list-scroll.test.mjs）加一条：

```js
test('两列后：列表类视图共用右栏容器选择器，feeds 仍无容器', () => {})
```

真实 DOM 层（tests/scroll-dom.test.mjs）加一条：

```js
test('滚动不误命中左栏：n/p 与空格只滚右栏', () => {})
```

- [ ] **步骤 2：跑测试，确认它失败**

运行：`npm run build && npm run build:client && node --test tests/list-scroll.test.mjs tests/scroll-dom.test.mjs`
预期：FAIL

- [ ] **步骤 3：同步容器语义**

列表类视图返回 `[data-rss-scroll="list"]`（右栏列表容器沿用该标记，不新增第三个取值）；左栏容器打**不同的**标记，确保不被既有选择器命中。feeds 视图保持现状返回 undefined。

- [ ] **步骤 4：跑全量测试，确认通过**

运行：`npm run build && npm run build:client && node --test tests/`
预期：PASS

- [ ] **步骤 5：提交**

```bash
git add src/list-scroll.ts src/client/index.tsx tests/list-scroll.test.mjs tests/scroll-dom.test.mjs
git commit -m "fix(client): 两列后滚动容器语义同步"
```

---

### 任务 5：未读账目守恒

**文件：**
- 测试：`tests/unread-accounting.test.mjs`（新建）
- 可能改动：`src/endpoints.ts`（仅当守恒不成立）

**接口：**
- 消费：任务 1 的 perFeedUnread、任务 2 的 state 落位。
- 产出：守恒被钉住，后续改动读到这里就知道约束。

- [ ] **步骤 1：编写失败的测试**

```js
test('账目守恒：各源未读之和 === Overview.unread，且不受 maxItemsShown 截断影响', () => {})
test('账目守恒：某源条目全部已读后该源角标为 0，总和同步下降', () => {})
```

- [ ] **步骤 2：跑测试**

运行：`npm run build && npm run build:client && node --test tests/unread-accounting.test.mjs`
预期：任务 1 实现正确即 PASS。若为 FAIL，**先修 host 计数，不要改断言**——这正是本条不变量存在的意义。

- [ ] **步骤 3：按需让 buildOverview 守恒成立**

仅失败时：让 perFeedUnread 与 unread 在同一次遍历里用同一份判断（readAt === undefined）。

- [ ] **步骤 4：跑全量测试**

运行：`npm run build && npm run build:client && node --test tests/`
预期：PASS

- [ ] **步骤 5：提交**

```bash
git add tests/unread-accounting.test.mjs src/endpoints.ts
git commit -m "test: 钉住未读账目守恒"
```

---

### 任务 6：键盘流（u 改键 + 导航键）

**文件：**
- 修改：`src/keys.ts`（resolveReaderKey 与 ReaderKeyAction）
- 修改：`src/client/index.tsx`（动作接线 + 帮助行）
- 修改：`README.md`（第 6 行概览与第 66 行键位表）
- 测试：`tests/keys.test.mjs`
- 测试：`scripts/mutation-test.mjs`（新增变异）

**接口：**
- 消费：任务 2 的 selectNav / toggleNav、任务 3 的 LEFT_NAV_WIDTH 折叠。
- 产出：用户可只用键盘操作左栏。

键位决策（用户已拍板 A 方案）：

| 键 | 动作 | 说明 |
|---|---|---|
| u | toggleNav | 改归 GR 原义 = 左栏显隐（GR spec 3.8 第 250 行的 u） |
| shift+d | halfPageUp | 接盘原本 u 的向上半页；d 向下半页不变 |
| shift+n / shift+p | navNext / navPrev | 导航内移动选中（GR spec 3.8 第 209 行） |
| shift+o | navOpen | 打开导航中当前选中项（GR spec 3.8 第 212 行） |

- [ ] **步骤 1：编写失败的测试**

在 tests/keys.test.mjs 追加：

```js
test('u 归还 GR 原义：左栏显隐', () => { assert.equal(resolveReaderKey('u'), 'toggleNav') })
test('向上半页改由 shift+d 承担', () => { assert.equal(resolveReaderKey('d', true), 'halfPageUp'); assert.equal(resolveReaderKey('d'), 'halfPageDown') })
test('导航键 shift+n/p/o', () => { assert.equal(resolveReaderKey('N'), 'navNext'); assert.equal(resolveReaderKey('P'), 'navPrev'); assert.equal(resolveReaderKey('O'), 'navOpen') })
test('小写 n/p/o 仍是原语义，不被导航键抢占', () => { assert.equal(resolveReaderKey('n'), 'scanNext'); assert.equal(resolveReaderKey('o'), 'expand') })
```

注意：resolveReaderKey 只拿到 key 与 shift 标志；按 shift+n 时浏览器给的 event.key 是大写 'N'。参考既有第 43-45 行（N/P 此前刻意不绑，本次改为绑定）保持大小写约定一致。

- [ ] **步骤 2：跑测试，确认它失败**

运行：`npm run build && node --test tests/keys.test.mjs`
预期：FAIL

- [ ] **步骤 3：实现键位映射与接线**

ReaderKeyAction 加 toggleNav / navNext / navPrev / navOpen；halfPageUp 改由 d + shift 触发。index.tsx 的 switch 接上对应 case，并同步帮助行与 README。

- [ ] **步骤 4：跑全量测试，确认通过**

运行：`npm run build && npm run build:client && node --test tests/`
预期：PASS（既有「d/u 翻半页」断言按新语义更新，属键位决策的直接结果，不是放宽）

- [ ] **步骤 5：给新键位补变异条目**

在 scripts/mutation-test.mjs 的 MUTATIONS 追加 u 与 shift+d 两条。from 必须照 **lib/keys.js 产物**的真实形状写（先 grep 产物再落；见 docs/pitfalls.md 一、1.4「变异条目的 from 要照编译产物的实际形状写」）。

- [ ] **步骤 6：提交**

```bash
git add src/keys.ts src/client/index.tsx README.md tests/keys.test.mjs scripts/mutation-test.mjs
git commit -m "feat(keys): u 归还 GR 原义显隐左栏，补 shift+n/p/o 导航键"
```

---

### 任务 7：视图记忆持久化

**文件：**
- 待定（由步骤 0 的选择决定）
- 修改：`docs/specs/two-column-layout-spec.md`（回写第七节）
- 测试：`tests/nav-persistence.test.mjs`（新建）

**接口：**
- 消费：任务 2 的 navSelection / filter / navVisible。
- 产出：面板重开后恢复到上次的导航选中、filter 与左栏显隐。

- [ ] **步骤 0：先确定持久化落点**

候选：(a) 现有三张表之一；(b) 复用 Config 通道；(c) 新增 ui 表。
**硬边界**：domain 为 single layout 且版本硬相等（src/domain.ts:154-169 实测），**禁止新增表或升版本**——那会让已有用户的域打不开。只能在既有 tables 里找地方，或走 Config。实现者先读 src/domain.ts:170-177 的三张表与 src/index.ts 的 Config 通道，选定后**回写**本功能 spec 第七节。

- [ ] **步骤 1：编写失败的测试**

```js
test('记住上次选中的导航项、filter 与左栏显隐，重开后恢复', async () => {})
test('持久化值不可信时（未知 feedId / 非法形状）回落默认值且不抛错', () => {})
```

- [ ] **步骤 2：跑测试，确认它失败**

运行：`npm run build && npm run build:client && node --test tests/nav-persistence.test.mjs`
预期：FAIL

- [ ] **步骤 3：实现持久化与恢复**

读取时一律校验形状，不可信就回落默认——**不许编造数据**（认不出就回落，不猜）。

- [ ] **步骤 4：跑全量测试**

运行：`npm run build && npm run build:client && node --test tests/`
预期：PASS

- [ ] **步骤 5：回写 spec 并提交**

```bash
git add docs/specs/two-column-layout-spec.md tests/nav-persistence.test.mjs <本任务改动的实现文件>
git commit -m "feat(client): 记住上次的导航视图"
```

---

### 任务 8：收尾与门禁（完成定义）

**文件：** 本计划改动过的全部文件

- [ ] **步骤 1：跑完成定义**

```bash
npm run build && npm run build:client && npm run typecheck && npm test
```
预期：全部 PASS，0 错误。

- [ ] **步骤 2：在隔离副本里跑变异门槛**

复制到 /tmp 隔离副本（软链 node_modules；重跑前从源目录**重新拷 lib**）再执行 `npm run mutation`。预期 **0 幸存**（含任务 6 新增的两条键位变异）。

- [ ] **步骤 3：真机三步**

dev_reload_package（重载前后都应 [active]）→ 看 `$DSH_HOME/state/dsh-rss-reader/reader.log` 无「装载失败」→ `curl -X POST http://127.0.0.1:3080/rss-reader-api -d '{"endpoint":"overview","payload":{}}'` 得 401（路由活着）。

- [ ] **步骤 4：报告并等待确认再提交**

把改动清单与上述证据汇总给用户；**不自动 commit**。
