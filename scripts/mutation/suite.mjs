/**
 * 套件执行与判定：跑一次 node --test、把结果分成 caught / survived / crashed、从输出里反查 judge 文件。
 *
 * 这里的四个函数同时被**主进程**（基线、fast）与**worker 模板**（`worker.mjs` 用
 * Function.prototype.toString 注入）使用：所以它们必须自包含 —— 自由变量只能来自 worker 模板
 * 里那段 require 头与序列化常量（`runSuite` 依赖 execFileSync/readdirSync/path 与三个 SUITE_*）。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { SUITE_CONCURRENCY, SUITE_HEAP_MB, SUITE_TIMEOUT_MS } from './host.mjs'

// 「跑一次套件」。root 参数化（隔离副本跑副本、源目录跑基线）。
// spec 省缺 = 全量内环 glob；{ files } = 只跑这些文件；{ files, patterns } 再叠加测试名过滤（P1）。
// 为什么把测试名过滤放在这一层：runSuite 是 gate / fast / 基线三条路径共用的唯一执行点，
// 过滤只有落在这里，才不会出现「gate 跑一套、fast 跑另一套」的双份语义。
export function runSuite(root, spec) {
  // baseline 可以传更宽的 timeout：worker 副本要同时跑完整的 1380 条测试，
  // 若与其它 worker 的变异套件争 CPU，120s 可能偶发超时；超时会被误判成「副本基线红」。
  const timeoutMs = typeof spec?.timeoutMs === 'number' ? spec.timeoutMs : SUITE_TIMEOUT_MS
  const files = spec?.files
  // 测试名过滤（P1）：judgeTests 是**子串**，node 的 --test-name-pattern 按正则吃，所以逐个转义。
  const patterns = (spec?.patterns ?? []).map((name) => String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  // 显式文件列表：不经过 shell，就没有引号转义这一层（测试名里有 ：+ ? ( ) 这些字符）。
  const targets = files ?? readdirSync(path.join(root, "tests")).filter((name) => name.endsWith(".test.mjs")).sort().map((name) => "tests/" + name)
  const argv = ["--test", "--test-concurrency=" + SUITE_CONCURRENCY]
  for (const pattern of patterns) argv.push("--test-name-pattern=" + pattern)
  argv.push(...targets)
  // 子进程显式带上堆上限：NODE_OPTIONS 会被 execSync → node → node --test 三层原样继承
  // （实测：父设 512 时孙进程 heap_size_limit 也是 704 MB）。继承来的堆上限必须先**摘掉**再追加——
  // 只靠「后面的覆盖前面的」虽然实测有效（4096+1024 ⇒ 1216 MB），但那依赖 V8 的取值次序，太脆。
  const inherited = (process.env.NODE_OPTIONS ?? '').replace(/--max-old-space-size=\d+/g, '').trim()
  const nodeOptions = (inherited + ' --max-old-space-size=' + SUITE_HEAP_MB).trim()
  try {
    const out = execFileSync(process.execPath, argv, { cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 * 1024, timeout: timeoutMs, env: { ...process.env, NODE_OPTIONS: nodeOptions } })
    return { ok: true, out: out }
  } catch (error) {
    // 超时（SIGTERM 杀）也是「判定无效」：分类器见 timeout 标志记 crashed——红 ≠ 被抓住。
    // ⚠️ signal 要排除 null：正常非零退出的 error.signal 是 null 而不是 undefined（实测踩过：
    //    判式写成 !== undefined 时每一条正常的套件红都被误判成「套件超时」，138 条全 crashed）
    return { ok: false, timeout: error.killed === true || Boolean(error.signal), out: String(error.stdout || '') + String(error.stderr || '') }
  }
}

// 分类器：原 :1009-1023 逐字搬入（含三坑注释）。res.ok 参与 caught/survived 的区分，故入参是 res。
export function classify(res, m) {
  if (res.timeout) return 'crashed'
  const mutatedFile = m.file.split('/').pop()
  const outLines = res.out.split('\n')
  // ⚠️ `\\s+`（不是 `\\s*`）：见上面 ② 的两种列 0 形状。
  const errorAt = outLines.findIndex((line) => /^\s+(ReferenceError|SyntaxError):/.test(line))
  const stackMentionsMutatedFile = errorAt >= 0 && outLines
    .slice(Math.max(0, errorAt - 6), errorAt + 7)
    .some((line) => line.includes(mutatedFile))
  if (errorAt >= 0 && stackMentionsMutatedFile) return 'crashed'
  return res.ok ? 'survived' : 'caught'
}

// 崩溃错误名（打印用，与 classify 同一条错误行正则）。
export function crashName(res) {
  if (res.timeout) return res.deterministic === true ? '套件超时（确定性：重试仍超时）' : '套件超时'
  const hit = res.out.split('\n').find((line) => /^\s+(ReferenceError|SyntaxError):/.test(line))
  return (hit && hit.match(/\b(ReferenceError|SyntaxError)\b/) || [])[1] || '未知'
}

// 翻红 → 测试文件基名（去重排序）。gate 校准与 fast 消费同一份口径。
// 实测（2026-10-15 scratch 失败用例）：reporter 的 ✖ 行印的是**测试名**不是文件名；
// 文件名印在紧邻的「test at tests/…」行（失败汇总里在其上方 1 行）与断言栈帧里
// （file:///…/tests/foo.test.mjs:4:10）。⇒ 对每个 ✖ 行在 ±6 行窗口内就近找 tests/*.test.mjs
// 引用，先上后下（汇总节的 at 行在上；就地节的栈帧在下）。
export function judgesFromFails(out) {
  const lines = out.split('\n')
  const judges = new Set()
  lines.forEach((line, i) => {
    if (!/^\s*✖/.test(line)) return
    for (let d = 1; d <= 6; d++) {
      for (const j of [i - d, i + d]) {
        if (j < 0 || j >= lines.length) continue
        const m = lines[j].match(/tests\/([\w.-]+\.test\.mjs)/)
        if (m) { judges.add(m[1]); d = 7; break }
      }
    }
  })
  return [...judges].sort()
}
