/**
 * 变异测试：把已经修好的关键判定**逐个改坏**，看测试套件是否见红。
 *
 * 为什么值得固化：最有价值的产出不是「测试全绿」，而是**量出了绿的可信边界** ——
 * 只断言 store 的客户端测试让三条接线变异全部幸存；正文缓存闸门因为喂的是废弃的数据形态而永不触发。
 * 两类问题「跑测试」发现不了，只有「改坏它看有没有人喊」才能发现。
 *
 * 结构（2026-11-18 拆分，见 .scratch/mutation-split/spec.md）：本文件只留 CLI 与装配；
 * 变异表在 `mutation/table.mjs`，套件判定在 `suite.mjs`，worker 池在 `worker.mjs`，
 * 资源闸在 `host.mjs`，增量在 `incremental.mjs`，报表在 `report.mjs`。
 *
 * 用法：npm run mutation（需先 npm run build + npm run build:client —— 改的是 lib/ 产物）。
 * 判据：**每一条变异都必须被抓到**；有幸存者就以非零码退出，并指出是哪条漏了。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MUTATIONS } from './mutation/table.mjs'
import { ROOT, defaultWorkers } from './mutation/host.mjs'
import { classify, crashName, judgesFromFails, runSuite } from './mutation/suite.mjs'
import { applyMutation, partitionMutations, runWorker, seedWorkerCopy } from './mutation/worker.mjs'
import { affectedPredicate, gitChangedFiles, loadCache, mutationCacheKey, saveCache, scriptVersion } from './mutation/incremental.mjs'
import { collectResults, exitCodeFor, writeJudgesDump, writeTimings } from './mutation/report.mjs'

function parseArgs(argv) {
  // 默认 K 由宿主编译期约束算出（见 defaultWorkers）：旧口径固定 min(6, cpus-2) 在本机会给到 6，
  // 叠加 node --test 的文件级并发 10 ⇒ 约 60 个 node 进程，16 GB 无 swap 的机器扛不住。
  const args = { mode: 'gate', workers: defaultWorkers(), dumpJudges: undefined, only: undefined, changed: false, incremental: false, timings: undefined, meta: undefined }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--mode') args.mode = argv[++i]
    // ⚠️ 显式 --workers 必须**同样受资源闸约束**：它是绕过 defaultWorkers 的唯一入口，
    // 放任 `--workers 8` 就等于把整机重新推回「几十个 node × 4 GB 堆」的死亡螺旋。
    // 不静默改数：超上限时明确打印夹到多少（2026-10-18 自审轮实测抓到的洞）。
    else if (a === '--workers') {
      const asked = Number(argv[++i])
      const ceiling = defaultWorkers()
      args.workers = Math.max(1, Math.min(Number.isFinite(asked) ? asked : 1, ceiling))
      if (Number.isFinite(asked) && asked > ceiling) console.error('--workers ' + asked + ' 超过宿主资源闸上限 ' + ceiling + '，已夹到 ' + args.workers + '（保护整机）')
    }
    else if (a === '--dump-judges') args.dumpJudges = argv[++i] ?? true
    else if (a === '--changed') args.changed = true
    else if (a === '--timings') args.timings = argv[++i] ?? true
    else if (a === '--incremental') args.incremental = true
    else if (a === '--mutations') args.only = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean)
    else { console.error('未知参数: ' + a); process.exit(2) }
  }
  return args
}

// fast 内环（杠杆 A）：judges 是 gate 轮的快照，只跑每条变异真正翻红的文件并集。
// 漂移兜底（spec §7）：judges 缺失或指向不存在的文件 ⇒ 计「未应用」入失败清单，绝不静默跳过；
// 副本基线红 ⇒ 全部记失败，本轮不给出任何建议。结论只是建议，gate 永远权威。
async function runFast(args, selected) {
  const workerRoot = mkdtempSync(path.join(os.tmpdir(), 'mutation-fast-'))
  const results = []
  try {
    const sub = path.join(workerRoot, 'w0')
    mkdirSync(sub, { recursive: true })
    seedWorkerCopy(sub)
    const baseline = runSuite(sub)
    if (!baseline.ok) {
      console.error('fast：隔离副本基线红——副本或快照不可信，本轮不给出建议。')
      for (const m of selected) results.push({ id: m.id, status: 'crashed', crash: '副本基线红', fails: [], judges: [] })
    } else {
      console.log('fast：基线绿。只跑 judges 并集（' + selected.length + ' 条；建议通道，gate 永远权威）：')
      console.log('')
      for (const m of selected) {
        const declared = [...new Set(m.judges ?? [])]
        const files = declared.filter((f) => existsSync(path.join(sub, 'tests', f)))
        if (declared.length === 0 || files.length !== declared.length) {
          console.log('  ?  ' + m.id.padEnd(26) + ' judges 缺失或指向不存在的测试文件——计「未应用」（漂移兜底：重跑 mutation:calibrate）')
          results.push({ id: m.id, status: 'unapplied', fails: [], judges: [] })
          continue
        }
        const applied = applyMutation(sub, m)
        if (!applied.ok) {
          console.log('  ?  ' + m.id.padEnd(26) + ' 未应用（产物里形状与预期不符，请同步更新本条）')
          results.push({ id: m.id, status: 'unapplied', fails: [], judges: [] })
          continue
        }
        let res
        const patterns = (m.judgeTests ?? []).filter((name) => typeof name === 'string' && name.length > 0)
        try { res = runSuite(sub, { files: files.map((f) => 'tests/' + f), patterns }) } finally { writeFileSync(path.join(sub, m.file), applied.original) }
        const fails = res.out.split('\n').filter((l) => /^\s*✖/.test(l)).map((l) => l.trim().replace(/\s*\(\d.*$/, ''))
        const verdict = classify(res, m)
        const redJudges = judgesFromFails(res.out).filter((j) => files.includes(j))
        const mark = verdict === 'caught' ? 'v' : verdict === 'crashed' ? '!' : 'x'
        const label = verdict === 'caught'
          ? '被 ' + (redJudges.join('、') || '未知文件') + ' 翻红（' + fails.length + ' 条）'
          : verdict === 'crashed'
            ? '崩了（' + crashName(res) + '：变异 `to` 自己写错了，不算被抓住）'
            : '幸存（judges 文件全绿——建议仅供参考，以 gate 为准）'
        console.log('  ' + mark + '  ' + m.id.padEnd(26) + ' ' + label)
        results.push({ id: m.id, status: verdict, fails, judges: redJudges })
      }
    }
  } finally {
    rmSync(workerRoot, { recursive: true, force: true })
  }
  const applied = results.filter((r) => r.status !== 'unapplied').length
  const survivors = results
    .filter((r) => r.status !== 'caught')
    .map((r) => r.id + (r.status === 'unapplied' ? '（未应用）' : r.status === 'crashed' ? '（崩了：' + (r.crash || '') + '）' : ''))
  console.log('')
  console.log('应用 ' + applied + '/' + selected.length + ' 条 · 幸存 ' + survivors.length + ' 条（fast 退出码恒非 0——fast 通过 ≠ gate 通过）')
  if (survivors.length > 0) console.error('幸存清单：' + survivors.join('、'))
  process.exitCode = exitCodeFor('fast', survivors.length === 0)
}

async function main() {
  const runStartedAt = Date.now()
  const args = parseArgs(process.argv.slice(2))
  let selected = args.only ? MUTATIONS.filter((m) => args.only.includes(m.id)) : MUTATIONS
  if (selected.length === 0) { console.error('--mutations 没匹配到任何条目'); process.exitCode = 2; return }
  // P2（opt-in）：--changed 只跑受影响的那几条；--incremental 允许复用缓存里的 caught 结论。
  // 两者都不传 = 全量 gate 的原路径（完全不知道缓存存在）。
  const useCache = args.changed || args.incremental
  if (args.changed) {
    const changed = gitChangedFiles()
    if (changed === undefined) { process.exitCode = 2; return }
    const predicate = affectedPredicate(changed)
    selected = selected.filter(predicate)
    console.log('--changed：' + changed.length + ' 个改动文件 → 命中 ' + selected.length + ' 条变异')
    if (selected.length === 0) { console.log('没有受影响的变异（改动的文件不进判据）。'); return }
  }
  if (args.mode === 'fast') { await runFast(args, selected); return }
  if (args.mode !== 'gate') { console.error('--mode ' + args.mode + ' 不认识（gate | fast）'); process.exitCode = 2; return }

  const baseline = runSuite(ROOT)
  if (!baseline.ok) {
    console.error('基线不是绿的 —— 先修好再跑变异。')
    console.error(baseline.out.split('\n').filter((l) => /^\s*(✖|not ok)/.test(l)).slice(0, 5).join('\n'))
    process.exitCode = 2
    return
  }
  console.log('基线绿。逐条改坏关键判定，看套件是否见红：')
  console.log('')

  // 缓存命中在这时结算：只认 caught，其余一律重跑（survived/crashed/unapplied 不缓存）。
  let cachedResults = []
  let toRun = selected
  let cache = { entries: {} }
  if (useCache) {
    cache = loadCache()
    const version = scriptVersion()
    const residual = []
    for (const m of selected) {
      const key = mutationCacheKey(m, version)
      m.cacheKey = key
      if (cache.entries[key]?.status === 'caught') cachedResults.push({ id: m.id, status: 'cached', key })
      else residual.push(m)
    }
    toRun = residual
    console.log('缓存命中 ' + cachedResults.length + ' 条（不重跑，不计入本轮抓到）')
  }

  const workerRoot = mkdtempSync(path.join(os.tmpdir(), 'mutation-gate-'))
  let results
  try {
    // 全部命中缓存时不建 worker：连副本基线那一次都省掉（否则「零变更」还要跑一遍空集）。
    if (toRun.length === 0) {
      results = [...cachedResults]
    } else {
      const n = Math.max(1, Math.min(args.workers || 1, toRun.length))
      const buckets = partitionMutations(toRun, n)
      const running = []
      for (let i = 0; i < buckets.length; i++) {
        if (buckets[i].length === 0) continue
        const sub = path.join(workerRoot, 'w' + i)
        mkdirSync(sub, { recursive: true })
        seedWorkerCopy(sub)
        running.push(runWorker(sub, buckets[i]))
      }
      results = [...cachedResults, ...(await Promise.all(running)).flat()]
    }
  } finally {
    rmSync(workerRoot, { recursive: true, force: true })
  }

  // 打印顺序对齐 MUTATIONS 定义序（并行回传顺序不定）
  const order = new Map(selected.map((m, i) => [m.id, i]))
  results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  // 把 key 贴回结果（worker 不需要知道缓存的存在）：缓存落盘只认本轮真跑过的 caught。
  const keyById = new Map(selected.filter((m) => typeof m.cacheKey === 'string').map((m) => [m.id, m.cacheKey]))
  for (const r of results) if (keyById.has(r.id)) r.key = keyById.get(r.id)
  const { applied, survivors, cached } = collectResults(results)
  if (args.timings !== undefined) writeTimings(args.timings === true ? 'mutation-timings.json' : args.timings, results, Date.now() - runStartedAt, args.workers)
  if (args.dumpJudges !== undefined) writeJudgesDump(args.dumpJudges === true ? 'judges-dump.json' : args.dumpJudges, results, selected)

  // 落盘缓存：只收「本轮真的抓到」的那部分，且只收带 key 的（= 增量路径）。
  if (useCache) {
    const now = new Date().toISOString()
    for (const r of results) {
      if (r.status !== 'caught') continue
      if (typeof r.key !== 'string') continue
      cache.entries[r.key] = { status: 'caught', id: r.id, at: now }
    }
    saveCache(cache)
  }

  const after = runSuite(ROOT)
  console.log('')
  console.log('应用 ' + applied + '/' + selected.length + ' 条 · 幸存 ' + survivors.length + ' 条' +
    (useCache ? ' · 缓存命中 ' + cached + ' 条（未重跑，不计入本轮抓到）' : '') +
    ' · 恢复后基线 ' + (after.ok ? '仍然绿' : '没恢复干净！'))
  if (survivors.length > 0) {
    console.error('幸存清单：' + survivors.join('、'))
    console.error('-> 标「幸存」的是测试没覆盖到的判定（补一条会翻红的断言，或确认它是等价变异）；')
    console.error('   标「崩了」的：变异 `to` 自己写错了（ReferenceError / SyntaxError），那种红不算被抓住（docs/pitfalls.md 二、2.7b）。')
    process.exitCode = 1
    return
  }
  console.log('全部被抓到。')
}

main().then(() => process.exit(process.exitCode ?? 0))
