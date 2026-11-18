/**
 * 宿主环境与资源闸：工作目录、核数/内存算出并发上限、低内存看门狗。
 *
 * 为什么单独成模块（`docs/pitfalls.md` §1.10）：闸门参数与 worker 数**只在这里**改，判定逻辑
 * 不该碰它；反过来，改这里也不需要理解变异判定。下面保留 2026-10-18 整机死机轮的现场注释。
 */
import os from 'node:os'
import { execSync } from 'node:child_process'

/** 门槛的工作目录：package.json 所在仓库根（npm run 的 cwd）。 */
export const ROOT = process.cwd()

// 终审 C1（2026-10-15 实测挂死 40+ 分钟，K=4 干净复跑零推进）：套件与 worker 都必须有时限——
// 否则任一套件在负载下卡死 = 整个门槛无输出、无退出码地永久挂死。
export const SUITE_TIMEOUT_MS = 120_000        // 单次套件墙钟上限（正常 ≈7s；超时 ⇒ 判定无效记「套件超时」）
export const WORKER_BUDGET_MS = 15 * 60_000    // 单个 worker 总预算（正常全量 ≈4min；超时强制回收并 sweep）

// ── 宿主资源闸（2026-10-18 整机死机排障轮）────────────────────────────────────────
// 为什么：这条门槛的**进程数**从来没有上限，而它是本仓库唯一会把整机拖垮的东西。
// 实测（M4 / 16 GB / 10 核）：K=6 时峰值 ≈ 1 主进程 + 6 worker 线程 +
// 6 × (1 runner + node --test 的文件级并发上限 availableParallelism()=10) ≈ 60 个 node 进程；
// 每个测试子进程默认堆上限 4288 MB（NODE_OPTIONS 有没有都一样），而本机 vm.swapusage = 0
// （/System/Volumes/VM 无 swapfile）⇒ 需求一旦超过物理内存就是直接进 compressor 争抢，
// 没有磁盘缓冲垫。历史现场：2026-10-16 一晚 14 个 JetsamEvent（reason=vm-compressor-space-shortage、
// largestProcess=node），紧接 00:24 一次 panic + shutdown stall。
// ⇒ 三道闸，都只压「上限」不压「按需」（单套件实测峰值仅 332 MB，正常路径完全够用）：
//   ① worker 数随核数与内存收敛（不再固定 6）；
//   ② 套件内的文件级并发封顶（默认 10 降到 3，实测单套件 7s→8s，可忽略）；
//   ③ 每个套件子进程带堆上限 —— 超限由 V8 自己 abort（可诊断、可重跑），
//      而不是让它一路涨到整机 compressor 崩掉（那才是「死机」的形态）。
const HOST_CPUS = os.availableParallelism()
const HOST_GB = os.totalmem() / 1024 ** 3
export const SUITE_CONCURRENCY = Math.max(2, Math.min(4, Math.floor(HOST_CPUS / 3)))
export const SUITE_HEAP_MB = 1024
// 低内存看门狗：可用内存低于此值即强制回收全部 worker（宁可本轮判定无效，也不让整机进死亡螺旋）
export const HOST_FLOOR_MB = 512
export function defaultWorkers() {
  return Math.max(1, Math.min(6, Math.floor(HOST_CPUS / 3), Math.floor(HOST_GB / 4)))
}
// 可用内存（MB）。⚠️ 不能用 os.freemem()：macOS 上它只数 Pages free（实测 1546 MB，
// 而 free+inactive 是 5319 MB）—— 空闲内存大半躺在 inactive/file cache 里，
// 按 Pages free 设水位会在套件刚起步时就误触发（实测首轮门真的把 138 条全判成「崩了」）。
export function hostFreeMB() {
  try {
    const stat = execSync('vm_stat', { encoding: 'utf8', timeout: 5000 })
    const pageSize = Number(/page size of (\d+)/.exec(stat)?.[1] ?? 16384)
    const pages = (label) => Number(new RegExp(label + ':\\s+(\\d+)').exec(stat)?.[1]?.replace(/\./g, '') ?? 0)
    return Math.round((pages('Pages free') + pages('Pages inactive') + pages('Pages speculative')) * pageSize / 1048576)
  } catch {
    // vm_stat 起不来（非 macOS / 沙箱拒绝）⇒ 无从判断水位，退回「不干预」：宁可少一道闸，
    // 也不许把整轮判定误伤成「崩了」。
    return Number.POSITIVE_INFINITY
  }
}
