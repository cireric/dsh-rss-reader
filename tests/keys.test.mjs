/**
 * 键盘映射的单测：钉住「标签怎么写、键就该怎么认」。
 * 起因是一次真实故障——按钮标签写“（R）”，实现却只认 shift+R，用户按小写 r 毫无反应。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveReaderKey } from '../lib/keys.js'

test('视图切换键：r 与 R 都要认（标签写 R 就不能要求 shift）', () => {
  assert.equal(resolveReaderKey('r'), 'toggleRender')
  assert.equal(resolveReaderKey('R'), 'toggleRender')
})

test('v 与 V 是刻意区分的一对：外部浏览器 vs 阅读器内读正文', () => {
  assert.equal(resolveReaderKey('v'), 'openExternal')
  assert.equal(resolveReaderKey('V'), 'openArticle')
})

test('核心导航与 GR 约定', () => {
  assert.equal(resolveReaderKey('j'), 'next')
  assert.equal(resolveReaderKey('k'), 'prev')
  assert.equal(resolveReaderKey('o'), 'expand')
  assert.equal(resolveReaderKey('s'), 'star')
  assert.equal(resolveReaderKey('m'), 'toggleRead')
  assert.equal(resolveReaderKey('Escape'), 'back')
  // GR 里「全部标记已读」就是 shift+a，故只认大写
  assert.equal(resolveReaderKey('A'), 'markAll')
  assert.equal(resolveReaderKey('a'), 'none')
})

test('未绑定的键一律返回 none（不误触发）', () => {
  for (const key of ['q', 'z', 'Enter', ' ', 'F1', '阿', 'Shift', 'ArrowDown']) {
    assert.equal(resolveReaderKey(key), 'none', key + ' 不该被绑定')
  }
})
