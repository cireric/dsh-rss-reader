/**
 * 保留与清理策略的单测。这些都是「删数据」的规则，必须逐条钉住边界：
 * 星标被误删、未读被误删、近期已读被误删，都是用户会真实感到损失的错误。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectPrunable, selectArticleEvictions, selectCleanup } from '../lib/retention.js'

const row = (id, recency, { starred = false, read = false } = {}) => ({ id, starred, read, recency })

test('裁剪：未超上限时一条都不删', () => {
  assert.deepEqual(selectPrunable([row('a', '2026-01-01')], 5), [])
  assert.deepEqual(selectPrunable([], 5), [])
  assert.deepEqual(selectPrunable([row('a', '1'), row('b', '2')], 2), [])
})

test('裁剪：优先删未读，且从最旧的开始', () => {
  const rows = [row('new-read', '2026-03-01', { read: true }), row('old-unread', '2026-01-01'), row('mid-unread', '2026-02-01')]
  // 超 1 条 ⇒ 删最旧的未读
  assert.deepEqual(selectPrunable(rows, 2), ['old-unread'])
  // 超 2 条 ⇒ 两个未读都删，即便有更旧的已读也不动它
  assert.deepEqual(selectPrunable(rows, 1), ['old-unread', 'mid-unread'])
})

test('裁剪：星标条目永不被删——哪怕它最旧、哪怕超额最多', () => {
  const rows = [row('star-old', '2026-01-01', { starred: true }), row('plain', '2026-02-01'), row('read', '2026-03-01', { read: true })]
  const picked = selectPrunable(rows, 1)
  assert.ok(!picked.includes('star-old'), '星标条目被删了')
  assert.deepEqual(picked, ['plain', 'read'], '非星标的两条都该删')
})

test('裁剪：星标占满时宁可超上限也不删（返回数量少于溢出量）', () => {
  const rows = [row('s1', '2026-01-01', { starred: true }), row('s2', '2026-01-02', { starred: true })]
  assert.deepEqual(selectPrunable(rows, 1), [], '没有可删对象时不得动星标')
})

test('裁剪：未读用尽后才轮到已读（已读是最后手段）', () => {
  const rows = [row('u', '2026-01-01'), row('r1', '2026-01-02', { read: true }), row('r2', '2026-01-03', { read: true })]
  assert.deepEqual(selectPrunable(rows, 2), ['u'])
  assert.deepEqual(selectPrunable(rows, 1), ['u', 'r1'])
})

test('正文缓存：未超上限不清；上限非法一律视为不清理', () => {
  const entries = [{ id: 'a', chars: 100, fetchedAt: '2026-01-01' }]
  assert.deepEqual(selectArticleEvictions(entries, 200), [])
  assert.deepEqual(selectArticleEvictions(entries, 0), [], '上限 0 视为未配置，不该清空')
  assert.deepEqual(selectArticleEvictions(entries, -5), [])
})

test('正文缓存：超限时从最旧开始清，清到刚好达标即停', () => {
  const entries = [
    { id: 'old', chars: 300, fetchedAt: '2026-01-01' },
    { id: 'mid', chars: 300, fetchedAt: '2026-02-01' },
    { id: 'new', chars: 300, fetchedAt: '2026-03-01' },
  ]
  // 总量 900，上限 600 ⇒ 清 1 条即达标
  assert.deepEqual(selectArticleEvictions(entries, 600), ['old'])
  // 上限 350 ⇒ 要清到剩 300，即清两条
  assert.deepEqual(selectArticleEvictions(entries, 350), ['old', 'mid'])
  // 上限 1000 ⇒ 不动
  assert.deepEqual(selectArticleEvictions(entries, 1000), [])
})

test('显式清理：三个条件缺一不可', () => {
  const cutoff = '2026-06-01T00:00:00.000Z'
  const rows = [
    { ...row('keep-unread', '2026-01-01'), articleChars: 0 },
    { ...row('keep-starred', '2026-01-01', { read: true, starred: true }), articleChars: 0 },
    { ...row('keep-recent', '2026-07-01', { read: true }), articleChars: 0 },
    { ...row('delete-me', '2026-01-01', { read: true }), articleChars: 5000 },
  ]
  assert.deepEqual(selectCleanup(rows, cutoff), ['delete-me'])
})

test('显式清理：边界是严格早于阈值（等于阈值不清）', () => {
  const cutoff = '2026-06-01T00:00:00.000Z'
  const equal = [{ ...row('exactly', cutoff, { read: true }), articleChars: 0 }]
  assert.deepEqual(selectCleanup(equal, cutoff), [], '恰好等于阈值不该被清')
})
