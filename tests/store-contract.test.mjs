/**
 * 票据 01 的执行入口：同一组契约跑三份实现（内存替身待票据 02 补齐后接入）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contractCases, sqliteImpl, legacyImpl, memoryImpl } from './helpers/reader-store-contract.mjs'

for (const impl of [sqliteImpl(), legacyImpl(), memoryImpl()]) {
  test('ReaderStore 契约 · ' + impl.label, async (t) => {
    for (const contractCase of contractCases) {
      await t.test(contractCase.name, async () => {
        const handle = await impl.open()
        try {
          await contractCase.run(handle)
        } finally {
          await handle.dispose()
        }
      })
    }
  })
}

test('契约守门：空实现必须让每一条都翻红（否则这套契约就是自说自话）', async () => {
  const broken = { label: 'empty', async open() { return { store: {}, async dispose() {} } } }
  let failed = 0
  for (const contractCase of contractCases) {
    const handle = await broken.open()
    try {
      await contractCase.run(handle)
    } catch {
      failed += 1
    }
  }
  assert.equal(failed, contractCases.length, '每一条契约都必须至少调用一个 ReaderStore 方法')
})

/**
 * —— 内存替身与生产实现的字符口径逐条相等（R5 04）——
 *
 * 为什么单独一条：`articleCharsOf` 是「有 paragraphs 就只算 paragraphs，否则算 blocks」（二选一），
 * 而内存替身 `listArticleCacheEntries` 原先写成**两者相加**。经 `normalizeLegacyArticle` 之后
 * 并存不该出现，但 `articleRecordSchema` 允许 —— 于是同一份记录在两个实现上会得到不同的字符数，
 * 缓存淘汰的顺序随之不同。收口办法是让替身**直接调** `articleCharsOf`（第一等实现），
 * 而不是在替身里再写一遍判据。
 */
test('内存替身：listArticleCacheEntries 的 chars 与 articleCharsOf 逐条相等（含表格与并存夹具）', async () => {
  const { createMemoryStore } = await import('../lib/memory-store.js')
  const { articleCharsOf } = await import('../lib/retention.js')
  const store = createMemoryStore()
  const base = { feedId: 'f1', link: 'https://a.example/', fetchedAt: '2026-11-01T00:00:00.000Z', starred: false }
  // 夹具一：并存（paragraphs + blocks）—— 二选一的实现只算 3，相加的实现会算 3 + 12
  await store.saveItem('both', {
    ...base, title: 'both',
    article: {
      fetchedAt: '2026-11-01T00:00:00.000Z',
      paragraphs: ['一二三'],
      blocks: [{ kind: 'table', header: ['参数', '值'], rows: [['电压', '220V']] }],
    },
  })
  // 夹具二：只有 blocks 且含表格 —— 表格必须计入（12 字）
  await store.saveItem('table-only', {
    ...base, title: 'table-only',
    article: { fetchedAt: '2026-11-01T00:00:00.000Z', blocks: [{ kind: 'table', header: ['参数', '值'], rows: [['电压', '220V']] }] },
  })
  const entries = new Map(store.listArticleCacheEntries().map((entry) => [entry.id, entry.chars]))
  assert.equal(entries.get('both'), articleCharsOf(store.item('both').article), '并存夹具必须与唯一口径相等')
  assert.equal(entries.get('both'), 3, '有 paragraphs 时只算 paragraphs（二选一，不是相加）')
  assert.equal(entries.get('table-only'), 12, '表格的字符必须算进去')
  assert.equal(entries.get('table-only'), articleCharsOf(store.item('table-only').article), '含表格夹具与唯一口径相等')
})
