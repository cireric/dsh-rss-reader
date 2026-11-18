/**
 * shared.ts 的边界判据（2026-11-18 规则归位）。
 *
 * 为什么钉这个：导航性重构没有行为判据——规则搬出去之后，下一个人完全可能因为「顺手」把
 * `sanitizeViewPreferences` 或游标协议再塞回 shared.ts，而所有行为测试照样全绿。
 * 这里只钉**最容易悄悄回流的三处**，不维护完整的依赖图（那会随每次新增导出而维护）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const shared = readFileSync('src/shared.ts', 'utf8')

test('shared.ts 只留 wire 契约与纯工具：规则模块不许回流', () => {
  for (const needle of [
    'export function sanitizeViewPreferences(',
    'export interface Cursor {',
    'export const isUnread',
    'export function countUnreadPerFeed(',
    'export function recencyOf(',
  ]) {
    assert.ok(!shared.includes(needle), '规则回流 shared.ts：' + needle)
  }
  // 反向前提：wire 形状必须还在（否则这条测试只是在断言一个空文件）
  assert.ok(shared.includes('export interface Overview'), 'Overview 必须还在 shared.ts（wire 形状）')
})

test('规则模块存在且导出各自的判据', () => {
  const cursor = readFileSync('src/cursor.ts', 'utf8')
  const preferences = readFileSync('src/preferences.ts', 'utf8')
  const unread = readFileSync('src/unread.ts', 'utf8')
  assert.ok(cursor.includes('export function encodeCursor(') && cursor.includes('export interface Cursor'))
  assert.ok(preferences.includes('export function sanitizeViewPreferences('))
  assert.ok(unread.includes('export const isUnread') && unread.includes('export interface UnreadAccount'))
})
