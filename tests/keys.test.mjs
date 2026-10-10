/**
 * 键盘映射的单测：钉住「标签怎么写、键就该怎么认」。
 * 起因是一次真实故障——按钮标签写“（R）”，实现却只认 shift+R，用户按小写 r 毫无反应。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveReaderKey } from '../lib/keys.js'

test('键位：r 刷新计数；w/W 已空出且不得被偷偷接管（2026-10-08）', () => {
  // 2026-10-08 改键：r 归还给「刷新未读计数」（规格 §5 不变量 8），视图切换移到 w/W。
  // 标签（article-pane 的「（W）」）已同步改，免得又出现「标签与实现各说各话」。
  assert.equal(resolveReaderKey('r'), 'refreshCount')
  assert.equal(resolveReaderKey('R'), 'refreshCount')
  // w/W 于 2026-10-08 空出：原站视图（iframe）整条路径已删除。留空的键必须如实解析成 none ——
  // 谁想重新占用它，就得先在这条断言上留下痕迹（这是「键位不被偷偷改派」的守护）。
  assert.equal(resolveReaderKey('w'), 'none')
  assert.equal(resolveReaderKey('W'), 'none')
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
  // 2026-10-10 用户拍板 A 方案：大写 N/P 由「一律不绑」改为 GR 的导航键（§3.8 第 209 行）。
  // 这两条断言原来写的是 N/P === 'none'，改派是键位决策的直接结果、不是放宽 ——
  // 真正的风险（shift+n 抢走小写 n 的扫视语义）由下面「小写 n/p 不被抢占」那条继续看着。
  assert.equal(resolveReaderKey('N'), 'navNext')
  assert.equal(resolveReaderKey('P'), 'navPrev')
})

test('空格翻页：必须用 shift 标志分辨方向（空格本身大小写不敏感）', () => {
  assert.equal(resolveReaderKey(' '), 'pageDown', '空格应当向下翻页')
  assert.equal(resolveReaderKey(' ', true), 'pageUp', 'shift+空格应当向上翻页')
})

test('半页：d 向下、shift+d 向上（u 于 2026-10-10 归还 GR 原义）', () => {
  assert.equal(resolveReaderKey('d'), 'halfPageDown', 'd 向下半页不变')
  // 2026-10-10 用户拍板 A 方案：u 归还 GR 原义「订阅列表显隐」（GR spec §3.8 第 250 行），
  // 原本由 u 承担的上半页改由 shift+d 接盘（d 向下不变，上/下同键最省记忆）。
  // ⚠️ 「u 应当向上翻半页」是本轮被改派的既有断言；改派是决策的直接结果，不是放宽。
  assert.equal(resolveReaderKey('u'), 'toggleNav', 'u 现在是左栏显隐')
  assert.equal(resolveReaderKey('d', true), 'halfPageUp', 'shift+d 接盘向上半页')
  // 真实浏览器按 shift+d 给的是大写 'D'（不是小写 + shift 标志）——只认 ('d', true) 会让真机上
  // shift+d 静默无反应，正是「标签写着 R、实现只认 shift+R」那类缺陷（见 keys.ts 头部注释）。
  assert.equal(resolveReaderKey('D', true), 'halfPageUp', '真机上 shift+d 给的是大写 D')
  // 不带 shift 的大写只可能来自 CapsLock：仍不做事（沿用本条原有的误触约定）；
  // U 不再有绑定（u 已改归左栏显隐，大写不需要第二个入口）。
  assert.equal(resolveReaderKey('D'), 'none')
  assert.equal(resolveReaderKey('U'), 'none')
  // 半页若与整页解析成同一个动作，「另立一档」在键位层就退化了
  assert.notEqual(resolveReaderKey('d'), resolveReaderKey(' '))
  assert.notEqual(resolveReaderKey('d', true), resolveReaderKey(' ', true))
})

test('未绑定的键一律返回 none（不误触发）', () => {
  // 2026-10-10：N/P 从这份名单移出（已改派为导航键 navNext/navPrev）
  for (const key of ['q', 'z', 'Enter', 'F1', '阿', 'Shift', 'ArrowDown']) {
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

/**
 * 任务 6（2026-10-10 用户拍板 A 方案）：u 归还 GR 原义 + 补 GR 的三个导航键。
 *
 * GR spec §3.8 的三行原文：
 *  - 第 209 行 shift-n / shift-p 「navigation down/up」= 在**导航里**移动选中（不是文章列表）
 *  - 第 212 行 shift-o「navigation open subscription」= 打开导航中选中项
 *  - 第 250 行 u「订阅列表显隐」
 * 本仓库此前把 u 自加为「向上半页」（vim Ctrl-u 去掉 ctrl），与 GR 原义冲突，故归还。
 */
test('u 归还 GR 原义：左栏显隐', () => {
  assert.equal(resolveReaderKey('u'), 'toggleNav')
})

test('向上半页改由 shift+d 承担', () => {
  assert.equal(resolveReaderKey('d', true), 'halfPageUp')
  assert.equal(resolveReaderKey('d'), 'halfPageDown')
})

test('导航键 shift+n/p/o', () => {
  assert.equal(resolveReaderKey('N'), 'navNext')
  assert.equal(resolveReaderKey('P'), 'navPrev')
  assert.equal(resolveReaderKey('O'), 'navOpen')
})

test('小写 n/p/o 仍是原语义，不被导航键抢占', () => {
  assert.equal(resolveReaderKey('n'), 'scanNext')
  assert.equal(resolveReaderKey('o'), 'expand')
  // p 同理：小写必须是扫视（brief 只列了 n/o，这里补 p，否则「不被抢占」在 p 上无判据）
  assert.equal(resolveReaderKey('p'), 'scanPrev')
})
