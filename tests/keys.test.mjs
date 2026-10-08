/**
 * 键盘映射的单测：钉住「标签怎么写、键就该怎么认」。
 * 起因是一次真实故障——按钮标签写“（R）”，实现却只认 shift+R，用户按小写 r 毫无反应。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveReaderKey } from '../lib/keys.js'

test('键位：r 刷新计数、w 切视图（2026-10-08 改键，标签同步改了）', () => {
  // 2026-10-08 改键：r 归还给「刷新未读计数」（规格 §5 不变量 8），视图切换移到 w/W。
  // 标签（article-pane 的「（W）」）已同步改，免得又出现「标签与实现各说各话」。
  assert.equal(resolveReaderKey('r'), 'refreshCount')
  assert.equal(resolveReaderKey('R'), 'refreshCount')
  assert.equal(resolveReaderKey('w'), 'toggleRender')
  assert.equal(resolveReaderKey('W'), 'toggleRender')
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

test('n/p 是扫视（滚动视野但不改选中），与 j/k 正交', () => {
  assert.equal(resolveReaderKey('n'), 'scanNext')
  assert.equal(resolveReaderKey('p'), 'scanPrev')
  // 关键：n/p 与 j/k 必须是不同的动作，否则「只看不动」这个能力就没了
  assert.notEqual(resolveReaderKey('n'), resolveReaderKey('j'))
  assert.notEqual(resolveReaderKey('p'), resolveReaderKey('k'))
  // 大写 N/P 不该被绑定（避免与 GR 的 shift+n/p 翻页混淆）
  assert.equal(resolveReaderKey('N'), 'none')
  assert.equal(resolveReaderKey('P'), 'none')
})

test('空格翻页：必须用 shift 标志分辨方向（空格本身大小写不敏感）', () => {
  assert.equal(resolveReaderKey(' '), 'pageDown', '空格应当向下翻页')
  assert.equal(resolveReaderKey(' ', true), 'pageUp', 'shift+空格应当向上翻页')
})

test('未绑定的键一律返回 none（不误触发）', () => {
  for (const key of ['q', 'z', 'Enter', 'F1', '阿', 'Shift', 'ArrowDown', 'N', 'P']) {
    assert.equal(resolveReaderKey(key), 'none', key + ' 不该被绑定')
  }
})
test('订阅管理键：f 与 F 都要认（标签写的是「F」）', () => {
  assert.equal(resolveReaderKey('f'), 'manageFeeds')
  assert.equal(resolveReaderKey('F', true), 'manageFeeds', '标签写 F，按 Shift+F 也必须能用')
})

test('1 / 2 切视图密度（GR 原键位：1 = expanded view、2 = list view）', () => {
  assert.equal(resolveReaderKey('1'), 'expandedView')
  assert.equal(resolveReaderKey('2'), 'listView')
})
