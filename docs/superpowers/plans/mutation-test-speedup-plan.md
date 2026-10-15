# 变异测试提速计划（2026-10-15 合并定稿）

> 状态：已拍板、待实施。
> 本文件合并 docs/inbox/mutation-test-speedup-plan.md（实施计划）与
> docs/inbox/mutation-test-speedup-plan-measured.md（实测增补）为一份，并纳入 2026-10-15 的
> 并发实测，修正两处承重结论（见 §3）。旧两份 inbox 文件已删。
> 证据分级沿用仓库惯例：实测 / 源码核对（带 file:line）/ 推算（写算式）/ 猜测。

## 0. 结论

| 项 | 结论 |
|---|---|
| 目标 | 内环单条 <=1s；gate 整轮 <=3min（可另追 ~1min，推算，落地复测） |
| 顺序 | ① 分层摘出 article-perf 墙钟闸门 → ② 方案 2 并行 worker → ③ 方案 1 judges 反查 |
| 安全基线 | gate 永远权威、fast 纯建议、退出码契约写死（fast 通过 ≠ gate 通过） |

## 1. 为什么需要（保留原计划 §1.1）

现有测试支撑「行为」，但无法自证在守卫退回时会翻红。这个仓库的失败几乎全是静默失效（全绿 +
构建过 + 真机坏），覆盖统计看不见，只有「把判定改坏看有没有人喊」才看得见。变异清单是人手维护的
「承重点」清单，本质是「回归之回归」。结论：保留门槛，改它的成本模型。

本次存储改造里门槛抓到 3 条「测试全绿 + 两个构建全过」的假绿（实测）：
1. lib/refresh.js 变异因作用域外 urls 抛 ReferenceError ⇒ 红但无断言观察到缺陷；
2. 崩溃分类器对 lib/client.js 失明（vm 加载不给 filename，50/138 条、占 36%）；
3. client 左栏角标 to 少一个展开运算符 ⇒ 91 条 SyntaxError，却被历史记为「抓到」。

## 2. 根因（源码核对 + 实测）

- 慢在串行 + 每次全量，不是 build。runSuite() = execSync('node --test tests/*.test.mjs 2>&1')
  （scripts/mutation-test.mjs:928-935）；:937 baseline、:951 主循环逐条、:1032 after（复验）
  ⇒ 每轮 N+2 次全量。
- 单次套件 6.35s（本机 3 次均值，实测）⇒ 138 条 × 6.35s ≈ 14.6min。
- node --test 内部已按文件并行，单次墙钟 ≈ 最慢的那个测试文件，与文件数几乎无关（§9 复现）。

## 3. 2026-10-15 并发实测（本次新增，推翻两处承重结论）

同一台机器（10 核 / node v24.19）、全套件逐组测：

| 测量 | 结果（实测） |
|---|---|
| client 组（scroll-dom / client-bundle / nav-selection / unread-accounting）× K=6，3 轮 | 0 假红，墙钟 ~6.1s ≈ 串行 |
| 全套件 × K=2，3 轮 | 0 假红 |
| 全套件 × K=4，3 轮 | 4/4 假红，每轮全挂 |
| 全套件 × K=6，6 轮 | 6/6 假红，每轮全挂 |
| 假红来源归因 | 100% 是 article-perf.test.mjs 的 5 条「抽取规模闸门」（300ms × 4 + 1s × 1），无第二处 |
| 摘掉 article-perf 后全套件 × K=6，2 轮 | 0 假红 |

三条推导（源码核对 + 实测）：

1. 「client 50 条须串行」不成立。client 组 6 并发 0 假红；真正在并发下误报的是 host 侧的
   article-perf，不是 jsdom/sleep。（原计划 §4.2 把「并发假红」归给 client 组 sleep 断言，机制归错了。）
2. 「方案 2 = 5.10× 可靠」不可复现。全套件 K≥4 起 100% 假红，按理只能停 K≤2（≈1.8×）。原文档 5.10×
   那次实验在现套件下会把假红当「抓到」吸收（docs/pitfalls.md §1.9 警告的假红规模化）。
3. article-perf 对「抓变异」零贡献。它 5 条 gate 用 assert.ok(elapsed < 300) 这类墙钟预算守
   「线性扫描 vs 二次扫描」的算法复杂度（bda7e56，「未闭合标签载荷冻住 host 67 秒」），而变异清单是
   单点 from→to 语义替换，表达不了算法级退化。实测逐条 apply 3 条 lib/article.js 变异：前两条对
   article-perf 0 red；「容器识别整页兜底」只 red 它内部的 correctness 对照用例（assert.equal 数段落、
   非 timing），5 条 timing gate 全部 0 red。

## 4. 三条杠杆（修正后，互不冲突、按序叠加）

| # | 杠杆 | 做什么 | 收益（实测或推算） | 前提 |
|---|---|---|---|---|
| 0 | 分层 article-perf（新增） | 5 条 timing gate 拆到独立文件（或 runner 跳过该文件）；npm test 照常全量跑守 67s | 解锁方案 2 的 K=6 | 不删测试、npm test 不变 |
| A | 方案 1 judges 反查 | 每条变异只跑它真正翻红的测试文件（--dump-judges 校准） | 内环单条 189ms（33.6×，非 client 变异） | 先付一次 ≈14.6min 校准 |
| B | 方案 2 并行 worker | N 份隔离副本各跑一部分变异 | gate 整轮 ≈ 5×（推算，落地复测） | 隔离副本池；分层 perf gate 后 |

组合外推（推算，落地复测确认）：host 88 条 × 189ms ÷ 5 ≈ 3s；client 50 条 × 6.35s ÷ 5 ≈ 64s；
⇒ gate ≈ 1.1min；内环单条 ≈ 0.19s。「1-2 min」成立，且比原文档更稳——因为 client 其实可并行。

## 5. 实施顺序与验收

| 序 | 动作 | 验收 | 依赖 |
|---|---|---|---|
| 1 | 分层 article-perf（拆文件 / runner 跳过） | npm test 照全绿；变异轮 K=6 0 假红 | 无 |
| 2 | 方案 2：隔离副本池 + host/client 分组并行，K=6-8 | gate 复跑 0 幸存 / 0 崩 / 0 未应用、exit 0 | 1 |
| 3 | 方案 1：--dump-judges → 人工收敛 → 每条回填 judges → --mode fast/gate | gateRed(m) ⊆ judges(m) 0 违反；fast 与 gate 抽样结论一致 | 2（用并行跑校准，把校准从 14.6min 压到 ~3min） |
| 4 | 退出码契约 + 联动文档（AGENTS.md 完成定义 / README 开发段） | fast ≠ gate 写死 | 3 |

- 方案 1 的 judges 内联在每条变异里、取并集冗余（原计划 §3.2 数据契约）；--dump-judges 收紧到 file 级、
  人工剔除「整体崩掉」的连带文件（原计划 §3.3）。
- 安全不变量 gateRed(m) ⊆ judges(m) 逐条验（原计划 §3.4，方向已更正）。fast 逐条报告「哪个 judge 翻红」。

## 6. 正确性边界（保留原计划 + 新增）

- 照旧的部分：judges 数据契约（内联、并集）；gateRed ⊆ judges 不变量；「崩了」分类器（vm 加载已补
  filename，fast 继承）；两条并发反例（同副本互相污染 / 并发假红——假红机制已更正为 perf gate）。
- 新增边界：article-perf 的 timing gate 是性能守卫、非 correctness；移出变异轮不等于删——它继续在
  npm test 里非超订阅环境守 67s 回归。唯一代价：容器识别整页兜底 少一个判据，但 article.test.mjs 仍
  抓着它（冗余），判别力不减；待 P1 校准对每条 judge 并集最终确认。
- client 组因此并入并行池（原计划作「串行」的那部分）：拆掉 perf gate 后，client 测试与 host 一样可按
  核数并行，不再有「client 串行地板」。

## 7. judges 漂移兜底（原计划 §9 再确认）

- --dump-judges 的 judges 是快照，测试文件/变异清单任何变动都会让它悄悄失效 ⇒ fast 报假「抓到」。
- 兜底 = gate 永远权威 + fast 纯建议 + 退出码契约写死（fast 通过 ≠ gate 通过）+ AGENTS.md 完成定义里
  mutation 仍作 gate 收尾。不建主动漂移检测（主动检测 = 重跑全量 = 把 14.6min 买回来）。
- 失效的 fast 最多让内环被误导一次，轮收尾 gate 照跑照样抓回漂移造成的假绿——结论不比今天更坏。
- 回滚路径：以 gate 为准 + 重跑 --dump-judges 刷新映射（原计划 §9）。

## 8. 未决 / 待落地复测 —— 2026-10-15 落地销账

- 「拆分 unread-accounting」**确认作废**（实测）：校准快照里 unread-accounting.test.mjs 以 7 条
  变异的 judge 身份保留，无 host 变异需要它作唯一判据，不拆。
- 方案 2 墙钟（实测，10 核本机，K=6/8 复测）：233.1s / 216.5s / 修复忠实化后 238.4s，**≈3.9min，
  达到「可另追 ~1min」线、未达 3min 目标**；提速 ≈3.7×（基线 ≈14.6min）。5× 未兑现的原因：
  K=8 后副本种子（node_modules+src 拷贝）与每 worker 的固定开销占比上升；K 按核数自适应（默认
  min(8, 核数-2)），别把本机数字当跨机器常数。
- 33.6× 内环单条（实测口径修正）：fast 全量 138 条 329s ⇒ 单条均摊 ≈2.4s（含副本种子摊销后的
  下界）；抽样 6 条跨族合计 18.4s。**未达 189ms/1s 目标**——推算漏了「副本必须整份构建」这一层；
  单条要更快需常驻副本池，属后续优化，本轮不做（YAGNI，门槛墙钟已达标线）。
- 假红率（实测）：修复忠实化后的 gate 全轮 0 崩 / 0 未应用 / 0 worker_error；fast 全量 138/138 抓到。
- 新增实测教训（计划未预见）：①seed 白名单必须含 src/ 与 node_modules/（副本忠实化）；②cpSync
  必须 preserveTimestamps（mtime 反超会让 client-bundle:265 对任何变异必红，「0 幸存」变空洞判据）；
  ③runner 的 ✖ 行只印测试名不印文件名，judges 提取走 ±6 行窗口；④副本基线卫兵：基线红 ⇒ 全部
  变异记 worker_error 计入失败清单。均已随 Task 3/5 落进 runner 与冒烟测试。

## 9. 复现方法（全部只读，除临时副本）

    # 1) 单次全套件（基线应绿、~6.2s）
    node --test tests/*.test.mjs

    # 2) 全套件 6 并发（每进程一个全套件；现套件下应 6/6 假红、来源 article-perf 300ms/1s 闸门）
    for i in 1 2 3 4 5 6; do node --test tests/*.test.mjs >/tmp/mut$i.log 2>&1 & done; wait
    grep -l "✖" /tmp/mut?.log

    # 3) 摘掉 article-perf 的 6 并发（应 0 假红）
    FILES=$(ls tests/*.test.mjs | grep -v article-perf)
    for i in 1 2 3 4 5 6; do node --test $FILES >/tmp/np$i.log 2>&1 & done; wait
    grep -l "✖" /tmp/np?.log
