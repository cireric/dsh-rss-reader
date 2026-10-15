# 变异测试提速实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 变异门槛整轮从 ~15min 压到 ≤3min：分层 timing gate + 并行 worker + judges 反查；gate 永远权威、fast 纯建议。

**Architecture:** 三条杠杆按序叠加。①把 `tests/article-perf.test.mjs` 的 7 条墙钟测试搬进 `tests/perf/`——`npm test` 的通配符扩成两个 glob 照常全量收编，而变异 runner 只对 `tests/*.test.mjs` 跑 ⇒ timing gate 移出内环（解锁 K=6 并行，实测 0 假红）。②`scripts/mutation-test.mjs` 重构为函数化 + CLI（`--mode / --workers / --dump-judges / --mutations`），worker 各持一份 `os.tmpdir()` 隔离副本并行跑一部分变异，MUTATIONS 表与崩溃分类器逐字保留。③gate 全量轮回收「每条变异翻红的测试文件」→ 人工收敛 → 内联进每条变异的 `judges` 字段，fast 模式只跑 judges 并集。退出码契约写死：只有 gate 干净才 exit 0。

**Tech Stack:** Node.js ≥22（worker_threads、node:test），无新依赖。

**Spec:** docs/mutation-test-speedup-plan.md（已拍板定稿；本计划按其 §4 杠杆 0/A/B、§5 实施顺序、§6-§8 边界与未决项实施。executor 两份都要读。）

## Global Constraints

- 门槛安全基线（spec §0）：gate 永远权威、fast 纯建议、退出码契约写死（fast 通过 ≠ gate 通过）。
- 不删测试、不放宽断言（AGENTS.md 硬约束）：article-perf 的 7 条测试**原文搬移**（唯一改动 import 路径），断言与预算值（BUDGET_MS=300 / 1s）逐字保留。
- 崩溃分类器与「未应用」计数（scripts/mutation-test.mjs:965-1023 含三坑注释）不得削弱，gate / fast / worker 三条路径共用同一份实现。
- 不变量 gateRed(m) ⊆ judges(m)（spec §5）：由构造满足——judges 快照采自 gate 全量轮的实测翻红；人工收敛只删「整体崩掉」的连带文件，不许删「断言真的看见缺陷」的文件。
- 每条变异的 from/to **本计划一律不改**（照编译产物形状、OCCURRENCES=1，docs/pitfalls.md 一、1.4）。
- 变异门槛只在隔离副本里跑（docs/pitfalls.md §1.3 实测事故：源目录改 lib/ = 热载进运行中的插件）；副本由 runner 在 `os.tmpdir()` 自建并自动清理，只拷 `lib/ tests/ scripts/ package.json`，不拷 `node_modules .git .worktrees`。
- 禁止 `as any` / 空 catch；worker 内任何抛错必须记入结果（status 'crashed' + message），不许静默退出。
- 注释与 commit message 写中文、写「为什么」；commit 结构 = 病象 → 根因 → 修法 → 证据；**不自动 push**，改完等用户确认。
- 本计划不改 `src/**` ⇒ lib/ 产物不变，无需真机三步（dev_reload_package / 日志 / 401 探针）。

## Review Focus

规格隐含、但没有任何任务的功能测试覆盖、最可能咬到使用者的五个失效面（每一行都在归属任务里以探针步骤钉住）：

1. **对正在运行的插件写 lib/**：任何模式（gate/fast/worker）在源目录改 lib/ 都是把带变异的代码热载进运行中的插件（pitfalls §1.3）。→ Task 2 探针：跑完 gate 后 `git status --short lib/` 必须干净。
2. **fast 的假「抓到」**：judges 是快照，测试文件改名/删除后 fast 会把「没翻红」静默记成「抓到」。→ Task 5 探针：judges 指向不存在文件 ⇒ 计「未应用」入失败清单、exit 4，绝不静默跳过。
3. **退出码契约被绕过**：`--mode fast` 即使全部「抓到」也必须非 0；只有 gate 干净才 0。→ Task 5 探针：全抓到的 fast 轮 exit 3。
4. **worker 结果串扰**：多个 worker 共享临时目录名会互相覆盖副本（老并发反例「同副本互相污染」）。→ Task 2：workerRoot 用 `mkdtempSync` 保证唯一 + 轮收尾清理干净。
5. **gate 汇总吞掉 worker 失败**：某个 worker 对某条变异抛错却没记入结果 ⇒ 那条无结论仍 exit 0。→ Task 2 探针：伪造不存在目标文件的变异 ⇒ 该条计失败、整体 exit 1。

---

### Task 1: 分层 article-perf（timing gate 移出变异内环）

**Files:**
- Create: `tests/perf/article-perf.test.mjs`（原文搬移自 `tests/article-perf.test.mjs`）
- Delete: `tests/article-perf.test.mjs`
- Modify: `package.json:34`（test script）

**Interfaces:**
- Consumes: 无（首任务）。
- Produces: `npm test` = `node --test tests/*.test.mjs tests/perf/*.test.mjs`（全量不变）；变异内环口径 = 仅 `tests/*.test.mjs`（不再含 timing gate）——Task 2 的 suiteGlob 依赖它。

- [ ] **Step 1: 原文搬移**

`mkdir -p tests/perf`；把 `tests/article-perf.test.mjs` 全文复制为 `tests/perf/article-perf.test.mjs`，唯一改动：第 13 行 `import { extractArticle } from '../lib/article.js'` → `'../../lib/article.js'`。载荷表、BUDGET_MS、断言逐字不动。

- [ ] **Step 2: 扩 npm test 通配符**

`package.json` 的 test script 改为：`"test": "node --test tests/*.test.mjs tests/perf/*.test.mjs"`。

- [ ] **Step 3: 删旧文件**

`git rm tests/article-perf.test.mjs`（搬移，不是删测试——7 条用例一条不少）。

- [ ] **Step 4: 验证 npm test 全量不变**

Run: `npm test 2>&1 | tail -4`
Expected: 全绿，且 perf 的 7 条「抽取规模闸门」用例在输出里（总数与搬移前相同）。

- [ ] **Step 5: 验证内环口径**

Run: `node --test tests/*.test.mjs 2>&1 | grep -c "抽取规模闸门"; echo exit=$?`
Expected: 计数 0（timing gate 已不在变异 runner 的 suite glob 里）。
Run: `grep -rn "article-perf" tests scripts package.json`
Expected: 无代码引用残留（spec §9 的复现命令属文档，不在此列）。

- [ ] **Step 6: Commit**

`git add -A && git commit -m "test: 分层 article-perf——timing gate 移出变异内环（杠杆 0）"`

### Task 2: runner 函数化 + 并行 worker（--mode gate 为默认）

**Files:**
- Modify: `scripts/mutation-test.mjs`（函数化 + CLI + worker 池；MUTATIONS 表 :22-926 与崩溃分类器 :1009-1023 **逐字保留**）
- Test: `tests/mutation-runner.test.mjs`（新建，静态冒烟）

**Interfaces:**
- Consumes: Task 1（内环 = `tests/*.test.mjs`，无 timing gate ⇒ K=6 可并行，实测 0 假红）。
- Produces: CLI `node scripts/mutation-test.mjs [--mode gate|fast] [--workers N] [--dump-judges <file>] [--mutations id1,id2]`，默认 gate；模块函数 `parseArgs / runSuite(root) / applyMutation(root, m) / classify(out, m) / collectResults(results, MUTATIONS) / partitionMutations(mutations, n) / buildWorkerScript(workerRoot, mutations, suiteGlob)`——Task 3/5 复用同名函数。

- [ ] **Step 1: 写失败测试**

`tests/mutation-runner.test.mjs`（静态冒烟——runner 是带副作用的 CLI 脚本，无法 import，故钉源码结构锚点；这是它常驻内环的理由）：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const src = readFileSync('scripts/mutation-test.mjs', 'utf8')
test('runner 已函数化且走 worker_threads', () => {
  for (const anchor of ["import { Worker } from 'node:worker_threads'", 'function parseArgs(', 'function runSuite(', 'function applyMutation(', 'function classify(', 'function collectResults(', 'function partitionMutations(', 'function buildWorkerScript(']) assert.ok(src.includes(anchor), '缺锚点: ' + anchor)
})
test('隔离副本只拷必要目录、不拷 node_modules/.git/.worktrees', () => {
  assert.ok(src.includes("mkdtempSync(") && src.includes(".worktrees"))
})
```

- [ ] **Step 2: 跑测试验证失败**

Run: `node --test tests/mutation-runner.test.mjs` — Expected: FAIL（锚点尚未存在）。

- [ ] **Step 3: 函数化重构（行为不变）**

骨架（注释「…」= 现文件原样搬，包括所有 ⚠️ 注释）：

```js
import { Worker } from 'node:worker_threads'
import os from 'node:os'
import path from 'node:path'
import { cpSync, rmSync, mkdtempSync } from 'node:fs'

function parseArgs(argv) // → { mode='gate', workers=Math.min(8, Math.max(1, os.cpus().length - 2)), dumpJudges, only }
const MUTATIONS = [ /* :22-926 逐字保留 */ ]
function runSuite(root)   // 现 :928-935 原样，cwd 换成参数 root
function applyMutation(root, m) // 现 :953-963 的写入/复原子逻辑；返回 { ok, out }
function classify(out, m) // 现 :1009-1018 原样（含三坑注释），返回 'crashed' | 'caught' | 'survived'
function collectResults(results, MUTATIONS) // 现 :1032-1040 原样（applied/survivors/after/exit 码）
function partitionMutations(mutations, n)   // 见 Step 4
function buildWorkerScript(workerRoot, mutations, suiteGlob) // 见 Step 4 契约
async function main() { /* Step 5 */ }
main().then(() => process.exit(process.exitCode ?? 0))
```

- [ ] **Step 4: 分桶与 worker 契约**

分桶（同文件变异分散到不同 worker，client.js 的 50 条是墙钟大头，实测 6.35s/轮）：

```js
// 大头在前：同文件条目经排序后轮转均分 ⇒ 任何单 worker 都不会独吞整个 client 族
const FILE_PREFIXES = ['lib/client.js', 'lib/store-sqlite.js', 'lib/refresh.js', 'lib/keys.js',
  'lib/retention.js', 'lib/store.js', 'lib/endpoints.js', 'lib/identity-repair.js',
  'lib/feed/', 'lib/storage/', 'lib/article.js', 'lib/list-scroll.js', 'lib/index.js',
  'lib/domain.js', 'lib/shared.js', 'lib/subscribe.js', 'lib/config.js']  // 覆盖全部 138 条
function partitionMutations(mutations, n) {
  const sorted = [...mutations].sort((a, b) => rank(a.file) - rank(b.file))  // rank = FILE_PREFIXES 首个前缀命中序
  return Array.from({ length: n }, () => []).map((b, i) => sorted.filter((_, j) => j % n === i))
}
```

worker 契约（实现进 buildWorkerScript 的模板串）：入参 `{ root, suiteGlob, mutations: [{ id, file, from, to }] }`；逐条 apply → runSuite → classify，输出 JSON lines `{ id, status: 'crashed'|'caught'|'survived'|'unapplied', fails }`；apply/runSuite 抛错 ⇒ status 'crashed' + message，**不得吞掉**；worker 进程不许静默退出。主进程侧：workerRoot = `mkdtempSync(path.join(os.tmpdir(), 'mutation-gate-'))` 下每 worker 一个子目录；cpSync 白名单 `lib/ tests/ scripts/ package.json`（显式排除 node_modules / .git / .worktrees——worktree 里整份检出副本，拷了既慢又可能级联）；rmSync 清理放 finally。

- [ ] **Step 5: gate 主流程**

baseline 一次（源目录，只读跑）→ parseArgs → partition → 每 worker 一个 `new Worker(...)` 跑生成的脚本，串行消化分到的变异 → 收集 JSON lines → `--dump-judges` 留待 Task 3 → collectResults → finally 清理副本。

- [ ] **Step 6: 跑测试与全量 gate 验证**

Run: `npm test 2>&1 | tail -3` — Expected: 全绿（新冒烟测试过）。
Run: `time node scripts/mutation-test.mjs --mode gate --workers 6` — Expected: `应用 138/138 · 幸存 0`、exit 0；记录墙钟（推算 ≈1-2min，落地实测值写进 commit message）。
Run: `git status --short lib/` — Expected: 空（Review Focus #1）。

- [ ] **Step 7: 探针——不吞 worker 失败与副本唯一性**

临时在 MUTATIONS 末尾加 `{ id: 'probe-文件不存在', file: 'lib/nope.js', from: 'x', to: 'y' }`，跑 `node scripts/mutation-test.mjs --mode gate --workers 2` — Expected: 该条计失败（崩了/未应用）、exit 1，其余 138 条照常（Review Focus #5）。还原探针。
再跑一轮确认 `os.tmpdir()` 下无 mutation-gate-* 残留（Review Focus #4）。

- [ ] **Step 8: Commit**

```bash
git add scripts/mutation-test.mjs tests/mutation-runner.test.mjs
git commit -m "perf: 变异门槛并行化——worker 隔离副本池（杠杆 B），gate 默认模式"
```

### Task 3: --dump-judges（gate 轮回收 judges 快照）

**Files:**
- Modify: `scripts/mutation-test.mjs`
- Modify: `package.json`（scripts 加 `"mutation:calibrate": "node scripts/mutation-test.mjs --mode gate --dump-judges docs/superpowers/plans/2026-10-15-judges-dump.json"`）
- Create: `docs/superpowers/plans/2026-10-15-judges-dump.json`（生成物，含人工批注区）

**Interfaces:**
- Consumes: Task 2 的 classify/collectResults 与 gate 全量轮。
- Produces: 快照格式 `{ generatedAt, suiteGlob: "tests/*.test.mjs", mutations: { <id>: { file, judges: string[] } } }`（judges = 翻红 ✖ 行里的 tests 基名去重排序，只记 caught 条目）；`function judgesFromFails(fails)`——Task 5 消费同一函数。

- [ ] **Step 1: 写失败测试**

`tests/mutation-runner.test.mjs` 追加断言：源码含 `function judgesFromFails` 与 `'--dump-judges'`。Run → FAIL。

- [ ] **Step 2: 实现 dump**

`judgesFromFails(fails)`：从 ✖ 行提取 `tests/<name>.test.mjs` 基名，去重排序。gate 主流程在 `--dump-judges <file>` 时把每条 caught 变异的 judges 写成上述快照（crashed/unapplied/survived 不进快照——它们本来就令 gate exit 1）。

- [ ] **Step 3: 校准跑（用并行 gate，把校准从 14.6min 压到 ~3min）**

Run: `npm run mutation:calibrate`
Expected: gate 全绿 exit 0 + 快照文件生成；`node -e "const d=require('./docs/superpowers/plans/2026-10-15-judges-dump.json'); console.log(Object.keys(d.mutations).length)"` = 138 且每条 judges 非空。记录墙钟。

- [ ] **Step 4: 人工收敛（原文契约，spec §5）**

Run: `node -e "const d=require('./docs/superpowers/plans/2026-10-15-judges-dump.json'); for (const [id,m] of Object.entries(d.mutations)) if (m.judges.length>6) console.log(id, m.file, m.judges.join(','))"`
对超 6 个文件的条目逐条核对：剔除「模块整体崩掉」的连带文件（崩溃族特征：同一批文件在多条变异里反复出现）；「断言真的看见缺陷」的文件**一个都不许删**。逐族裁决（示例锚点：retention 三条 → store-sqlite + overview-scale；paging 族 → overview-paging + nav-selection + client-bundle）记入快照顶层 `"_notes"` 字段。拿不准的条目标 `"needs-recheck": true` 并在下一步 gate 复跑确认。

- [ ] **Step 5: Commit**

`git add -A && git commit -m "feat: --dump-judges——gate 轮回收 judges 快照（杠杆 A 前置）"`

### Task 4: 回填 judges（内联进 MUTATIONS）

**Files:**
- Modify: `scripts/mutation-test.mjs`（MUTATIONS 各条加 `judges: [...]`）

**Interfaces:**
- Consumes: Task 3 快照（含 _notes 终值）。
- Produces: 每条变异对象带 `judges: string[]`（tests 文件基名数组）——Task 5 fast 消费。

- [ ] **Step 1: 转档回填**

把快照中每条变异收敛后的 judges 作为 `judges: ['refresh.test.mjs', …]` 写进对应条目（同族同锚的可共享同一数组字面量）。这是**转档不是重新判定**——判断自由度已在 Task 3 的 _notes 锁死。

- [ ] **Step 2: 覆盖核对**

Run: `grep -c "judges: \[" scripts/mutation-test.mjs`
Expected: = 138（少一条即有条目漏填；`--mode fast` 遇缺 judges 的条目会按「未应用」计失败兜底，Task 5）。

- [ ] **Step 3: Commit**

`git commit -am "feat: MUTATIONS 内联 judges 快照（回填自 judges-dump）"`

### Task 5: fast 模式 + 退出码契约

**Files:**
- Modify: `scripts/mutation-test.mjs`
- Test: `tests/mutation-runner.test.mjs`（追加契约断言）

**Interfaces:**
- Consumes: Task 4 的 `judges` 字段；Task 2 的 runSuite/applyMutation/classify。
- Produces: 退出码契约——gate 干净=0、gate 有幸存/崩了/未应用=1、基线红=2（现有）、**fast 一律非 0（全抓到=3、有任何非 caught=4）**；fast 逐条打印「哪个 judge 翻红」。

- [ ] **Step 1: 写失败测试**

`tests/mutation-runner.test.mjs` 追加：源码含 `"mode === 'fast' ? 3 : 1"` 与 `'只跑 judges 并集'`（或实现采用的同一句中文注释锚）。Run → FAIL。

- [ ] **Step 2: 实现 fast**

无 worker；逐条变异：`judges` 并集展开成文件路径列表（缺字段或文件不存在 ⇒ 记「未应用」入失败清单，绝不静默跳过——Review Focus #2）→ runSuite 只跑这些文件（runSuite 加可选 files 参数，`node --test <files…>`）→ classify → 打印 `id · 被 <judge> 翻红（N 条）`。退出码在**一个出口点**统一返回：gate 0/1/2，fast 3/4。

- [ ] **Step 3: 跑测试**

Run: `npm test 2>&1 | tail -3` — Expected: 全绿。

- [ ] **Step 4: 抽样核对（fast 与 gate 结论一致，spec §5 验收命令）**

Run: `node scripts/mutation-test.mjs --mode fast --mutations refresh-陈旧度排序倒退,store-版本握手失效,log-文件名判据放宽成前缀匹配,client-A 的范围阈值过滤,client-1 键切展开视图,teardown-不等在途刷新就关库`
Expected: 6 条全部「被抓到」、翻红断言数 ≥1（host 3 + client 3，覆盖 SQL/键盘/日志/teardown 四族）、exit 3。

- [ ] **Step 5: 契约探针**

Run: `node scripts/mutation-test.mjs --mode fast; echo exit=$?` — Expected: exit 3（全抓到也非 0，Review Focus #3）。
Run: `node scripts/mutation-test.mjs --mode gate --workers 6; echo exit=$?` — Expected: exit 0。

- [ ] **Step 6: Commit**

`git commit -am "feat: --mode fast——judges 反查内环（杠杆 A），退出码契约写死"`

### Task 6: 文档联动与收尾复测

**Files:**
- Modify: `AGENTS.md:29`、`README.md:26-36`（开发段）、`docs/mutation-test-speedup-plan.md:103-108`（§8 销账）

**Interfaces:**
- Consumes: Task 1-5 全部落地。
- Produces: 文档与实测数字一致。

- [ ] **Step 1: AGENTS.md 完成定义**

`:29` 的 `npm run mutation` 注释追加：`（默认并行 gate；--mode fast 仅内环建议，退出码恒非 0——fast 通过 ≠ gate 通过）`。

- [ ] **Step 2: README 开发段**

`npm run mutation` 行注释改为「变异门槛：默认并行 gate（整轮 ≤3min 量级，K 按核数）；`--mode fast` 是内环建议、退出码恒非 0」；补一行 `npm run mutation:calibrate`（judges 快照刷新入口，spec §7 回滚路径）。

- [ ] **Step 3: spec §8 待复测销账（全部标实测并填数字）**

①gate 整轮墙钟与假红率（Task 2/3 的 time 输出，K 实取值）；②5× 墙钟比（对照 14.6min 基线）；③内环单条 fast 耗时（Task 5 抽样 6 条的耗时汇总 vs 189ms 推算）。写回 spec §8，逐条把「待落地复测」改为实测值；对不上的写对不上和原因，不硬凑。

- [ ] **Step 4: 收尾验证轮（AGENTS.md 完成定义，全量按序）**

`npm run build && npm run typecheck && npm test && node scripts/mutation-test.mjs --mode gate --workers 6`
Expected: build exit 0 / typecheck 0 错误 / test 全绿 / gate `应用 138/138 · 幸存 0` exit 0。（未动 src/**，build 应为无操作级；真机三步不适用。）

- [ ] **Step 5: Commit**

`git commit -am "docs: 变异提速落地——完成定义与 README 联动，复测数字销账"`

---

## 验收总表（对 spec §5）

| spec 验收 | 本计划位置 |
|---|---|
| 1 分层 article-perf：npm test 全绿；K=6 0 假红 | Task 1（Step 4/5）+ Task 2（Step 6 gate 全轮 0 崩 0 未应用） |
| 2 方案 2 并行：gate 复跑 0 幸存 / 0 崩 / 0 未应用、exit 0 | Task 2（Step 6/7） |
| 3 方案 1：judges 快照 → 收敛 → fast/gate | Task 3/4/5（Step 4 抽样 = spec 验收命令） |
| 4 退出码契约 + 文档联动 | Task 5（Step 5）+ Task 6 |

## 自审记录

- **覆盖**：spec §4 杠杆 0/A/B ↔ Task 1/3-5/2；§5 四行 ↔ 任务映射见上表；§6 边界（分类器保留、fast 继承、gateRed⊆judges）→ 全局约束；§7 漂移兜底（gate 权威 + fast 退出码 + AGENTS.md）→ Task 5/6；§8 未决 → Task 2/3 实测 + Task 6 销账。
- **不变量方向**：judges 快照采自 gate 实测翻红 ⇒ gateRed ⊆ judges 由构造成立；人工收敛只删连带文件，抽样核对兜底转档误差。
- **Review Focus 钉扎**：五条各落到 Task 2（#1 #4 #5）与 Task 5（#2 #3）的探针步骤。
- **比例**：计划只写签名/契约/探针与锚点，MUTATIONS 表与分类器标注「逐字保留」不复写；唯一成块新代码 = 冒烟测试、分桶函数、worker 契约，均为签名与测试定不了的算法/协议。
- **明确不做**：不建主动漂移检测（spec §7）；不动 `src/**`；不删不弱化任何测试；不自动 push。
