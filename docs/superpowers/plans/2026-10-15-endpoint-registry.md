# H1 端点注册表实施计划（2026-10-15）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `src/endpoints.ts` 的分发 switch 深化成一个注册表 module：端点名字单点声明、横切不变量（未读账/守卫/错误信封）单点实现，让「加一个端点」与「客户端拼错端点名」都在编译期或单点可见。

**Architecture:** 名字常量 `ENDPOINT_NAMES` 与联合类型 `Endpoint` 的派生关系落在 `src/shared.ts`（两侧共用，type-only import，零 bundle 影响）；host 侧 `ENDPOINTS: Record<Endpoint, EndpointSpec>` 表强制穷尽，`createDispatch` 退化为「守卫 → 查表 → to → 信封」的薄分发核；`carriesAccount` 声明把 5 处手写 `...accountOf(target)` 收成 1 处实现。

**Tech Stack:** Node ESM + TypeScript（`strict: true`，无 `as any`/`@ts-ignore`）· tsc → `lib/` · node:test · 自研变异门槛 `scripts/mutation-test.mjs`

**Spec:** 本计划的规格 = 2026-10-15 架构体检的 H1 卡（会话内三轮 grilling 收敛，共 21 项裁决）。仓库无 `docs/adr/`、无 `GLOSSARY.md`。

## Global Constraints

- 客户端 bundle **不许引第三方库**（`tsdown.config.ts` 的 `neverBundle` 之外全打进 bundle）⇒ 校验只能留 host 侧。
- `strict: true`；禁 `as any` / `@ts-ignore` / `@ts-expect-error`。
- 测试 import `../lib/…`（**构建产物**）：改完源码必须先 `npm run build` 再测；动过 `src/client/**` 才需要 `npm run build:client`。
- 变异门槛必须在隔离副本里跑（默认并行 gate 自动建副本）；`--mode fast` 退出码恒非 0，fast 通过 ≠ gate 通过。
- 「未应用」比「幸存」更隐蔽（pitfalls §1.4）：变异的 `from` 必须照**编译产物**的真实形状写。
- 编辑期间只跑受影响测试文件；`typecheck / test / mutation` 留到本轮收尾跑一次（AGENTS.md 完成定义）。
- 每条结论标证据等级（实测 / 源码核对 file:line / 猜测）。

## Review Focus

规格未明说、但使用者会撞上的四类输入，各由 Task 3 与 Task 5 的测试钉住：

1. **原型链上的端点名**：`dispatch('constructor', {})` 与 `dispatch('toString', {})` 必须回 `unknown-endpoint`，不能取到 `Object.prototype` 上的函数当 handler 调用（用 `Object.hasOwn` 判存在）。
2. **非字符串端点名**：HTTP 壳已把 `body.endpoint` 走 `String(...)`（index.ts:349），但直接调 `dispatch` 的调用方可能传 `undefined`/`null`；查表先判类型，失败路径回 `unknown-endpoint` 而非抛 TypeError。
3. **未就绪与未知端点的优先级**：`not-ready` 必须**先于** `unknown-endpoint`（保持今天 :166 → :469 的顺序；存储没起来时任何名字都回 not-ready）。
4. **`carriesAccount` 合并处抛错**：合并发生在 handler 的 `ok` 之后、try 之内，异常必须落回 `internal` 信封，不得泄出 `dispatch`。

5. **五个端点在端点层零覆盖**（实测 2026-10-15，grep 全部 27 个测试文件）：`toggleStar`、`opmlExport`、`opmlImport`、`addFeed`、`removeFeed` 的测试驱动次数**均为 0**（`tests/opml.test.mjs` 只测 `parseOpml`/`buildOpml` 纯函数，不经端点；变异清单里这 5 个的命中数也是 0）。⇒ 对它们，「行为一字不差」**没有既有测试作判据**，必须按 Task 4 Step 1b 先立金标准再搬。

---

### Task 1: 名字单一来源 —— `ENDPOINT_NAMES` 与派生联合类型

**Files:**
- Modify: `src/shared.ts:19-21`（14 名字的联合类型 → 常量数组 + 派生）
- Test: `tests/endpoint-registry.test.mjs`（本任务只加名字集合一条）

**Interfaces:**
- Produces: `export const ENDPOINT_NAMES: readonly Endpoint[]`（14 个，顺序照现行联合类型）· `export type Endpoint = (typeof ENDPOINT_NAMES)[number]`
- Consumes: 无

- [ ] **Step 1: 写失败测试**（新建 `tests/endpoint-registry.test.mjs`）

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { ENDPOINT_NAMES } from '../lib/shared.js'

test('端点名字表非空、无重复、全为非空字符串', () => {
  assert.equal(ENDPOINT_NAMES.length, 14)
  assert.equal(new Set(ENDPOINT_NAMES).size, 14)
  for (const name of ENDPOINT_NAMES) assert.equal(typeof name, 'string')
})
```

- [ ] **Step 2: 跑测试确认失败** —— Run: `npm run build && node --test tests/endpoint-registry.test.mjs`；Expected: FAIL（`ENDPOINT_NAMES` 未导出）

- [ ] **Step 3: 改 `src/shared.ts:19-21`**：把三行联合类型换成常量数组 + 派生类型（数组字面量加 `as const`，类型写 `(typeof ENDPOINT_NAMES)[number]`），并在同处补一句注释说明「运行时名字表是表完整性测试与未知端点排查的前提」。

- [ ] **Step 4: 跑测试确认通过** —— Run: `npm run build && node --test tests/endpoint-registry.test.mjs`；Expected: PASS

- [ ] **Step 5: 提交** —— `git add src/shared.ts tests/endpoint-registry.test.mjs`（**本仓库禁止自动 commit，等用户确认后再执行**）

---

### Task 2: 注册表骨架 —— `EndpointSpec` 与 `carriesAccount` 声明

**Files:**
- Modify: `src/endpoints.ts:31` 上方（加类型与表声明）
- Test: `tests/endpoint-registry.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `Endpoint` / `ENDPOINT_NAMES`
- Produces:

```ts
export interface EndpointCtx {
  readonly store: ReaderStore      // 同一次请求内由 deps.ready() 解析（不要存成字段：换代后悬垂）
  readonly config: Config
  readonly log: (message: string) => void
  readonly refreshNow: (options?: { force?: boolean; signal?: AbortSignal }) => Promise<boolean>
  readonly lastRefreshCompletedAt: () => number | undefined
  readonly articleAttempts: Map<string, number>
}
export interface EndpointSpec {
  /** 该端点回包是否必须并入未读账（分发层统一 append，handler 不自己拼） */
  readonly carriesAccount?: true
  readonly to: (payload: unknown, ctx: EndpointCtx) => Promise<RpcResult<unknown>>
}
```

- [ ] **Step 1: 写失败测试**（同文件追加）

```js
test('注册表覆盖全部端点名字，不多不少', async () => {
  const { ENDPOINTS } = await import('../lib/endpoints.js')
  const { ENDPOINT_NAMES } = await import('../lib/shared.js')
  assert.deepEqual(Object.keys(ENDPOINTS).sort(), [...ENDPOINT_NAMES].sort())
})
```

- [ ] **Step 2: 跑测试确认失败** —— Expected: FAIL（`ENDPOINTS` 未导出）

- [ ] **Step 3: 在 `src/endpoints.ts` 声明 `export const ENDPOINTS: Record<Endpoint, EndpointSpec>`**，14 个 key 逐个列出、`to` 先写成占位实现（`async () => fail('internal', '未实现')`）。穷尽性由 `Record<Endpoint, …>` 保证：少一个 key 编译不过。

- [ ] **Step 4: 跑测试确认通过**（本文件通过；既有测试此时会红，Task 4 修）—— Run: `npm run build && node --test tests/endpoint-registry.test.mjs`；Expected: 本文件 PASS

- [ ] **Step 5: 提交**（等用户确认）

---

### Task 3: 分发核 —— 守卫、查表、信封、`carriesAccount` 合并

**Files:**
- Modify: `src/endpoints.ts:163-479`（`dispatch` 主体）
- Test: `tests/endpoint-registry.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `ENDPOINTS` / `EndpointSpec` / `EndpointCtx`
- Produces: `createDispatch(deps: EndpointDeps): (endpoint: string, payload: unknown) => Promise<RpcResult<unknown>>`（**外部签名一字不改**；14 处调用点零改动）

- [ ] **Step 1: 写失败测试**（钉 Review Focus 四条；**并先在本文件定义测试帮助函数**）

  本测试文件自带两个帮助件（后续 Task 4/5 也复用，不要各自重造）：

  ```js
  const FEED_ID = 'https://feed0.example.com/atom.xml'
  const ITEM_ID = 'item-0001'

  /**
   * 装配一个真实 createDispatch。
   * 覆盖项：ready(就绪与否) · seed(预置订阅源) · items(预置条目 id)。
   * 默认走真实 createSqliteStore（临时目录 + writeConfigFile），照 tests/overview-paging.test.mjs:20-31 的装配风格。
   */
  function makeDispatch(overrides = {}) { /* 建临时库 → createSqliteStore → createDispatch(deps) */ }
  ```

  `makeDispatch` 的 deps 形状照 `tests/overview-paging.test.mjs` 的 `deps(store, config)`：`{ config, log, ready, refreshNow, lastRefreshCompletedAt, articleAttempts }`。`ready` 与 `refreshNow` 是最常被 overrides 的两个（前者造 not-ready，后者避免出网）。

```js
test('unknown-endpoint：原型链上的名字与空名字都拒绝', async () => {
  const dispatch = makeDispatch()      // 装配风格照 tests/overview-paging.test.mjs 的 deps 桩
  for (const name of ['constructor', 'toString', '__proto__', '']) {
    const r = await dispatch(name, {})
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'unknown-endpoint')
  }
})

test('not-ready 先于 unknown-endpoint', async () => {
  const dispatch = makeDispatch({ ready: () => undefined })
  for (const name of ['overview', 'constructor', '不存在的名字']) {
    const r = await dispatch(name, {})
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'not-ready')
  }
})
```

- [ ] **Step 2: 跑测试确认失败** —— Expected: FAIL（`constructor` 会命中 `Object.prototype`）

- [ ] **Step 3: 实现分发核** —— 四步固定顺序：① `const target = ready(); if (!target) return fail('not-ready', '存储域尚未就绪，稍后重试')` ② `typeof endpoint === 'string' && Object.hasOwn(ENDPOINTS, endpoint)` 不成立则 `fail('unknown-endpoint', '未知端点：' + endpoint)` ③ 组 `ctx` 后 `await spec.to(payload, ctx)` ④ 若 `spec.carriesAccount === true && result.ok`，则并入 `accountOf(target)` 后返回。整段包在既有的 `try/catch → fail('internal', …)` 里。

- [ ] **Step 4: 跑测试确认通过** —— Expected: PASS

- [ ] **Step 5: 提交**（等用户确认）

---

### Task 4: 14 个 handler 逐条搬入（含 `carriesAccount` 声明与错误码原样）

**Files:**
- Modify: `src/endpoints.ts` 全部 14 个 `case` → 表项（case 内注释随体搬运——注释是本地知识）
- Test: 全量 `npm test`（判据是「行为一字不差」）

**Interfaces:** Consumes Task 2/3 的类型与 ctx；Produces 无新接口

必须原样保住的线格（源码核对）：

| 端点 | carriesAccount | 必须原样保住的失败码与文案 |
|---|---|---|
| overview | – | `bad-request`：cursor 必须是字符串 / 未知的续页游标（格式应为 "<recency>|<id>"）： |
| refresh | – | 无（refreshNow 的返回决定 refreshed） |
| markRead | ✅ | `bad-request`：markRead 需要 itemIds 数组 |
| unmarkRead | ✅ | `bad-request`：unmarkRead 需要 itemIds 数组 |
| toggleStar | ✅（保留：死重量，见「不做」） | `bad-request` / `not-found`：toggleStar 需要 itemId / 条目不存在： |
| toggleKeepUnread | ✅（保留） | 同上形态 |
| article | – | `bad-request`（article 需要 itemId / 该条目没有可抓取的链接）/ `not-found` / `cooldown` |
| cleanup | ✅ | 无 |
| opmlExport | – | 无 |
| opmlImport | – | `bad-request`：opmlImport 需要 opml 文本 |
| addFeed | – | 无（失败走进 ok 的 failed 数组） |
| removeFeed | – | `bad-request`：removeFeed 需要 url / `not-found`：订阅不存在： |
| viewPreferences | – | 无 |
| saveViewPreferences | – | 无（认不出就回落默认，绝不抛错） |

- [ ] **Step 1: 搬前基线** —— Run: `npm run build && npm test`；Expected: 全绿（记录基线）

- [ ] **Step 1b: 为 5 个零覆盖端点先立金标准**（**必须搬运前做**，否则搬完无法证明行为未变）

  在 `tests/endpoint-registry.test.mjs` 里，用 Task 3 的 `makeDispatch` 装配，对这 5 个端点各写一条「搬运前行为」的断言，**先在旧实现上跑绿**（记录回包形状），搬运后再跑同一条：

  ```js
  test('金标准：opmlExport 回包形状', async () => {
    const dispatch = makeDispatch({ seed: [FEED_ID] })
    const r = await dispatch('opmlExport', {})
    assert.equal(r.ok, true)
    // 记录实测形状：{ opml: <string 含 xmlUrl>, feedCount: 1 }
    assert.equal(r.value.feedCount, 1)
    assert.match(r.value.opml, /xmlUrl/)
  })
  test('金标准：addFeed / removeFeed 的失败码与文案', async () => {
    const dispatch = makeDispatch()
    assert.equal((await dispatch('removeFeed', {})).error.code, 'bad-request')
    assert.match((await dispatch('removeFeed', {})).error.message, /removeFeed 需要 url/)
    assert.match((await dispatch('removeFeed', { url: 'https://nope.example/x.xml' })).error.message, /订阅不存在：/)
  })
  test('金标准：toggleStar 回包含 starred', async () => {
    const dispatch = makeDispatch({ seed: [FEED_ID], items: [ITEM_ID] })
    const r = await dispatch('toggleStar', { itemId: ITEM_ID })
    assert.equal(r.ok, true); assert.equal(r.value.starred, true)
  })
  ```

  `opmlImport` 的金标准需要真实 OPML 文本（照 `tests/opml.test.mjs` 的 fixture 形状内联一小段）与可注入的 `validateSubscriptions`——若 deps 无法注入校验器（校验在 `src/subscribe.ts` 里直接调用），**就退一步**：只钉「空文本 → bad-request」与「解析出 0 订阅 → added:0/existed:0」两条不会出网的路径，并在计划执行记录里写明「联网校验路径本轮无金标准，搬运按代码对读保形」。

  Run: `npm run build && node --test tests/endpoint-registry.test.mjs`；Expected: 新增用例 **在旧实现上全部 PASS**（这是金标准的定义：先证明它能抓住旧行为）

- [ ] **Step 2: 逐端点搬运（14 次编辑，每次一个端点）**；编辑后跑该端点的既有 judge：markRead/unmarkRead → `node --test tests/unread-accounting.test.mjs tests/endpoints-perfeed-unread.test.mjs`；overview/游标 → `node --test tests/overview-paging.test.mjs tests/perf/overview-scale.test.mjs`；article → `node --test tests/article-markread-race.test.mjs`；opml/订阅（**端点层零覆盖**，判据 = Step 1b 金标准）→ `node --test tests/endpoint-registry.test.mjs tests/opml.test.mjs tests/subscribe.test.mjs`；toggleStar/toggleKeepUnread/cleanup → `node --test tests/store-sqlite.test.mjs`。

  handler 内把闭包变量换成 ctx：`target` → `ctx.store`、`config` → `ctx.config`、`log` → `ctx.log`、`articleAttempts` → `ctx.articleAttempts`、`lastRefreshCompletedAt` → `ctx.lastRefreshCompletedAt`。**已带账目合并的 5 个 case 改为只返回 ok({...})，账目由分发层按声明注入。**

- [ ] **Step 3: 全量复测** —— Run: `npm run build && npm test`；Expected: 与 Step 1 基线一致

- [ ] **Step 4: 交接级验证** —— Run: `npm run typecheck`；Expected: host + client 两工程 0 错误

- [ ] **Step 5: 提交**（等用户确认）

---

### Task 5: 客户端接缝收紧 —— `callRpc` 收 `Endpoint`

**Files:**
- Modify: `src/client/store.ts:142`（`endpoint: string` → `endpoint: Endpoint`；加 type-only import）
- Test: `tests/client-bundle.test.mjs`（产物过期守护）+ 全量

**Interfaces:** Consumes Task 1 的 `Endpoint`；Produces 无（16 个调用点传的已是字面量，零改写）

- [ ] **Step 1: 加守卫测试**（钉「端点名字面量不再散落在组件里」）

```js
test('端点名字面量不许出现在客户端组件里', () => {
  const src = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  const hits = [...src.matchAll(/'(overview|refresh|markRead|unmarkRead|toggleStar|toggleKeepUnread|article|cleanup|opmlExport|opmlImport|addFeed|removeFeed|viewPreferences|saveViewPreferences)'/g)]
  assert.deepEqual(hits, [])
})
```

- [ ] **Step 2: 跑测试** —— Run: `node --test tests/client-bundle.test.mjs`；Expected: 已无字面量则 PASS（守卫性测试，允许首跑即绿；若 FAIL 则先清理该字面量）

- [ ] **Step 3: 改 `src/client/store.ts:142`**：加 `import type { Endpoint } from '../shared.js'` 并把签名改成 `async function callRpc<T>(endpoint: Endpoint, payload?: unknown): Promise<T>`

- [ ] **Step 4: 构建 + 全量复测** —— Run: `npm run build && npm run build:client && npm test`；Expected: 全绿

- [ ] **Step 5: 提交**（等用户确认）

---

### Task 6: 清 `src/index.ts` 的 8 个死 import

**Files:**
- Modify: `src/index.ts:29-31,40`（**只删 import 名字，不改任何行为**）
- Test: `npm run typecheck`（tsconfig 未开 noUnusedLocals，这是唯一判据）

实测（2026-10-15 复核）：以下 8 个名字在 `src/index.ts` 全文件各出现 **1 次**（即只在 import 行）；文件内 **0 处** `await import()`：
`blocksToText`、`fetchArticle`、`buildOpml`、`parseOpml`、`validateSubscriptions`、`Endpoint`、`ItemView`、`Overview`。
（走读报告称 9 个，实测 8 个；本会话一度误称其中 5 个是懒加载使用——复核为误，无动态 import。）

- [ ] **Step 1: 复核** —— Run: `grep -c "await import(" src/index.ts`；Expected: `0`
- [ ] **Step 2: 删这 8 个名字（保留同行其它名字）**
- [ ] **Step 3: 验证** —— Run: `npm run build && npm run typecheck`；Expected: 0 错误
- [ ] **Step 4: 回归** —— Run: `npm test`；Expected: 全绿
- [ ] **Step 5: 提交**（等用户确认）

---

### Task 7: 变异条目 —— 重对准 2 条 + 新增 2 条

**Files:**
- Modify: `scripts/mutation-test.mjs:559`（`endpoints-标读回包不带每源账目`）、`:911`（`paging-端点不拒绝坏游标`）——新锚串
- Modify: 同文件新增两条

必断的 2 条（`from` 串含缩进/换行/下一个 case 标签，搬运后必然失配）——**先 grep 新产物再写 from**（pitfalls §1.4）：

- [ ] **Step 1: 看新产物形状** —— Run: `npm run build && grep -n "accountOf(target)" lib/endpoints.js`
- [ ] **Step 2: 重对准 2 条** —— `:559` 锚到「分发层合并账目」的实现点；`:911` 锚到 `decodeCursor` 的判定点；`to` 保持「退回病灶」语义不变
- [ ] **Step 3: 新增 2 条**（各含 judges）

```js
{ id: 'endpoint-表漏掉一个端点', file: 'lib/endpoints.js',
  judges: ['endpoint-registry.test.mjs'],
  from: "'toggleStar':", to: "'toggleStar_removed':" },
{ id: 'endpoint-未就绪守卫被绕过', file: 'lib/endpoints.js',
  judges: ['endpoint-registry.test.mjs'],
  from: "if (!target) return fail('not-ready'", to: "if (false) return fail('not-ready'" },
```

（`from` 仅为示意：Step 1 的产物 grep 结果决定最终字面量——**照实写，不要照抄本行**；写错形状的后果是「未应用」，比幸存更隐蔽。）

- [ ] **Step 4: 内环快速验证**（不是判据）—— Run: `npm run mutation -- --mode fast`；Expected: 报出每条是「抓到」而非「未应用」；**--mode fast 退出码恒非 0**
- [ ] **Step 5: 提交**（等用户确认）

---

### Task 8: 收尾验证（一轮跑一次）

**Files:** 无改动（纯验收）

- [ ] **Step 1: 四条门槛按序**

```bash
npm run build
npm run build:client      # 动过 src/client/store.ts
npm run typecheck         # host + client，0 错误
npm test                  # 全绿
npm run mutation          # gate：每条被抓到、0 幸存、0 未应用
```

Expected: 全部通过；mutation 输出 **0 幸存且 0 未应用**（只跑 `--mode fast` 不算通过）

- [ ] **Step 2: 真机三步**（AGENTS.md:38-43）

1. `dev_reload_package` 前后都应为 `[active]`
2. 看**今天**的 `$DSH_HOME/storages/rss-reader/reader-$(date -u +%F).log` 无「装载失败」
3. `curl -X POST http://127.0.0.1:3080/rss-reader-api -d '{"endpoint":"overview","payload":{}}'` 得 **401**（路由活着；未带浏览器鉴权正是期望结果）

- [ ] **Step 3: 报告结果并等用户确认提交**（仓库禁止自动 commit）

---

## 不做（本轮明确排除）

- **`toggleStar` / `toggleKeepUnread` 回包里的死重量账目**：客户端不消费（store.ts:521/:539 不接返回值），本轮只改结构不改协议 ⇒ 记 follow-up。
- **引入 zod**：新增依赖 + 供应链审查成本，收益只是少写几行解析 ⇒ 不做。
- **`Endpoint` 收成 branded type / 运行时校验**：无第二适配器需求 ⇒ YAGNI。
- **`unknown-endpoint` 文案变更**：现在零测试钉它 ⇒ 保持原样。
- **H2/H3/H4/H5/C1–C5**：本次只做 H1。

## 验收（Definition of Done）

按 AGENTS.md 完成定义：四条门槛全过 + 真机三步通过 + 变异 **0 幸存 / 0 未应用**。改了关键判定 ⇒ 同轮补变异（Task 7 的两条新增）。

## 证据等级说明

- **实测**：本会话对报告抽取的 7 项抽查（构造器重复断言、teardown 假宿主、createStore 生产零调用、桩拷贝走样、props 桥接、effect 区域、8 个死 import 的出现次数）。
- **源码核对（file:line）**：本计划所有 `file:line` 引证。
- **已撤回**：2026-10-15 曾据 grep 截断输出判定「Endpoint 类型漂移 8 vs 14」——实测为 **14 个名字、与 dispatch 的 14 个 case 同步**，无漂移；该判断已撤回并就地更正 HTML 报告（修正版见临时目录 `*-corrected.html`）。
