# H2 生命周期 module —— 独立评审报告与修复轮

> 独立评审（子代理 ffccc574，Multi-Model Review 的 Model B）2026-10-15 · 评审对象 = **工作树**（分支 `refactor/lifecycle-module`，BASE `246633d`，未提交）。
> 评审全程只读：实验都在 `/tmp/h2-work` 与 `/tmp/h2-v-*` 隔离副本里做，真实 checkout 的 `git status` 前后逐字相同。
> 复现材料：`.superpowers/sdd/2026-10-15-lifecycle-module/review-material.patch`（diff + 4 个新文件 + 计划），基线产物编译在 `/tmp/h2-base/lib/index.js` 供逐行对读。

## 评审结论

**Verdict：Request changes**（修复轮已完成，见下）。

- **搬运本身正确**：评审对基线产物与新产物做了去注释归一后逐行 diff，**七条顺序约束全部逐行未变** —— 打开序列 9 步、守卫在建 store 之前、守卫抛错自己关库、cancelled 关库并 return、refreshSignal 三态、refreshNow 五分支顺序、stop 的 abort→等落定→关→清信号。只有 4 处无行为改写（`controller.signal`→`generationSignal`、`cancelled=true` 的位置、幂等门、日志措辞）。
- **四条门槛在评审处独立全过**：build / build:client / typecheck 0 错误 / 393/393 / mutation gate 142/142 · 0 幸存 · 恢复后基线仍然绿。
- **6 条新判据全是行为级**，无一条读 .ts 断言源码文本（`AGENTS.md:50` 未重犯）。
- **安全 / 性能两轴无问题**：无新输入面、无新依赖、无密钥、无 SQL 拼接、无新增热路径开销。
- **架构收敛真实发生**：`createLifecycle` 与 ctx 零耦合；`index.ts` 确实只剩宿主接线。

## 拦住合并的发现（唯一一条）

**「每条约束各有一条测试」这句写进代码的验收标准（`lifecycle.ts:11-19`）对 8 条变异不成立** —— 把判定取反后跑全套 393 条，下列全部保持绿：

| # | 变异 | 缺的是哪条判据 |
|---|---|---|
| ① | `if (!options.force && lastCompletedAt !== undefined` → `if (false && …` | refreshNow 节流 |
| ② | 同上 → `if (true && …` | 节流恒触发 |
| ③ | `lastRefreshCompletedAt = Date.now()` → 空操作 | 成功发起就盖完成时间戳 |
| ④ | `if (cancelled) {` → `if (false) {` | 取消后继续装载并交出 store |
| ⑤ | stop 里 `if (database) {` → `if (false) {` | **永不关句柄** |
| ⑥ | `AbortSignal.any([own, generationSignal])` → `return own` | refreshSignal 第三态 |
| ⑦ | `generationSignal = undefined` 去掉 | **信号没清**（注释写着它防「插件重载后再也不刷新」） |
| ⑧ | 装载时 `if (config.logFile === '')` → `if (false)` | 装载时清超期日志 |

**归因要分清**：这 8 条的代码在基线 `lib/index.js` 里是同一份，多数属**既有缺口，不是 H2 引入**。但 H2 的验收标准写了「每条约束各有一条测试」，且 ⑤⑦ 属于**句柄释放**这一层（本仓库记过事故：2026-10-13 真机 `database is not open`，静默宕机 7 小时）。

**对照实验**（证明判据确实存在，不是全都不敏感）：`stop: 不等在途刷新就关库`、`stop: 不 abort`、`ready: 忽略 cancelled`、`stop: 重复 stop 抛错`、`start: 重复 start 不幂等`、`refreshNow: 去掉 ready 门`、`守卫完全不调用` —— 这 7 条都被抓到。

## 修复轮（父会话执行）

### 独立复现（不只采信）
隔离副本里跑 4 条变异（节流恒不触发 / cancelled 分支失效 / 不清信号 / stop 不关句柄）⇒ **全部 41/41 绿**；对照组「stop 不 abort」⇒ fail 1。评审的发现**成立**。

### 已修

| 项 | 处理 | 证据 |
|---|---|---|
| 缺口 ①（节流无判据） | 补「节流往返」用例：第二轮被拦 + 断言「刷新被节流」留痕 | **反事实验证**：把判据改成 `if (false && …` ⇒ 该用例 fail 1（补之前全绿） |
| 必修 3（死 import `dailyLogPath`） | 删（`lifecycle.ts:22`） | typecheck 干净 |
| 必修 4（`until()` 死 helper） | 删（`tests/lifecycle.test.mjs:44`） | 全套绿 |
| 必修 5（`summarize` 可选） | 改**必填** | 改后 :145 漏传立刻运行时抛 `deps.summarize is not a function` —— 正是「响亮失败」的效果，已补 |
| Consider 6（`createHttpHandler` 收下未用的 `log`） | 删参数 + 同步两处调用 | 全套绿 |

### 试过补但**结构上打不到**，已撤判据、保留代码

缺口 ④（`if (cancelled)` 关库）与缺口 ⑦（清信号）**试过两种判据形态，全部打不到**：

- ④ 试过「取消后 `ready()` 是 undefined」⇒ `ready()` 本就因 `cancelled=true` 返回 undefined，**与该分支无关**；其真正后果（句柄释放）属 macOS 不可观测那一族（删文件不因句柄失败、重开同名库不立刻撞 BUSY）。
- ⑦ 试过「stop 后再建一代 lifecycle 能正常抓」⇒ **结构上不可能**：`start` 的 `started` 一次性、`stopped` 不可逆，同一对象无法重启；新建对象与上一代信号无关。
- 而它们真正的可观测后果只在「取消与关闭交错」的时序里，**本平台无法制造那个时序**。

⇒ 代码里的两处**保留**（删了是真 bug），补的两条判据**撤回**（留着给人虚假的安全感）。代价：将来这两处被改坏时本平台无人喊；缓解是测试文件里写明了「为什么它没有判据」。

### 修复后验证

- `npm run build` / `build:client` exit 0 · `npm run typecheck` 0 错误
- `npm test` → **394/394**（评审时的 393 + 新增的节流往返）
- `npm run mutation`（gate）→ **应用 142/142 · 幸存 0 · 恢复后基线仍然绿**
- 真机三步：`dev_reload_package` 前后均 `[active]` · `curl` → **401** · 今日日志「装载失败」0 ·「database is not open」0

## 评审「拒绝判断」的 5 项（交人工裁决）

1. **`summarize` 该必填还是可选** —— **父会话已按此方向改成必填**（评审与作者一致）。
2. **index.ts 行数验收标准改口径**（总行数 → 实际代码行数）：评审独立算出总 146 / 注释 55 / **代码 80 行**，与作者的「97 行」口径不同但同结论；「事故注释不计入」是口味判断，该不该写进项目规则待定。
3. **重复 stop 分支那个多余 `await`** 该不该删 —— 评审建议**不改**（删了要重新验证 e2e 竞态，且它实践上无害）。
4. **真机三步** —— 评审无法验也不认为需要它验。
5. **那 8 条存活变异该补几条进门槛** —— 取决于对门槛噪声的容忍度（`scripts/mutation-test.mjs:20-25` 明确反对等价变异入门槛制造「狼来了」）。

## 评审顺带给父会话的两条实验方法（值得留存）

1. **批量变异实验必须先跑未变异副本当基线闸**：`fs.cpSync` 不带 `preserveTimestamps` 会刷新所有文件 mtime，`tests/client-bundle.test.mjs:265` 的「产物不能过期」判据在每个副本里恒红，于是**每一条变异都变成假 KILLED**（评审第一轮 16 条全报 KILLED，全是假的）。
2. **评审脚本不要与 gate 抢同一份 `lib/`**：评审第一次跑 gate 得到「恢复后基线没恢复干净」，原因就是自己的脚本在原地改 `lib/`；单独复跑即「仍然绿」。

## 对作者自陈四条的独立复核

| 作者自陈 | 评审结论 |
|---|---|
| `signalFactory` → `controllerFactory` | 判断对（`AbortSignal` 没有 abort 权限） |
| 删 `fetchImpl` | 判断对（`refreshFeeds` 自己抓，没有注入点消费它） |
| 撤回「守卫抛错不自己关库」那条变异 | **复核成立**：评审用修正后的锚串重跑，全套 393 也绿，macOS 确实不可观测；且它**没找到**别的判据形态（fd 计数在测试进程里拿不到别的进程句柄） |
| index.ts 145 行的验收标准修改 | 成立（同量级同结论） |

## 变更面

- `src/index.ts`：**490 → 144 行**（代码 80 行 + 注释 55 行，评审独立统计）
- `src/lifecycle.ts`（新，305 行）：`createLifecycle` —— 与 ctx 零耦合
- `src/endpoints.ts` +65：`createHttpHandler`
- `src/storage/log-file.ts` +58：`createLogger`
- 测试：`tests/lifecycle.test.mjs`(199) · `tests/http-route.test.mjs`(93) · `tests/apply-sync.test.mjs`(70) · `tests/teardown-race.test.mjs`(170，假宿主全清)
- 变异：重锚 3 条 + 新增 2 条 + `FILE_PREFIXES` 补 `lib/lifecycle.js`
