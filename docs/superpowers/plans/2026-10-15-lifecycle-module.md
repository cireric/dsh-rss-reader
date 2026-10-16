# 装载/会话 module 实施计划（H2 · 2026-10-15）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (``- [ ]``) syntax for tracking.

**Goal:** 把 `src/index.ts` 里那条没有 Interface 的生命周期（打开→刷新→关停）沉成一个深 module，让「装配 + 同步登记」成为 index.ts 唯一的职责，测试不必再造宿主。

**Architecture:** 新增 `src/lifecycle.ts`（与 ctx 无关，暴露 `start()`/`stop()`/`ready()`/`refreshNow()`）；HTTP 传输壳 `readJsonBody` + 准入 + 信封移进 `src/endpoints.ts` 的 `createHttpHandler`；日志策略抽成 `storage/log-file.ts` 的 `createLogger`。index.ts 收敛到只剩 schema 导出、`inject` 声明、配置解析、同步登记两个 effect、把 `dispatch` 与 `session` 接线（估 80–110 行）。

**Tech Stack:** Node ESM + TypeScript（`strict: true`，无 `as any`/`@ts-ignore`）· tsc → `lib/` · node:test · 自研变异门槛 `scripts/mutation-test.mjs`

**Spec:** 本计划的规格 = 2026-10-15 架构体检的 H2 卡 + 会话内第一轮 grilling 的 7 项裁决（Q1–Q7 全部「按推荐」）。仓库无 `docs/adr/`、无 `GLOSSARY.md`。

## Global Constraints

- 客户端 bundle 不许引第三方库（本轮不动 client）。
- `strict: true`；禁 `as any` / `@ts-ignore` / `@ts-expect-error`。
- 测试 import `../lib/…`（**构建产物**）：改完源码必须先 `npm run build` 再测。
- `apply` 必须**同步**，且所有 `ctx.effect` 必须在同步段登记完 —— await 过再注册会抛 `cannot create effect on inactive context`（index.ts:127-130，2026-10-08 实测）。
- teardown 的 `abort → 等落定 → close` **顺序不能换**（index.ts:445-484，2026-10-13 真机事故：`database is not open`）。
- 打开序列 `ensureStorageRoot → prune → openDatabase → migrateSchema → assertSubscriptionsNotLost → createSqliteStore → seed → repairIdentities → refreshOnStart` **顺序不能换**（index.ts:379-381 与 store-sqlite.ts:385 的构造器握手是两份）。
- 本仓库**禁自动 commit**：每个任务的提交步骤都留给你确认。
- 注释与 commit message 写中文，写「为什么」不写「做了什么」；每条结论标证据等级。

## Review Focus

规格与既有测试都沉默、但使用者会撞上的输入类，各由 Task 4 与 Task 6 的测试钉住：

1. **start 期间 teardown**：`ensureStorageRoot` 之后、`migrateSchema` 之前的瞬间调用 stop —— 句柄尚未登记，stop 不得关掉一个没登记的 db，也不得让它泄漏。
2. **两次 start**：同一 session 上重复 start 应当是响亮失败还是幂等？当前代码里 effect 只注册一次，测试直接驱动 session 会把这个歧义暴露出来。
3. **stop 期间 start**：teardown 未落定时又收到 refresh —— `refreshNow` 必须因 `ready()` 返回 undefined 而直接 false，而不是拿一个正在关的 store。
4. **stop 两次**：teardown 被调用两次（effect 重放、异常路径重入）—— 第二次必须是安全的空操作，不得抛。
5. **abort 无效果时的有界等待**：若 abort 没让 fetch 收束，`Promise.all([generation, inFlight])` 会不会无界？（现状：每个抓取带 `AbortSignal.timeout`，有界；本轮不能把这个保证弄丢。）
6. **日志落在同步段**：首条「配置未经解析」日志发生在 `ensureStorageRoot` **之前** —— logger 落点若要求存储根已建，这条会失败或把目录权限悄悄放宽到 umask 默认。

---

### Task 1: `createLogger` —— 日志三条判定有了可直测的 Interface

**Files:**
- Modify: `src/storage/log-file.ts`（**新增** `createLogger`，不动既有两个纯函数）
- Test: `tests/log-file.test.mjs`（既有）+ 新增用例

**Interfaces:**
- Consumes: `dailyLogPath`（同文件既有）、`logFile: string`（空串 = 按天默认）、`storagesRoot: string`
- Produces: `export function createLogger(opts: { logFile: string; storagesRoot: string; sink?: (line: string) => void }): (message: string) => void`

必须逐条搬过去的行为（源码核对 index.ts:100-125）：

| 行为 | 原位置 | 搬后判据 |
|---|---|---|
| 时钟只取一次（行首时间戳与文件名同源） | :106 | 用例注入 `now`（可选 `clock`），断言跨 UTC 零点时行与文件名属同一天 |
| 双 sink：先 `ctx.logger.info(line)`，再落文件 | :108/:120 | sink 收到的那一行与文件里那一行**逐字相同** |
| 默认落点按当天现算 | :110 | `dailyLogPath` 不在构造时算 |
| 默认落点目录 0700；显式 `logFile` 只建目录不改权限 | :117-119 | 用例断言两种模式下的权限位 |
| 写失败要 `warn` 一次，且**不抛** | :121-124 | 让落点不可写 → 断言 sink 收到 warn、函数不抛 |

- [ ] **Step 1: 写失败测试**（追加到 `tests/log-file.test.mjs`）

```js
test('createLogger：行首时间戳与文件名归属同一天（时钟只取一次）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rss-log-clock-'))
  const written = []
  // 23:59:59.999Z 与 00:00:00.001Z 之间换天：两次取时钟就会跨文件
  const stamps = [new Date('2026-10-11T23:59:59.999Z'), new Date('2026-10-12T00:00:00.001Z')]
  let i = 0
  const log = createLogger({ logFile: '', storagesRoot: dir, clock: () => stamps[i++] })
  log('第一条')
  log('第二条')
  written.push(...readdirSync(dir).sort())
  assert.deepEqual(written, ['reader-2026-10-11.log', 'reader-2026-10-12.log'])
  assert.match(readFileSync(join(dir, 'reader-2026-10-11.log'), 'utf8'), /第一条/)
  assert.match(readFileSync(join(dir, 'reader-2026-10-12.log'), 'utf8'), /第二条/)
})
```

（另需三条：sink 与文件逐字相同 / 默认落点 0700 与显式落点不设权限 / 写失败只 warn 不抛。）

- [ ] **Step 2: 跑测试确认失败** —— Run: `npm run build && node --test tests/log-file.test.mjs`；Expected: FAIL（`createLogger` 未导出）
- [ ] **Step 3: 在 `src/storage/log-file.ts` 实现 `createLogger`** —— 逐条照上表搬；时钟取一次落局部变量；写失败走 `sink` 的 warn 分支（若未给 sink 则退回 `console.warn`，**不静默**）
- [ ] **Step 4: 跑测试确认通过** —— Expected: PASS
- [ ] **Step 5: 提交**（等用户确认）

---

### Task 2: HTTP 传输壳 → `createHttpHandler`

**Files:**
- Modify: `src/endpoints.ts`（**新增** `createHttpHandler`；`ENDPOINTS`/`createDispatch` 不动）
- Test: `tests/endpoints-perfeed-unread.test.mjs` 或新建 `tests/http-route.test.mjs`

**Interfaces:**
- Produces: `export function createHttpHandler(dispatch: (endpoint: string, payload: unknown) => Promise<RpcResult<unknown>>, opts: { requestRejection: (req) => number | undefined; log: (message: string) => void }): (req, res) => Promise<void>`

搬过去的行为（源码核对 index.ts:310-366）：`readJsonBody`（256 KiB 上限 → `bad-request`）· `requestRejection` 准入（401/403 文案逐字保留）· 非 POST → 405 · `dispatch(String(body?.endpoint ?? ''), body?.payload)` · catch → `fail('bad-request', …)` · 200 + `application/json; charset=utf-8`。

**刻意不进本 module**：路由**注册**（`ctx.webServer.register`）与「热重载撞 duplicate prefix 时响亮失败并给出恢复指引」那段（index.ts:353-362）——它依赖 ctx，留在 index.ts。

- [ ] **Step 1: 写失败测试**（新建 `tests/http-route.test.mjs`，真 `node:http` server，不造假宿主）

```js
test('HTTP 壳：无鉴权 401 · 非 POST 405 · 超大 body 走 bad-request 信封', async () => {
  const h = makeServer(createHttpHandler(fakeDispatch, { requestRejection: () => 401, log: () => {} }))
  // POST 无鉴权 → 401 + 'unauthorized'
  // GET → 405 + 'method not allowed'
  // POST body > 256 KiB → 200 + {"ok":false,"error":{"code":"bad-request",...}}
})
```

- [ ] **Step 2: 跑测试确认失败** —— Expected: FAIL（`createHttpHandler` 未导出）
- [ ] **Step 3: 实现 `createHttpHandler`**（逐条照上表搬，`readJsonBody` 一并进去）
- [ ] **Step 4: 跑测试确认通过** —— Expected: PASS
- [ ] **Step 5: 提交**（等用户确认）

---

### Task 3: `src/lifecycle.ts` —— 生命周期 module（打开/刷新/关停）

**Files:**
- Create: `src/lifecycle.ts`
- Modify: `src/index.ts`（删掉已搬走的部分，改为接线）
- Test: `tests/lifecycle.test.mjs`（新建，先钉 Review Focus 1–5）

**Interfaces:**
- Consumes: `Config`（index.ts 已解析好）、`createLogger` 的返回、`createSqliteStore`、`refreshFeeds`/`selectStalestFeeds`、`repairIdentities`、`normalizeFeedUrl`
- Produces:

```ts
export interface LifecycleDeps {
  readonly config: Config
  readonly storagesRoot: string
  readonly configFile: string
  readonly log: (message: string) => void
  /** 每代一个 controller；module 自己建，测试可传入以控制 abort 时机 */
  readonly signalFactory?: () => AbortSignal
}
export interface Lifecycle {
  /** 开始这一代的装载链（同步返回 promise，不阻塞登记） */
  start(): Promise<void>
  /** abort → 等落定 → 关句柄；重复调用是安全的空操作 */
  stop(): Promise<void>
  /** 未就绪或已关停时返回 undefined */
  ready(): ReaderStore | undefined
  /** 刷新全部源，受节流与在飞去重保护；返回「本次是否真的发起了抓取」 */
  refreshNow(options?: { force?: boolean; signal?: AbortSignal }): Promise<boolean>
  /** 上次刷新完成时刻（未完成过 = undefined）—— 端点的 refreshedAt 读它 */
  lastRefreshCompletedAt(): number | undefined
  /** 正文抓取尝试时刻（内存态，每代一份） */
  readonly articleAttempts: Map<string, number>
}
export function createLifecycle(deps: LifecycleDeps): Lifecycle
```

**必须逐条保持的语义**（源码核对 index.ts:131-152 / 170-304 / 377-488）：

1. 打开序列 9 步的**顺序**不变；`assertSubscriptionsNotLost` 必须在 `createSqliteStore` **之前**（index.ts:398-400 的理由：守卫抛错时这一代已半装好，`ready()` 会开始交出 store）。
2. 守卫抛错时**自己关 db**（此刻句柄尚未登记，teardown 关不到；不关 = 每次重载漏一个 SQLite 连接）。
3. `cancelled` 为真时建出来的库**立刻关掉并 return**（否则下次装载撞 SQLITE_BUSY）。
4. `refreshSignal(own)` 的三态不变：只有 `own` / 只有本代 / `AbortSignal.any([own, 本代])`（index.ts:243-246）。
5. `refreshNow`：`ready()` 拿不到就 false → 有 `inFlight` 就等它并 false → 非 force 且距上次不足就记节流日志并 false → 否则选 K 个最旧源抓一轮，**成功发起就盖 lastRefreshCompletedAt**（含全失败的轮次，index.ts:295-299 的理由）。
6. `stop()`：`cancelled = true` → abort → `await Promise.all([generation, inFlight])`（catch 里记日志、不抛）→ 关 database → 清 `generationSignal`。重复调用必须是空操作。
7. `ready()` = `cancelled ? undefined : store`。

- [ ] **Step 1: 写失败测试**（新建 `tests/lifecycle.test.mjs`，**不造假宿主**——直接 `createLifecycle` + 真实临时目录 + 真实 SQLite）

```js
test('Review Focus 1：start 期间 stop —— 不泄漏也不误关', async () => {
  const lc = createLifecycle({ config: Config({}), storagesRoot: dir, configFile: cfg, log: () => {} })
  const starting = lc.start()
  await lc.stop()                       // 刻意不等 start 落定
  await starting
  // 断言：start 落定后 ready() 是 undefined；再次 start+stop 不抛；库文件可删（没握着句柄）
})
```

（另需 Review Focus 2/3/4/5 各一条。）

- [ ] **Step 2: 跑测试确认失败** —— Expected: FAIL（`createLifecycle` 未导出）
- [ ] **Step 3: 建 `src/lifecycle.ts`，把 7 条语义逐条搬入**
- [ ] **Step 4: 跑测试确认通过** —— Expected: PASS
- [ ] **Step 5: 改 `src/index.ts` 为接线** —— 只留：`export { Config }` · `inject` · `Config(rawConfig)` 解析与「未经解析」告警 · `const log = createLogger(...)` · **同步** `ctx.effect(() => { ... })` 两条（路由壳用 `createHttpHandler`、生命周期用 `session.start()`/`session.stop()`）· `createDispatch` 与 `session` 的接线
- [ ] **Step 6: 跑测试确认既有测试仍绿** —— Run: `npm run build && npm test`；Expected: 全绿（3 个 import `lib/index.js` 的测试：refresh / storage-skeleton / teardown-race）
- [ ] **Step 7: 提交**（等用户确认）

---

### Task 4: 验收判据 —— teardown-race 不再造假宿主

**Files:**
- Modify: `tests/teardown-race.test.mjs`（155 行里 39 行假宿主 → 直驱 lifecycle）
- Test: 同上

**Interfaces:** Consumes: Task 3 的 `Lifecycle`；Produces: 无

**搬完的判据**：两条既有用例（:96 启动那轮 / :129 面板那轮）改由 `createLifecycle` + 真实 `http.Server` 驱动 —— 第二条仍需要一次真实 HTTP 调用来模拟面板点刷新，但**不再需要假 `ctx`**（`webServer.register` 抓 handler、`ctx.effect` 收 disposer、`process.env.DSH_HOME` 全去掉）。

- [ ] **Step 1: 先跑既有测试建立基线** —— Run: `npm run build && node --test tests/teardown-race.test.mjs`；Expected: 2/2 绿
- [ ] **Step 2: 改写为直驱 `createLifecycle`，删掉假 `ctx`**
- [ ] **Step 3: 跑测试** —— Expected: 2/2 绿（若「面板那轮」因缺 `requestRejection` 而行为变了，先核对 Task 2 的壳是否原样搬了准入）
- [ ] **Step 4: 提交**（等用户确认）

---

### Task 5: 变异条目 —— 1 条重锚 + 3 条新增

**Files:**
- Modify: `scripts/mutation-test.mjs`（`teardown-不等在途刷新就关库` :1085 重锚 + 新增 3 条）

**Interfaces:** Consumes: Task 3 的产物形状；Produces: 无

**必断的一条**（源码核对：它的 `file` 是 `lib/index.js`，而 `await Promise.all([generation, inFlight])` 会搬进 `lib/lifecycle.js`）—— **先 grep 新产物再写 from**（pitfalls §1.4）。另注：`FILE_PREFIXES`（:1159）需要补 `'lib/lifecycle.js'`，否则并行分组的"大头在前"排序失效。

新增三条，各钉一条本轮新增的判据：

```js
{ id: 'lifecycle-停止不等在途刷新就关库', file: 'lib/lifecycle.js', judges: ['teardown-race.test.mjs'], ... }  // 重锚自 teardown-不等在途刷新就关库
{ id: 'lifecycle-重复停止不安全', file: 'lib/lifecycle.js', judges: ['lifecycle.test.mjs'], ... }
{ id: 'lifecycle-停止后仍交出 store', file: 'lib/lifecycle.js', judges: ['lifecycle.test.mjs'], ... }
{ id: 'lifecycle-守卫抛错不自己关库', file: 'lib/lifecycle.js', judges: ['lifecycle.test.mjs'], ... }  // 堵「每次重载漏一个 SQLite 连接」
```

（`from`/`to` 必须在 Step 0 grep `lib/lifecycle.js` 后按真实形状写，**不得照抄本行**。）

- [ ] **Step 0: 看产物形状** —— Run: `npm run build && grep -n 'await Promise.all\|cancelled = true\|db.close' lib/lifecycle.js`
- [ ] **Step 1: 重锚 1 条**（照实写 from）
- [ ] **Step 2: 新增 3 条**（同上）
- [ ] **Step 3: `FILE_PREFIXES` 补 `'lib/lifecycle.js'`**
- [ ] **Step 4: 内环快验** —— Run: `npm run mutation -- --mode fast`；Expected: 每条报「被抓到」而非「未应用」（**退出码恒非 0，fast 通过 ≠ gate 通过**）
- [ ] **Step 5: 提交**（等用户确认）

---

### Task 6: 收尾验证（一轮跑一次）

**Files:** 无改动（纯验收）

- [ ] **Step 1: 四条门槛按序**

```bash
npm run build
npm run typecheck         # host + client，0 错误
npm test                  # 全绿
npm run mutation          # gate：每条被抓到、0 幸存、0 未应用
```

（`build:client` 本轮不需要——`src/client/**` 未动。）

- [ ] **Step 2: 真机三步**（AGENTS.md:38-43）

1. `dev_reload_package` 前后都应 `[active]`
2. 今天的 `$DSH_HOME/storages/rss-reader/reader-$(date -u +%F).log` 无「装载失败」
3. `curl -X POST http://127.0.0.1:3080/rss-reader-api -d '{"endpoint":"overview","payload":{}}'` 得 **401**

- [ ] **Step 3: 报告结果并等用户确认提交**（仓库禁自动 commit）

---

## 不做（本轮明确排除）

- **H3**（退役 `createStore` 旧 adapter + readerDomain + peerDependency）、**H4**（`saveFeed` 浅写法）、**H5**（按需正文 module）：按 Q6 排除，H1 的教训是不合并。
- **`endpoints.ts` 的 Divergent Change**（14 个 handler 挤一个文件）：评审指为「H2 之外的自然入口」，但那是**拆文件**方向，与本轮「加深生命周期」相反，单开一轮。
- **不引入 zod/任何新依赖**（H1 已记）。

## 验收（Definition of Done）

四条门槛全过 + 真机三步通过 + 变异 **0 幸存 / 0 未应用** + `src/index.ts` 收敛到 110 行以内（宿主接线该有的体积）+ teardown-race 不再造假宿主 + 「apply 同步 / effect 同步段登记」有测试钉住。

## 证据等级说明

- **源码核对（file:line）**：本计划所有 `file:line` 引证。
- **已撤回**：H1 期间我据 grep 截断输出误判「Endpoint 类型漂移 8 vs 14」并写进架构报告，逐行 read 后确认无漂移（实为 14 个名字）——教训已入 MEMORY，本轮所有「集合大小」结论均以 read 为准。
