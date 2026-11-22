/**
 * overview 的 ItemView 作者投影（R12 评审补判据）。
 *
 * 为什么单独一个文件：`src/endpoints.ts` 的 `author: item.author` 是**唯一**的生产 ItemView
 * 投影；R12 落地时没有任何用例钉它 —— 删掉这一行，其余套件仍然全绿。这里用真实 SQLite store
 * + 真 dispatch 从两侧钉住：
 *   ① 写入侧存了作者 ⇒ overview 回包原样带出（删投影即翻红，也是变异 `endpoint-overview 丢作者` 的判据）；
 *   ② 直接 SQL 把 author 改成 '' ⇒ 回包 undefined（读侧归一化在 toItemRecord，列表行不会出现空段，验收 21）。
 * 复用 freshRows 夹具（真库 + 真 config），不另造一套。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { createDispatch } from '../lib/endpoints.js'
import { Config } from '../lib/config.js'
import { deps, freshRows } from './helpers/reader-store-memory.mjs'

const ROUND = '2026-11-20T09:00:00.000Z'

/** 取一次 overview，失败被当成空数据糊过去是最难查的一类假绿。 */
async function overview(store) {
  const result = await createDispatch(deps(store, Config({})))('overview', {})
  assert.equal(result.ok, true, 'overview 应当成功：' + JSON.stringify(result))
  return result.value
}

test('R12 overview：ItemView 的 author 原样带出（唯一生产投影）', async () => {
  const { store, db, dir } = freshRows('author-projection', [{ id: 'authored', recency: ROUND }])
  try {
    await store.updateItem('authored', (current) => ({ ...current, author: '张三' }))
    const view = await overview(store)
    const row = view.items.find((item) => item.id === 'authored')
    assert.ok(row !== undefined, '前置条件：条目必须在 overview 第一页里')
    assert.equal(row.author, '张三', 'overview 的 ItemView 必须带出 author（store 映射之外的唯一生产投影）')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R12 overview：直接改库留下的空串作者不会在列表投影里变成空段', async () => {
  const { store, db, dir } = freshRows('author-blank-projection', [{ id: 'blank', recency: ROUND }])
  try {
    await store.updateItem('blank', (current) => ({ ...current, author: '李四' }))
    db.prepare("UPDATE items SET author = '' WHERE id = ?").run('blank')
    const view = await overview(store)
    const row = view.items.find((item) => item.id === 'blank')
    assert.ok(row !== undefined, '前置条件：条目必须在 overview 第一页里')
    assert.equal(row.author, undefined, '空串必须在读侧归一成 undefined，否则列表行会多出一个空作者段（验收 21）')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
