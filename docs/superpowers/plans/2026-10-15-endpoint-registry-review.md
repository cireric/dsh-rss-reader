## H1 端点注册表 —— 终审报告与 follow-up 输入

> 独立评审（只读子代理）2026-10-15 · 评审对象 = 提交 `c901727`（工作树评审，基线 6cf2c83）
> 本文件替代执行期工作区（`.superpowers/sdd/2026-10-15-endpoint-registry/`，gitignored、已按流程删除）。

## 结论

**无 Critical。** 重构站得住：外部签名一字未改、14 个 handler 体逐行等价（LCS 逐行对读，代码级差异 **0/14**）、
17 条 `fail(...)` 集合逐一相等、5 个 `carriesAccount` 标记不多不少、5 个端点回包与基线产物**逐字节等同**。
四条门槛评审独立复跑全过。

## 三项独立验证（评审实测）

1. **原型链 + 非函数 spec**：`Object.hasOwn` 对 `constructor`/`toString`/`__proto__`/`valueOf`/`hasOwnProperty`/`''` 全部回
   `unknown-endpoint`；且对「经原型继承的同名键」返回 false（`Object.create({overview})` 探针）⇒ 判据真的挡住原型链。
   表项 `.to` 非函数时也落在 `internal` 信封内、有 `log` 落痕。
2. **回包形状**：把**基线 6cf2c83 编译成产物**与重构后产物跑同一夹具、比对全信封 ⇒ markRead / unmarkRead /
   toggleStar / toggleKeepUnread / cleanup **IDENTICAL**（cleanup 冻结 Date.now 后逐字节相同）。
3. **5 条变异锚串**：逐字符计数（`indexOf` 非正则）+ 真跑 `replace` ⇒ 全部 occ=1、全部真的改到产物；
   旧锚确实已消失（旧产物 `...accountOf(target)`=5 / `target.updateItem(...articleFailure`=1 / 游标 guard 缩进=20；
   新产物 0 / 0 / 12）⇒ 不重锚必为「未应用」。gate 单跑 5 条 + 全量 140 条均 0 幸存。

## 修复轮（3 条 Important，全部先 RED 后 GREEN）

| # | 发现 | 处理与证据 |
|---|---|---|
| I1 | `toggleStar` / `toggleKeepUnread` 的 `carriesAccount` 标记**无任何判据**——评审在隔离副本删掉它们跑全量：**375 条全绿** | 已修。加两条守卫（静态「标记集合恰好是那 5 个」+ 动态「每个标记端点走成功路径都带回未读账」）。**反事实 RED**：删掉 toggleStar 标记 ⇒ 2 条当场翻红；恢复 ⇒ 13/13 绿 |
| I2 | 新测试断言 `callRpc(endpoint: Endpoint` 的**源码文本**，违反 AGENTS.md:50（测试钉行为不钉实现） | 已修。删除该断言（类型层归 `npm run typecheck`），保留「组件不许绕过 store 直调 callRpc / 直 fetch ROUTE_PATH」那条真实失效面守卫 |
| I3 | 计划 Task 4 Step 1b 要求的披露缺失 | 已修。补录「**联网校验路径本轮无金标准，搬运按代码对读保形**」，并写明保形依据（行级对读）与未做项 |

修复后完整验证：build exit 0 · build:client exit 0（328.96 kB）· typecheck 0 错误 · **npm test 376/376** ·
**mutation gate 应用 140/140 · 幸存 0 · 恢复后基线仍绿** · 真机三步（复跑取证）：`dev_reload_package` 前后均 `[active]`、
今天日志「装载失败」= 0、`curl` → 401。

## Deferred minors（7 条，未进修复轮，待人工裁决）

| # | 内容 | 位置 |
|---|---|---|
| M1 | 变异注释里的缩进事实错误：实测 20→12、24→16，注释把两行混成一个数 | `scripts/mutation-test.mjs:922` |
| M2 | `applyMutation` 不校验 `from` 唯一性；两条既有变异 occ=2 只改第一处（`list-scroll-夹取保护`、`client-折叠时左栏仍渲染`）——均**非本轮引入**，当前仍被抓到 | `scripts/mutation-test.mjs`（`applyMutation`） |
| M3 | `Symbol` / 抛异常的 `toString` 使异常从 catch 里泄出 dispatch（`unknown-endpoint` 拼接 + catch 内 `log` 拼接各一次）——**pre-existing**，HTTP 壳不可达（壳走 `String(...)`） | `src/endpoints.ts`（unknown-endpoint 分支 + catch） |
| M4 | 「27 个测试文件」计数不准：基线实测 29、当前 30 | 测试文件头注释 + 计划 Review Focus 5 |
| M5 | 两处死 import：`sanitizeViewPreferences`（endpoints.ts）、`ROUTE_PATH`（client/index.tsx）——均 pre-existing | 同左 |
| M6 | 计划自身计数偏差：「14 处调用点」实为 13（=1 定义+13 调用）；Task 5「16 个 callRpc」实为 17 | 计划文件 |
| M7 | 评审「拒绝判断」的第 6 项：`EndpointSpec` 单方法接口是否算过度抽象（取决于是否预期第二实现） | `src/endpoints.ts` |

**M2 值得单开一轮**：它防的是整族「变异只改第一处」的隐蔽失效（与「未应用」同级），改法是一行——`applyMutation` 里
校验 `original.split(from).length === 2`，否则记 unapplied。

## 执行期 Ruling（9 条，摘要）

- Task 2/3/4 **合并交付**（占位 handler 会让既有测试全红，与 task-done 契约冲突）；代价 = 无法分开审「建表」与「搬 handler」，评审用行级对读补上（0/14）。
- **金标准先行**于结构改动（旧实现还在场才能立）。
- `EndpointCtx` **补回 `ready()`**：只给 `store` 会把 teardown 竞态从「回空列表」变成「抛错→internal」，是行为变更（评审确认防住了真实回归）。
- Task 5 守卫测试改写（计划原写法在 index.tsx 命中 8 处必然误报：`store.load('overview'|'refresh')` 合法、`'article'` 是视图名）。
- Task 6 多删一个死 import（`recencyOf`，计划列 8 实测 9）。
- **变异实际断 3 条**，计划预见 2 条：第三条 `article-用旧快照整体写回覆盖并发写入` 的 from 串含闭包变量 `target`，重构后被 `ctx.store` 取代。
- 全程未 commit 由用户授权后一次性提交；终审包用工作树 diff（无 commit ⇒ HEAD==MERGE_BASE）。

## 对后续架构轮的输入

- 评审确认 H1 已消除 **Repeated Switches**（14 臂 switch → 注册表）并显著改善 **Shotgun Surgery**（加端点：3 处 → 2 处）。
- 仍在的 **Divergent Change**：`src/endpoints.ts` 承载 14 个 handler、14 个理由改同一文件 —— 这是 H2 之外的一个自然入口（表可按域拆）。
- `EndpointCtx` 7 字段、`String((payload as {...})?.x ?? '')` 解析惯用法重复 6 次：**刻意保留**（计划明确「不引入 zod」）。
