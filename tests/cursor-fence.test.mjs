/**
 * 查询条件栅栏（src/cursor-fence.ts）：搜索端点与 agent 搜索工具共用的协议。
 *
 * 这里钉的是**协议不变量**（不是某个调用方）：同一个查询键稳定、前缀不符/形状不符一律 mismatch、
 * 到底保持 undefined。调用方的行为判据仍在 search.test / tools.test 里。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeFencedCursor, encodeFencedCursor, queryFenceKey } from '../lib/cursor-fence.js'

test('queryFenceKey：同一份 parts 稳定、不同 parts 不同、带尾部分隔符', () => {
  const a = queryFenceKey(['text', true, ['f2', 'f1']])
  const b = queryFenceKey(['text', true, ['f2', 'f1']])
  const c = queryFenceKey(['text', false, ['f2', 'f1']])
  assert.equal(a, b, '同一份查询条件必须得到同一个键')
  assert.notEqual(a, c, '条件变了键必须变')
  assert.match(a, /^[A-Za-z0-9_-]+:$/, '键是 base64url + 冒号')
})

test('decodeFencedCursor：undefined 是第一页，前缀/形状不对一律 mismatch', () => {
  const key = queryFenceKey(['q'])
  const cursor = '2026-11-18T00:00:00.000Z|item-1'
  assert.deepEqual(decodeFencedCursor(key, undefined), { status: 'ok' }, '没有游标 = 第一页')
  assert.deepEqual(decodeFencedCursor(key, key + cursor), { status: 'ok', inner: cursor })
  assert.deepEqual(decodeFencedCursor(key, queryFenceKey(['other']) + cursor), { status: 'mismatch' }, '换查询条件必须失配')
  assert.deepEqual(decodeFencedCursor(key, key + 'garbage'), { status: 'mismatch' })
  assert.deepEqual(decodeFencedCursor(key, key), { status: 'mismatch' }, '只有前缀没有游标体')
  assert.deepEqual(decodeFencedCursor(key, ''), { status: 'mismatch' }, '空串不许当成第一页')
})

test('encodeFencedCursor：到底保持 undefined，否则拼回前缀', () => {
  const key = queryFenceKey(['q'])
  const cursor = '2026-11-18T00:00:00.000Z|item-1'
  assert.equal(encodeFencedCursor(key, undefined), undefined)
  assert.equal(encodeFencedCursor(key, cursor), key + cursor)
})
