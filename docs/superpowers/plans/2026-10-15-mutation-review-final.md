# Final Review — mutation-test-speedup（33f9a87..2ad99f3，7 commits）

评审人：Senior Code Reviewer（合并前终审）· 2026-10-15
方式：只读评审（git show/diff/log + 读文件 + 只读实测探针）；唯一写动作 = 本文件。
证据等级按仓库惯例标注：实测 / 源码核对（file:line）/ 猜测。

## 评审方法自述

- 全量 diff 通读：scripts/mutation-test.mjs（base 侧删除行 97 行逐条对过——分类器三坑注释、退出文案逐字随迁核实）、tests/mutation-runner.test.mjs、package.json、AGENTS.md、README.md、tests/article-perf.test.mjs（纯移动 + import 路径）、judges-dump.json。base..head 对 src/** 零改动（git diff --name-only 核实，实测）。
- 评审机复跑（全部实测）：
  - npm test：360/360 绿，9.2s（用户侧口径「355 用例」已过时，见 Minor M7 勘误）。
  - fast 单条（keys-r 归还刷新计数）：exit 3、被 keys.test.mjs 翻红（7 条）——退出码契约与 judges 反查实测工作。
  - --mutations '不存在的条目xyz'：exit 2。
  - gate 全量 K=8：3m34s 完成，但 17 条记「副本基线红」（worker_error）→ exit 1。注：该轮与评审者自己启动的 8×并发探针重叠（负载混淆，如实声明）。
  - 裸 8 并发全套件探针（spec §9 方法，无混淆）：2/8 轮翻红，唯一翻红测试 = overview-scale.test.mjs:107 的 100ms 墙钟预算（实测 111.4ms / 122.5ms 超预算）。
  - gate 全量 K=4（无任何并发探针的干净复跑）：**挂死 40+ 分钟**——两个 worker 的全套件进程停在 scroll-dom 子进程，35s 间隔双快照 mtime 零推进（实测）；挂点 = client.js 变异「Esc 不先关浮窗」（:636）与「helpOpen 不进依赖数组」（:647）。单变异+单文件的隔离复现不挂（6s 正常退出）⇒ 环境依赖型挂死；评审者已终止该复跑并清理其 /var/folders 副本残留。
  - 源 lib/ SHA256 前后对照：0 行差异（隔离副本不碰源树，实测复证）；os.tmpdir() 副本收尾清理正常（我 kill 的那轮除外，已手工清理）。

---

## Strengths（具体）

1. **崩溃分类器与 MUTATIONS 表逐字保真**（源码核对）：base 侧 :1009-1023 分类器及其三坑注释（\s+ 缩进、±6 行双窗、vm filename）在 head :1086-1102 原样随迁；138 条 from/to 与注释零改动（diff 通读 + inline judges 逐条 eval 比对 0 mismatch）。历史上真实踩过的三类假通过（ReferenceError 记抓到、vm 失明 50/138、缺展开运算符 91 连坐）全部仍被钉住。
2. **四态失败模型不存在假绿通道**（源码核对 + 实测）：survived/crashed/unapplied/worker_error 全部入失败清单 → exit 1（collectResults :1228-1253）；基线红 → exit 2（:1342-1347）；fast 恒非 0（exitCodeFor :1271-1273，实测单条 exit 3）；worker 崩溃 sweep（:1201-1211）把未回传结果全部记 crashed。评审机实测：worker_error 轮确实 exit 1 且逐条点名。
3. **隔离设计兑现承诺**（实测）：mkdtempSync 唯一副本（:1351）、变异只写副本（SHA 前后 0 diff）、finally rmSync（:1365-1367）、副本基线卫兵（:1177-1180）把「副本不忠实」从空洞 0 幸存变成响亮 exit 1——这正是 Task 5 发现 mtime 反超空洞判据后的正确加固，评审复跑验证卫兵真的会响。
4. **judges 机制端到端可信**（实测 + 源码核对）：judgesFromFails（:1109-1123）按实测 TAP 形状修过（✖ 行不印文件名 → ±6 行窗口）；漂移兜底（:1293-1298）对缺失/不存在 judges 计「未应用」绝不静默（Review Focus #2 逐字满足）；评审机 fast 单条点名 keys.test.mjs 翻红；union 24 文件全部存在于 tests/，27 个内环文件里 3 个永不做 judge 的名单合理（mutation-runner 冒烟自身、concurrency、opml——均无对应变异）。
5. **persist-global 14→2 的人工收敛有实质依据**（源码核对）：defineDomain 在 storage-domain 包 lib/index.js:74 对「接受 null 的 global schema」直接 throw（"null is the medium's never written sentinel"）⇒ 变异后 store 构造级联炸、全部翻红确非断言看见缺陷；保留的两条各有分工——domain.test.mjs 持有 rebuildItem 行为本体、nav-persistence.test.mjs:640 直接断言 safeParse(null).success === false（null 拒绝本体判据真实存在）。收敛正确。
6. **实测销账诚实**（源码核对）：spec §8 三个未达项（gate 3.9min vs 3min、内环单条 2.4s vs 1s、提速 3.7× vs 5×）逐条写明原因与口径修正，commit message 同步如实记录（2ad99f3、e1e5fcf 含「未做」与错误方向）；评审机 gate 墙钟 3m34s 与其 238.4s 实测同量级，数字可信。

## Issues

### Critical (Must Fix)

**C1. gate 无任何时限 ⇒ 套件挂死时整个门槛永久挂死（评审机实测发生一次）**
- file:line：scripts/mutation-test.mjs:1078（execSync 无 timeout）、:1197-1212（runWorker 无 deadline；sweep 只在 'error'/'exit' 事件触发，stall 什么都不触发）。
- 问题：每个 worker 的 node --test 套件（27 文件全量）无超时；worker 无总时长预算；gate 的全部判定打印压在收尾。任一套件在负载下卡死 ⇒ 该 worker 永不回传、永不 exit ⇒ Promise.all 永不 resolve ⇒ gate 无输出、无退出码、无诊断。实测：K=4 干净复跑（无并发探针）40+ 分钟零推进，两个 worker 停在同一族 client.js 变异（Esc/helpOpen——都翻红 scroll-dom）的套件上；单变异单文件隔离复现不挂 ⇒ 环境依赖型，但「无时限」是结构事实。
- 为什么重要：这是 AGENTS.md 完成定义的权威门槛。挂死形态比 exit 1 更坏——CI/本地全堵且零诊断（评审者正是靠 mtime 快照才定位的）；且挂死发生在评审机 = 它不是理论风险。
- 怎么修：① execSync 加 timeout（如 120_000）+ killSignal，超时记该变异 crashed「套件超时」（复用现有四态清单，exit 1）；② worker 加总时长预算（如 15min），超时 sweep 全部剩余变异记 worker_error（卫兵通道现成）；③（可选）基线或单条超时先重试一次再判死，避免大机器尖峰误杀。修 C1 时顺带把逐条完成即打印（worker message 到达就 flush）提上来——本次挂死 40 分钟零输出就是可观测性缺口的直接代价。

### Important (Should Fix)

**I1. 时序预算测试仍在变异内环 + 默认 K=8 超出 spec 自己验证过的安全包线 ⇒ gate exit 0 是负载敏感的**
- file:line：tests/overview-scale.test.mjs:107（10 万行 overview 测试）、:37（OVERVIEW_BUDGET_MS = 100）、:125（assert.ok(elapsedMs < 100)）；scripts/mutation-test.mjs:1215（默认 workers = min(8, cores-2)）。
- 问题：spec §3 实测「摘掉 article-perf 后全套件 × K=6，2 轮 0 假红」——安全包线是 K=6，且归因明确是「墙钟型断言在并发下误报」。杠杆 0 摘走了 article-perf，但 overview-scale:107 是同一形态的墙钟断言，留在了内环。评审机裸 8 并发探针（无混淆）2/8 轮翻红（111-122ms vs 100ms）；gate 默认 K=8 在 10 核机恰好越过 K=6 包线，每个 worker 的基线与每条变异套件都含这条 ⇒ 基线随机红 ⇒ 整桶 worker_error ⇒ exit 1（评审 K=8 轮 17 条 worker_error 即此形态，虽有我方探针负载混淆，但裸探针的红独立成立）。
- 为什么重要：执行者对「未决异常」的加固（preserveTimestamps + 基线卫兵）覆盖了 **mtime 形态**，没覆盖**时序形态**——这不是同一失效面。后果：gate 在拥挤机器上随机 exit 1，用户会学会忽略它，门槛退化成狼来了；这是把 Task 5 那次「空洞判据」教训换了种介质重演。
- 怎么修（推荐 ①）：① 把 overview-scale:107 的规模判据（② 墙钟）挪进 tests/perf/（与杠杆 0 同理：结构性判据 ①③④ 留内环、墙钟移出），内环从此无墙钟断言；或 ② 默认 K 上限降到 6 并在 spec/AGENTS 注明包线依据；或 ③ 基线红自动降 K 重试一次再判死。三者都应配一条「内环无 Date.now/hrtime 预算断言」的冒烟锚点防回潜。

**I2. runner 的承重判定全部没有行为级测试，只有字符串锚点**
- file:line：tests/mutation-runner.test.mjs:5-25（8 个锚点 + '? 3 : 4' 等形状断言）。
- 问题：exitCodeFor、judges 漂移计「未应用」（:1293-1298）、副本基线卫兵、classify 分类——四个承重判定只能靠「真跑一轮 4 分钟 gate」验证。计划 Task 2/5 的探针步骤（文件不存在 ⇒ 计失败 exit 1；judges 指向不存在文件 ⇒ 未应用）只执行过一次、未固化为测试。特别是 Review Focus #2 的漂移兜底，现在唯一的防线是源码里那 4 行。
- 为什么重要：这个 runner 本身已经是本仓库最关键的判据工具（AGENTS.md 完成定义第 4 条），它的回归会静默改变所有 138 条判据的含义。静态锚点对「实现被重写但行为保持」会误报、对「实现未变但行为漂移」漏报——两个方向都不对。
- 怎么修：把 parseArgs/exitCodeFor/judgesFromFails/classify 抽进可 import 的模块（脚本尾部 main() 之前 export，或拆 scripts/mutation-lib.mjs），冒烟测试直接断言返回值（classify 对伪造 TAP 的四态、judgesFromFails 对 ✖ 行形状、exitCodeFor 的四象限）；fast 的「不存在文件 ⇒ 未应用」加一条可复跑的探针测试（--mutations + 临时 dump 文件，或 runner 加 --self-test 旗标）。

### Minor (Nice to Have)

**M1. 冒烟测试名与实现矛盾**：tests/mutation-runner.test.mjs:8「隔离副本只拷必要目录、不拷 node_modules/.git/.worktrees」——实现 :1133 白名单**含** node_modules（pre-flight Ruling 的实测结论）。未来有人按测试名「修正」白名单会重新引入假红。改名 + 补一行为什么必须拷。
**M2. parseArgs 吞旗标**：scripts/mutation-test.mjs:1218-1222，--dump-judges --workers 2 会把 '--workers' 当文件名写快照；--mode --workers 2 同理（mode 非法 exit 2 兜底，dump 那个没有兜底）。修：下一参以 -- 开头时不吸收。
**M3. 裸 --dump-judges 默认写 CWD 的 judges-dump.json**（:1373）：仓库根易积未跟踪污染文件（.gitignore 未含）。建议裸旗标直接报错要求显式路径，或 .gitignore 补条目。
**M4. 尾部 process.exit 可能截断管道输出**（:1388）：piped stdout 异步 flush，幸存清单 stderr 有丢失风险（CI 里恰好是最不能丢的输出）。改为不显式 exit（让事件循环自然排空）或 process.stdout.on('drain') 后退。
**M5. 两个 commit 无正文**：446203f（杠杆 0）与 8760dfe（docs）违反仓库自己的 commit 结构约定（病象→根因→修法→证据）；docs commit 至少应写销账范围。
**M6. 入库的计划文档与实现不一致**：docs/superpowers/plans/2026-10-15-mutation-test-speedup.md:20（「只拷 lib/tests/scripts/package.json，不拷 node_modules」）与 :155（用 git status --short lib/ 验收——gitignored 恒空，执行者自己已判定无效并改用 SHA）。偏离在 ledger 有 Ruling 记录，但入库文本未加勘误行。补两行勘误，防未来照计划文档回滚。
**M7. 计数勘误**：用户提供的「npm test 355 用例全绿」实为 **360**（评审机实测 360/360；内环 27 文件为 353）。不影响任何结论，报告数字以 360 为准。

## Recommendations

1. **C1+I1 一个 follow-up 分支一起修**（预估半个会话）：execSync timeout + worker 预算 + 墙钟判据移 tests/perf/ + 内环「无墙钟断言」锚点。修完在评审机重跑一轮 K=8 gate 确认 0 worker_error。
2. **I2 的行为级测试**作为同分支第二任务：四个判定抽模块 + classify/judgesFromFails/exitCodeFor 单测 + fast 漂移探针固化。
3. **历史异常定性回填**：本次评审已把 calibrate2/3 绿 vs fast 红的未决观察定性为「overview-scale:107 墙钟断言的负载敏感」（机制同源：同一台机、同一族断言、负载在 100ms 刀口两侧）。建议在 spec §8 或 ledger 把「未决」改为「已定性（评审 2026-10-15）：时序形态，非 mtime 形态；I1 修复后销案」。注：calibrate2/3 的原始日志不在本 worktree，评审无法直接核对其 grep=0 主张，定性基于机制分析 + 本机复现，非对历史日志的复核（猜测成分：对历史两轮为何绿的解释；实测成分：本机 8 并发 2/8 红）。
4. **把 judges 人工收敛变成可审计动作**：14→2 的 _notes 这次是对的（机制依据充分），但「一次性人工裁决」不可复跑。建议 dump 后处理脚本（剔除「store 构造级联」类红可半自动：对同一变异翻红 ≥N 个文件的候选给出降级建议 + 人工确认）。
5. **138/138 历史证据的采信口径**：可信（判据链每条失败路径都导向 exit 1，执行者三轮独立跑 + 修复后 fast 138/138 + 评审机单条复现；gate 的证据没有「假绿」通道——与 mtime 修复前的本质区别）。注解：它证明的是「当时那台机、当时负载」下 138 条全部被抓；在 I1 修复前，把同一证据外推到拥挤机器不成立（会响亮地变成 exit 1，而不是假绿）。

## Declined to judge（已考虑但搁置，逐条附理由）

- buildWorkerScript 用 Function.toString 序列化的脆弱性（压缩/重命名/格式化）——分析后判定失败模式全部**响亮**：worker eval 失败 ⇒ 'error' 事件 ⇒ sweep ⇒ exit 1；模板内调用名与 const 声明失配 ⇒ per-mutation try/catch ⇒ crashed ⇒ exit 1；五函数刻意自包含（不引闭包外变量，连 root 都参数化），评审未找到静默失败形态。不入 issue。
- 静态冒烟钉源码锚点的取舍本身——锚点的误报/漏报问题归入 I2 统一处理，锚点存在性不单独判。
- judgesFromFails ±6 行窗口对 node:test reporter 版本变化的鲁棒性——reporter 变更会破提取，但后果被漂移兜底（未应用 → 重跑 calibrate）限缩，且无人要求钉 reporter 版本；归入 I2 的单测一并钉形状即可。
- fast 全量 329s 比 gate 238s 慢——fast 的目标用例是内环单条（抽样 6 条 18.4s），全量 fast 本就不是设计目标，数字不影响任何验收。
- mutation:calibrate 快照入 docs/ 入库——用户评审过的计划明确选择该路径，不重裁。
- --workers 0/负数/NaN 防御——'args.workers || 1' 与 Math.max(1,…) 已隐式兜底（源码核对 :1215 :1354），不值一条。
- 副本白名单该不该含 scripts/——含着无害（tests 可能 import 脚本）、剔除收益近零，不做口味裁决。
- M4 process.exit 的实际触发概率——未实测到丢输出（评审者自己的管道捕获完整），仅按 Node 语义列为 Minor，不升 Important。

## Assessment

**Ready to merge? With fixes.**

判词：这个 PR 的**判定逻辑、隔离设计、失败模型、销账诚实度**都过了终审——特别是把 Task 5 自己发现的空洞判据变成响亮卫兵这件事，方向和落实都对；138/138 的历史证据我采信（口径见 Recommendation 5）。但两件事必须在合并前有交代：

1. **C1（无时限挂死）**：评审机实测发生，完成定义的权威门槛不能带着「可能永久挂死」上主干。修复小（execSync timeout + worker 预算），必须做。
2. **I1（内环残余墙钟断言 + K=8 默认越包线）**：spec 自己实测出的安全包线（K=6）被自己的默认值（K=8）越过，gate 的 exit 0 在评审机已经不能稳定复现。要么移断言、要么降包线，二选一，合并前定。

I2（行为级测试）强烈建议同分支带上——它是防 C1/I1 修复本身回潜的工具——但如果时间紧，C1+I1 修复后跑通一轮干净 gate + 既有锚点也可接受合并，I2 转 follow-up。Minor 全部不阻塞。

评审者注：本次评审除本文件外零写入；评审过程启动过两类探针（8×并发套件、K=4 gate 复跑），后者挂死后由评审者终止，其泄漏的 /var/folders 副本已手工删除；评审机 /tmp 与 os.tmpdir() 无其它评审残留。
