/**
 * 默认视图决策的真值表。
 * 这是一个用户可见的分支行为，而客户端跑在浏览器里我测不到——所以把判断抽成纯函数钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickInitialRender, nextRender } from '../lib/article-view.js'

test('可嵌站点：默认直接开原站视图（用户要的体验）', () => {
  assert.equal(pickInitialRender(true), 'original')
})

test('不可嵌站点：回落到阅读视图', () => {
  assert.equal(pickInitialRender(false), 'reading')
})

test('可嵌性未知（抓取失败/字段缺失）：保守回落到阅读视图', () => {
  // 老缓存没有 frameable 字段时就是这种情形——宁可显示抽取版，也不要给一个白屏的 iframe
  assert.equal(pickInitialRender(undefined), 'reading')
})

test('用户当次的选择优先于任何默认值', () => {
  assert.equal(pickInitialRender(true, 'reading'), 'reading')
  assert.equal(pickInitialRender(false, 'original'), 'original')
})

test('切换：可嵌时在两视图间往返', () => {
  assert.equal(nextRender('reading', true), 'original')
  assert.equal(nextRender('original', true), 'reading')
})

test('切换：不可嵌时保持不动（否则会进一个永远白屏的 iframe）', () => {
  assert.equal(nextRender('reading', false), 'reading')
  assert.equal(nextRender('original', false), 'original')
})
