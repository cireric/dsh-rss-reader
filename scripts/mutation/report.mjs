/**
 * 报表与汇总：逐条判定打印、--timings、judges 快照、退出码契约。
 * 这里全是**展示/记账**逻辑：不跑测试、不改产物；换报表格式不该碰判定或 worker。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// ── 耗时报表（opt-in，--timings <file>）──────────────────────────────────
// 为什么要它：门槛快下去之后，「下次改动会不会又变慢」只能靠**趋势**回答。
// 报表记的是每条变异的墙钟与分档（<=300ms / 300ms–1s / >=1s）——
// 优化空间几乎总在「>=1s 的那几条占了多少比例」这个数上，而不是平均值。
export function writeTimings(file, results, wallMs, workers) {
  const rows = results
    .filter((r) => typeof r.ms === 'number')
    .map((r) => ({ id: r.id, ms: r.ms, status: r.status, narrowed: r.narrowed === true }))
    .sort((a, b) => b.ms - a.ms)
  const totalMs = rows.reduce((acc, r) => acc + r.ms, 0)
  const slow = rows.filter((r) => r.ms >= 1000)
  const slowMs = slow.reduce((acc, r) => acc + r.ms, 0)
  const report = {
    generatedAt: new Date().toISOString(),
    node: process.versions.node,
    workers,
    wallMs,
    mutationMs: totalMs,
    count: rows.length,
    slowCount: slow.length,
    slowShare: totalMs === 0 ? 0 : Math.round((slowMs / totalMs) * 100),
    narrowedCount: rows.filter((r) => r.narrowed).length,
    etaSecondsByWorkers: Object.fromEntries([1, 2, 3, 4].map((n) => [n, Math.round(totalMs / n / 1000)])),
    slowest: rows.slice(0, 15),
  }
  writeFileSync(file, JSON.stringify(report, null, 2) + String.fromCharCode(10))
  console.log('')
  console.log('耗时报表已写入 ' + file + '（' + rows.length + ' 条，合计 ' + (totalMs / 1000).toFixed(1) + 's，墙钟 ' + (wallMs / 1000).toFixed(1) + 's）')
  console.log('  >=1s 的 ' + slow.length + ' 条占了 ' + report.slowShare + '%：')
  for (const r of slow.slice(0, 8)) console.log('    ' + String(r.ms).padStart(6) + 'ms  ' + r.id)
  console.log('  按当前分布估算（不含基线）：1 worker ≈ ' + report.etaSecondsByWorkers[1] + 's · 2 ≈ ' + report.etaSecondsByWorkers[2] + 's · 3 ≈ ' + report.etaSecondsByWorkers[3] + 's')
}

// 汇总（原 :1032-1040 的判定与文案逐字保留；applied 口径 = 除「未应用」外全部计入，同原实现）。
export function collectResults(results) {
  const survivors = []
  let applied = 0
  let cached = 0
  for (const r of results) {
    if (r.status === 'unapplied') {
      console.log('  ?  ' + r.id.padEnd(26) + ' 未应用（产物里形状与预期不符，请同步更新本条）')
      survivors.push(r.id + '（未应用）')
    } else if (r.status === 'crashed') {
      applied += 1
      console.log('  !  ' + r.id.padEnd(26) + ' 崩了（' + (r.crash || '未知') + '：变异 `to` 自己写错了，不算被抓住 —— 请改 `to`）')
      survivors.push(r.id + '（崩了：' + (r.crash || '未知') + '）')
    } else if (r.status === 'worker_error') {
      applied += 1
      console.log('  !  ' + r.id.padEnd(26) + ' 副本基线红（判定无效——先修副本忠实化，重跑门槛）')
      survivors.push(r.id + '（副本基线红）')
    } else if (r.status === 'cached') {
      // 缓存命中：**独立计数**，既不进 applied，也不进 survivors ——
      // 它证明的是「这条以前被抓到过」，不是「本轮抓到了」。两者混在一起就是伪绿。
      cached += 1
    } else if (r.status === 'survived') {
      applied += 1
      console.log('  x  ' + r.id.padEnd(26) + ' 幸存（套件仍然全绿）')
      survivors.push(r.id)
    } else {
      applied += 1
      console.log('  v  ' + r.id.padEnd(26) + ' 被抓到（' + (r.fails?.length ?? 0) + ' 条翻红：' + (r.fails?.[0] || '').slice(0, 44) + '）')
    }
  }
  return { applied, survivors, cached }
}

// judges 快照落盘（杠杆 A 前置）：gate 全量轮的实测翻红就是「哪些测试看着这条变异」的快照——
// fast 只跑这些文件的前提是快照采自 gate（gateRed ⊆ judges 由构造成立，spec §5）。
// crashed / survived / unapplied 不进快照：它们本来就令 gate exit 1，没有「看着谁」可言。
// 翻红用例名：worker 回传的是原始 ✖ 行（含 "✖ failing tests:" 表头、重复项、尾部耗时），
// 校准要的是「能直接当 --test-name-pattern 用的名字」，所以在这里统一清洗。
function cleanFails(raw) {
  const names = []
  for (const line of raw ?? []) {
    const name = String(line).replace(/^\s*✖\s*/, '').replace(/\s*\(\d+(\.\d+)?ms\)\s*$/, '').trim()
    if (name === '' || name === 'failing tests:' || names.includes(name)) continue
    names.push(name)
  }
  return names
}

export function writeJudgesDump(file, results, selected) {
  const mutations = {}
  for (const r of results) {
    if (r.status !== 'caught') continue
    const m = selected.find((x) => x.id === r.id)
    mutations[r.id] = { file: m ? m.file : '', judges: r.judges ?? [], judgeTests: m?.judgeTests ?? [], fails: cleanFails(r.fails) }
  }
  // 目标目录可能还不存在（--dump-judges 指向 .scratch/ 时是常态）：先建，别让校准命令 ENOENT。
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), suiteGlob: 'tests/*.test.mjs', mutations }, null, 2))
  console.log('judges 快照已写入 ' + file + '（' + Object.keys(mutations).length + ' 条）')
}

// 退出码契约（spec §0）：gate 干净=0 / gate 失败=1 / 基线红=2；fast 一律非 0——全抓到=3、
// 有任何非抓到=4。fast 通过 ≠ gate 通过：fast 是建议通道，只有 gate 干净才允许 exit 0。
export function exitCodeFor(mode, ok) {
  return mode === 'fast' ? (ok ? 3 : 4) : (ok ? 0 : 1)
}
