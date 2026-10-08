/**
 * 默认视图决策的真值表。
 * 这是一个用户可见的分支行为，而客户端跑在浏览器里我测不到——所以把判断抽成纯函数钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickInitialRender, nextRender } from '../lib/article-view.js'

test('默认一律抽取版（2026-10-08 更正：不再「能嵌就默认原样」）', () => {
  // 曾经的规则是 frameable === true 就默认开原站视图。实测证明它错：原站视图的沙箱不给
  // allow-same-origin，框架内是不透明源，现代站点因此在启动早期抛错、样式全丢（只剩裸 HTML）。
  // 现在默认值与可嵌性无关 —— 这条用例钉住的正是「无关」这件事。
  assert.equal(pickInitialRender(), 'reading')
})

test('用户当次的选择优先于默认值（切过就尊重用户意图）', () => {
  assert.equal(pickInitialRender('original'), 'original')
  assert.equal(pickInitialRender('reading'), 'reading')
})

test('切换：可嵌时在两视图间往返', () => {
  assert.equal(nextRender('reading', true), 'original')
  assert.equal(nextRender('original', true), 'reading')
})

test('切换：不可嵌时保持不动（否则会进一个永远白屏的 iframe）', () => {
  assert.equal(nextRender('reading', false), 'reading')
  assert.equal(nextRender('original', false), 'original')
})
