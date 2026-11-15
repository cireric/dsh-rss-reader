/**
 * 票据 01 的执行入口：同一组契约跑三份实现（内存替身待票据 02 补齐后接入）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contractCases, sqliteImpl, legacyImpl } from './helpers/reader-store-contract.mjs'

for (const impl of [sqliteImpl(), legacyImpl()]) {
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
