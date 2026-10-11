/**
 * 规模基准：把 §9.3 的验收线变成**可测的数字**。
 *
 * 为什么必须先有它：存储改造的收益是「比现在快多少」，而改造前的基线如果不先量出来，
 * 事后就只能靠断言说「改好了」。本脚本只做**只读 + 合成数据**，绝不触碰真实
 * `rss_reader.json`（§11 的复现脚本也只读它）。
 *
 * 用法：
 *   npm run build            # 必须：本脚本 import 的是 lib/ 产物
 *   node scripts/scale-bench.mjs [--feeds=200] [--per=500] [--json]
 *
 * 判据（对应 spec §9.3 的存储侧三条）：
 *   - 打开（parse + 全量 zod 校验）耗时
 *   - 单次整份重写耗时（现状写路径）
 *   - 一源 500 条批量标已读耗时（= 500 × 整份重写）
 *   - 常驻堆（解析后两次 GC）
 *
 * 数据形状刻意用**纯元数据行**（与 spec §2 第三行同形）：正文与摘要外置是方案的一部分，
 * 基线要量的是「行数与元数据」的代价，不是被 maxContentChars 截断后的偶然值。
 *
 * ⚠️ **量的是 items 表那一份**，不是完整域文件（后者还含 feeds / cursors / global）。
 * 生产文件里 cursors 的去重窗口另占可观字节（spec §2 的漏项表），本脚本不覆盖它。
 */
import { writeFileSync, renameSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { itemRecordSchema } from '../lib/domain.js'

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? fallback : Number(hit.split('=')[1])
}
const FEEDS = arg('feeds', 200)
const PER = arg('per', 500)
const N = FEEDS * PER
const AS_JSON = process.argv.includes('--json')

const hr = () => process.hrtime.bigint()
const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6
const round = (n) => Math.round(n * 100) / 100

/** 构造与 spec §2「纯元数据」同形的行：只有 id 键之外的元数据字段。 */
function buildRows() {
  const rows = []
  for (let f = 0; f < FEEDS; f += 1) {
    const feedId = `https://feed${f}.example.com/atom.xml`
    for (let i = 0; i < PER; i += 1) {
      rows.push({
        feedId,
        title: 't'.repeat(60) + '#' + f + '_' + i,
        link: `https://site${f}.example.com/post/${i}/` + 'u'.repeat(40),
        // 三分之一刻意**不给发布时间**：排序键是 publishedAt ?? fetchedAt，
        // 这个比例让「缺发布时间的行」在基线与改造后都占可观测份额。
        ...(i % 3 === 0 ? {} : { publishedAt: '2026-10-11T09:00:00.000Z' }),
        fetchedAt: '2026-10-11T10:00:00.000Z',
        ...(i % 3 === 0 ? { readAt: '2026-10-11T10:05:00.000Z' } : {}),
        starred: i % 7 === 0,
      })
    }
  }
  return rows
}

function main() {
  const dir = mkdtempSync(join(tmpdir(), 'scale-bench-'))
  const file = join(dir, 'items.json')
  try {
    const rows = buildRows()
    const text = JSON.stringify(rows)
    writeFileSync(file, text)
    const bytes = Buffer.byteLength(text)

    // ① 打开：整份读入 + parse（现状 single 布局的路径）
    let t = hr()
    const parsed = JSON.parse(text)
    const parseMs = ms(t)

    // ② 全量 zod 校验（域打开时的第二步）
    t = hr()
    for (const rec of parsed) itemRecordSchema.parse(rec)
    const zodMs = ms(t)

    // ③ 整份重写（现状每次写盘的成本）——取中位数，避开首轮冷缓存
    const times = []
    for (let k = 0; k < 11; k += 1) {
      const s = hr()
      writeFileSync(file + '.tmp', text)
      renameSync(file + '.tmp', file)
      times.push(ms(s))
    }
    times.sort((a, b) => a - b)
    const rewriteMedian = times[Math.floor(times.length / 2)]
    const rewriteMax = times[times.length - 1]

    // ④ 常驻堆：两次 GC 后
    if (typeof global.gc === 'function') { global.gc(); global.gc() }
    const heapMiB = process.memoryUsage().heapUsed / 1048576

    const result = {
      rows: N,
      feeds: FEEDS,
      perFeed: PER,
      fileMiB: round(bytes / 1048576),
      bytesPerRow: Math.round(bytes / N),
      openMs: round(parseMs + zodMs),
      parseMs: round(parseMs),
      zodMs: round(zodMs),
      rewriteMedianMs: round(rewriteMedian),
      rewriteMaxMs: round(rewriteMax),
      // 一源全标已读 = 500 次整份重写（现状 markRead 逐条 saveItem）
      markFeedReadMs: round(rewriteMedian * PER),
      heapMiB: round(heapMiB),
      gcExposed: typeof global.gc === 'function',
    }

    if (AS_JSON) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n')
      return
    }
    process.stdout.write(
      `规模基准（现状：域 + single JSON）\n` +
      `  行数            ${result.rows}（${result.feeds} 源 × ${result.perFeed}）\n` +
      `  文件            ${result.fileMiB} MiB（${result.bytesPerRow} B/行）\n` +
      `  打开            ${result.openMs} ms（parse ${result.parseMs} + zod ${result.zodMs}）\n` +
      `  整份重写        中位 ${result.rewriteMedianMs} ms / 峰值 ${result.rewriteMaxMs} ms\n` +
      `  一源全标已读    ${result.markFeedReadMs} ms（外推：${result.perFeed} × 重写中位，非实测）\n` +
      `  常驻堆          ${result.heapMiB} MiB${result.gcExposed ? '' : '（未暴露 gc，偏高）'}\n` +
      `\n对照 spec §9.3 存储侧：打开 ≤200ms / 一源全标已读 ≤1s / 常驻 ≤300MB\n`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

main()
