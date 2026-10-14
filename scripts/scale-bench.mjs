/**
 * 规模基准：把 §9.3 的验收线变成**可测的数字**。
 *
 * 为什么必须先有它：存储改造的收益是「比现在快多少」，而改造前的基线如果不先量出来，
 * 事后就只能靠断言说「改好了」。本脚本**只用合成数据**（`buildRows` 现造），不读任何真实数据文件，
 * 也不碰用户订阅；SQLite 那半在临时目录里建库、跑完即删。（§11 的复现脚本当时另读
 * `rss_reader.json` 的副本 —— 那个文件后来已从真机删除，与本脚本无关。）
 *
 * 用法：
 *   npm run build            # 必须：本脚本 import 的是 lib/ 产物
 *   node --expose-gc scripts/scale-bench.mjs [--feeds=200] [--per=500] [--json]
 *
 * 两条路径都量，同一批合成行：
 *   A. 现状（域 + single JSON）—— 打开 / 整份重写 / 一源 500 条标已读（外推）
 *   B. 自持（node:sqlite + Task 3 的 createSqliteStore）—— 建库+建索引 / 插入 10 万行 /
 *      单条标已读 / **一源 500 条标已读（实测，不是外推）** / 常驻堆
 *
 * ⚠️ B 走的是**构建产物的真实 store**（`lib/store-sqlite.js`），不是本脚本另写一遍 SQL：
 * 「一源 500 条标已读 ≤ 1 s」是本方案的核心验收线，量它必须量真代码。
 * 只有「插入 10 万行」是用一条 INSERT 直灌（迁移的形状）——逐条 saveItem 的开销另有
 * 一条单独的数字（`insertOneByOneMs`），免得把两种成本混成一个数。
 *
 * 数据形状刻意用**纯元数据行**（与 spec §2 第三行同形）：正文与摘要外置是方案的一部分，
 * 基线要量的是「行数与元数据」的代价，不是被 maxContentChars 截断后的偶然值。
 *
 * ⚠️ **量的是 items 表那一份**，不是完整域文件（后者还含 feeds / cursors / global）。
 * 生产文件里 cursors 的去重窗口另占可观字节（spec §2 的漏项表），本脚本不覆盖它。
 */
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { itemRecordSchema } from '../lib/domain.js'
import { openDatabase, migrateSchema } from '../lib/storage/db.js'
import { createSqliteStore } from '../lib/store-sqlite.js'

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? fallback : Number(hit.split('=')[1])
}
const FEEDS = arg('feeds', 200)
const PER = arg('per', 500)
const N = FEEDS * PER
// 「一源全标已读」与「每源列表」都量 feed-1：它必须真的存在，否则量到的是**空结果**
// （实测踩到：写 'feed-1' 而真实键是 'https://feed1.example.com/atom.xml'，
//  listItems 返回 0 行却报 0 ms —— 一个好看但假的数字）
const SAMPLE_FEED = `https://feed1.example.com/atom.xml`
// 「逐条 saveItem」的探针行必须落在**另一个**源上，否则它们会混进 SAMPLE_FEED 的行数里，
// 让「每源列表」量到 1500 行而不是 500（实测踩到，靠下面那条行数断言抓住）
const PROBE_FEED = `https://probe.example.com/atom.xml`
const AS_JSON = process.argv.includes('--json')

const hr = () => process.hrtime.bigint()
const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6
const round = (n) => Math.round(n * 100) / 100
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** 构造与 spec §2「纯元数据」同形的行：只有 id 键之外的元数据字段。 */
function buildRows() {
  const rows = []
  for (let f = 0; f < FEEDS; f += 1) {
    const feedId = `https://feed${f}.example.com/atom.xml`
    for (let i = 0; i < PER; i += 1) {
      rows.push({
        id: `item-${f}-${i}`,
        feedId,
        title: 't'.repeat(60) + '#' + f + '_' + i,
        link: `https://site${f}.example.com/post/${i}/` + 'u'.repeat(40),
        // 三分之一刻意**不给发布时间**：排序键是 publishedAt ?? fetchedAt，
        // 这个比例让「缺发布时间的行」在两条路径上都占可观测份额。
        ...(i % 3 === 0 ? {} : { publishedAt: '2026-10-11T09:00:00.000Z' }),
        fetchedAt: '2026-10-11T10:00:00.000Z',
        ...(i % 3 === 0 ? { readAt: '2026-10-11T10:05:00.000Z' } : {}),
        starred: i % 7 === 0,
      })
    }
  }
  return rows
}

/** A. 现状：域 + single JSON。整份读入 → parse → zod → 每次写整份重写。 */
function measureJson(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'scale-bench-json-'))
  const file = join(dir, 'items.json')
  try {
    const payload = rows.map(({ id, ...record }) => record)
    const text = JSON.stringify(payload)
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
    const rewriteMedian = median(times)

    return {
      fileMiB: round(bytes / 1048576),
      bytesPerRow: Math.round(bytes / N),
      openMs: round(parseMs + zodMs),
      parseMs: round(parseMs),
      zodMs: round(zodMs),
      rewriteMedianMs: round(rewriteMedian),
      rewriteMaxMs: round(Math.max(...times)),
      // 一源全标已读 = 500 次整份重写（现状 markRead 逐条 saveItem）
      markFeedReadMs: round(rewriteMedian * PER),
      markFeedReadExtrapolated: true,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** B. 自持：node:sqlite + Task 3 的真实 store。 */
async function measureSqlite(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'scale-bench-sqlite-'))
  const dbPath = join(dir, 'rss.db')
  try {
    // ① 建库 + 建索引（openDatabase 的 WAL/权限设置 + migrateSchema 的 DDL）
    let t = hr()
    const db = openDatabase(dbPath)
    migrateSchema(db)
    const schemaMs = ms(t)

    const store = createSqliteStore(db, join(dir, 'config.json'))
    try {
      // ② 插入 10 万行。**单事务 + 一条 INSERT**：这是迁移的形状（Task 4 就是一个事务里灌完），
      //    所以它量的是批量导入，不是逐条 saveItem。用 sqlite 的原始语句是为了不让
      //    store 每次写都开一个事务 —— 那条成本下面单独量。
      const insert = db.prepare(
        'INSERT INTO items (id, feed_id, title, link, published_at, fetched_at, read_at, starred) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      db.exec('BEGIN')
      t = hr()
      for (const row of rows) {
        insert.run(
          row.id, row.feedId, row.title, row.link,
          row.publishedAt ?? null, row.fetchedAt, row.readAt ?? null, row.starred ? 1 : 0,
        )
      }
      db.exec('COMMIT')
      const insertMs = ms(t)

      // ③ 逐条 saveItem（另一条真实路径：refresh.ts 新增条目就是这么写的）。
      //    只取 1000 条样本，避免 benchmark 本身变成主要耗时。
      const sample = Math.min(1000, N)
      t = hr()
      for (let i = 0; i < sample; i += 1) {
        await store.saveItem(`probe-${i}`, {
          feedId: PROBE_FEED,
          title: 'probe', link: 'https://site.example/probe/' + i,
          fetchedAt: '2026-10-11T10:00:00.000Z', starred: false,
        })
      }
      const insertOneByOneMs = ms(t) / sample

      // ④ 单条标已读 = 一次原子读改写（endpoints.ts:154 的路径）。取 100 次的中位。
      const single = []
      for (let i = 0; i < 100; i += 1) {
        const s = hr()
        await store.updateItem(`item-0-${i}`, (current) => ({ ...current, readAt: '2026-10-11T12:00:00.000Z' }))
        single.push(ms(s))
      }

      // ⑤ **一源 500 条标已读（实测）**：正是验收线那一条。
      //    走 store 的真实读改写路径（读一行 + 写一行 + 写正文行），每次一个事务。
      t = hr()
      for (let i = 0; i < PER; i += 1) {
        await store.updateItem(`item-1-${i}`, (current) => ({ ...current, readAt: '2026-10-11T12:30:00.000Z' }))
      }
      const markFeedReadMs = ms(t)

      // ⑥ 每源列表（扫描族的结构性修复：WHERE feed_id = ? 走 i1 索引）
      const listRows = store.listItems(SAMPLE_FEED).length
      if (listRows !== PER) {
        // 量到空结果会报出一个漂亮却毫无意义的 0 ms。宁可不给数字，也不给假数字。
        throw new Error(`每源列表量到了 ${listRows} 行，应为 ${PER}：SAMPLE_FEED 与合成数据的键对不上？`)
      }
      const listTimes = []
      for (let i = 0; i < 50; i += 1) {
        const s = hr()
        store.listItems(SAMPLE_FEED)
        listTimes.push(ms(s))
      }

      // ⑦ 常驻堆：两次 GC 后。注意 db 本身不占 JS 堆（页面缓存在原生侧），
      //    这正是相对「整份进内存」的收益之一。
      if (typeof global.gc === 'function') { global.gc(); global.gc() }
      const heapMiB = process.memoryUsage().heapUsed / 1048576

      return {
        schemaMs: round(schemaMs),
        insertMs: round(insertMs),
        insertOneByOneMs: round(insertOneByOneMs),
        markReadItemMs: round(median(single)),
        markFeedReadMs: round(markFeedReadMs),
        markFeedReadExtrapolated: false,
        listItemsMs: round(median(listTimes)),
        listItemsRows: listRows,
        heapMiB: round(heapMiB),
      }
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function main() {
  const rows = buildRows()
  const json = measureJson(rows)
  const sqlite = await measureSqlite(rows)
  const result = { rows: N, feeds: FEEDS, perFeed: PER, json, sqlite, gcExposed: typeof global.gc === 'function' }

  if (AS_JSON) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    return
  }
  const target = sqlite.markFeedReadMs
  process.stdout.write(
    `规模基准（${N} 行 = ${FEEDS} 源 × ${PER} 条）\n\n` +
    `A. 现状：域 + single JSON\n` +
    `  文件            ${json.fileMiB} MiB（${json.bytesPerRow} B/行）\n` +
    `  打开            ${json.openMs} ms（parse ${json.parseMs} + zod ${json.zodMs}）\n` +
    `  整份重写        中位 ${json.rewriteMedianMs} ms / 峰值 ${json.rewriteMaxMs} ms\n` +
    `  一源全标已读    ${json.markFeedReadMs} ms（外推：${PER} × 重写中位）\n` +
    `  常驻堆          （与本路径同批数据，见 Task 1 基线 38.97 MiB）\n\n` +
    `B. 自持：node:sqlite + createSqliteStore（lib/ 产物）\n` +
    `  建库+建索引     ${sqlite.schemaMs} ms\n` +
    `  插入 ${N} 行      ${sqlite.insertMs} ms（单事务）\n` +
    `  逐条 saveItem   ${sqlite.insertOneByOneMs} ms/条\n` +
    `  单条标已读      ${sqlite.markReadItemMs} ms（中位，含读改写与事务）\n` +
    `  一源全标已读    ${sqlite.markFeedReadMs} ms（**实测**，${PER} 条）\n` +
    `  每源列表        ${sqlite.listItemsMs} ms / ${sqlite.listItemsRows} 行（WHERE feed_id = ?）\n` +
    `  常驻堆          ${sqlite.heapMiB} MiB\n\n` +
    `对照 spec §9.3 存储侧：打开 ≤200ms / 单条标已读 ≤20ms / **一源全标已读 ≤1s** / 常驻 ≤300MB\n` +
    `  ⇒ 一源全标已读 ${target} ms（${target <= 1000 ? '达标' : '**未达标**'}，\n` +
    `     改造前 ${json.markFeedReadMs} ms ⇒ 快 ${round(json.markFeedReadMs / Math.max(target, 0.01))}×）\n`,
  )
}

await main()
