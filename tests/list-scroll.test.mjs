/** 跟随滚动的边界行为：三种情况必须各归其位，且"已在视内"不得抖动。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  nextScrollTop, clampScrollTop, scanTop, pageTop, halfPageTop,
  scanStepFor, lineStepFrom, scrollSelectorFor, isElementNode, edgeTopFor, SCROLL_ATTR,
  LIST_ROW_STEP_FALLBACK, ARTICLE_LINE_STEP_FALLBACK,
} from '../lib/list-scroll.js'

const H = 300 // 容器可视高度

test('选中项已在视口内时不动（否则每按一次 j 都会抖）', () => {
  assert.equal(nextScrollTop(0, H, 50, 40), 0)
  assert.equal(nextScrollTop(0, H, 260, 40), 0) // 底边刚好贴住
  assert.equal(nextScrollTop(100, H, 150, 40), 100)
})

test('越出下边界：贴到底部，选中项完整可见', () => {
  // 行顶 320 + 高 40 = 360，超出 0+300 ⇒ 目标滚动位置 = 360-300 = 60
  assert.equal(nextScrollTop(0, H, 320, 40), 60)
  assert.equal(nextScrollTop(60, H, 400, 40), 140)
})

test('越出上边界：顶到容器顶部', () => {
  assert.equal(nextScrollTop(200, H, 150, 40), 150)
  assert.equal(nextScrollTop(200, H, 0, 40), 0)
})

test('单调性：向下移动时目标滚动位置不减小（不会来回跳）', () => {
  let top = 0
  for (let row = 0; row < 40; row += 1) {
    const next = nextScrollTop(top, H, row * 40, 40)
    assert.ok(next >= top, 'row ' + row + ' 处滚动位置回退了')
    top = next
  }
  assert.ok(top > 0, '长列表滚动到底部后应确实滚过了')
})
test('扫视 n/p：按一行滚动，方向正确', () => {
  assert.equal(scanTop(0, 40, 1000, 1), 40, 'n 应当向下滚一行')
  assert.equal(scanTop(200, 40, 1000, -1), 160, 'p 应当向上滚一行')
})

test('扫视 n/p：越界被夹住，不产生负值或超界', () => {
  assert.equal(scanTop(0, 40, 1000, -1), 0, '已在顶部再往上滚应当停在 0')
  assert.equal(scanTop(980, 40, 1000, 1), 1000, '到底部应当夹在上限')
})

test('翻页 空格/shift+空格：按一屏滚动并夹住边界', () => {
  assert.equal(pageTop(0, 300, 5000, 1), 300)
  assert.equal(pageTop(600, 300, 5000, -1), 300)
  assert.equal(pageTop(0, 300, 5000, -1), 0, '顶部再往上翻页应当停在 0')
  assert.equal(pageTop(4900, 300, 5000, 1), 5000, '接近底部应当夹在上限而不是越界')
})

test('半页 d/u：按半屏滚动并夹住边界', () => {
  assert.equal(halfPageTop(0, 300, 5000, 1), 150, 'd 应当向下滚半屏')
  assert.equal(halfPageTop(600, 300, 5000, -1), 450, 'u 应当向上滚半屏')
  assert.equal(halfPageTop(0, 300, 5000, -1), 0, '顶部再往上滚应当停在 0')
  assert.equal(halfPageTop(4900, 300, 5000, 1), 5000, '接近底部应当夹在上限')
  // 半页必须严格小于整页 —— 否则「另立一档」就没有意义，长文里照样跳过头
  assert.ok(halfPageTop(0, 300, 5000, 1) < pageTop(0, 300, 5000, 1), '半页必须比整页短')
})

test('容器选择器：列表/正文各一个，其他视图没有容器（订阅管理页不该刷警告）', () => {
  assert.equal(scrollSelectorFor('list'), '[' + SCROLL_ATTR + '="list"]')
  assert.equal(scrollSelectorFor('article'), '[' + SCROLL_ATTR + '="article"]')
  // undefined 与「选择器查不到节点」是两回事：前者静默，后者必须告警
  assert.equal(scrollSelectorFor('feeds'), undefined)
  assert.equal(scrollSelectorFor('nonsense'), undefined)
})

test('跳到文章一端：顶部为 0、底部为上限，且越界被夹住', () => {
  assert.equal(edgeTopFor(5000, 'top'), 0)
  assert.equal(edgeTopFor(5000, 'bottom'), 5000)
  // 内容不足一屏时 maxTop 是负数 —— 不能把它写进 scrollTop，由纯函数夹回 0
  assert.equal(edgeTopFor(-200, 'bottom'), 0, '不足一屏时「底部」就是 0')
  assert.equal(edgeTopFor(Number.NaN, 'bottom'), 0, 'NaN 不该写坏滚动位置')
  assert.equal(edgeTopFor(5000, 'top'), 0, '顶部恒定 0，与上限无关')
})

test('isElementNode：只看节点自身的形状，不依赖环境全局', () => {
  // 元素节点：nodeType === 1
  assert.equal(isElementNode({ nodeType: 1 }), true)
  // 非元素：文本节点(3)/注释(8)/文档(9)、null/undefined、普通对象、字符串
  for (const value of [{ nodeType: 3 }, { nodeType: 8 }, { nodeType: 9 }, null, undefined, {}, 'div', 42, []]) {
    assert.equal(isElementNode(value), false, JSON.stringify(value) + ' 不该被当成元素')
  }
  // ⚠️ 这条是本函数存在的理由：判定必须与「realm 里有没有 HTMLElement 全局」无关。
  // 历史故障：全局缺失时 instanceof 抛 ReferenceError，被事件派发吞掉 ⇒ 所有快捷键全哑且无日志。
  const saved = globalThis.HTMLElement
  try {
    // @ts-expect-error 故意移除全局，验证判定不依赖它（本文件是 .mjs，运行时才生效）
    delete globalThis.HTMLElement
    assert.equal(isElementNode({ nodeType: 1 }), true, '全局缺失时仍应认得出元素节点')
    assert.equal(isElementNode({ nodeType: 3 }), false)
  } finally {
    globalThis.HTMLElement = saved
  }
})

test('一行是多少像素：行高写倍数要乘字号，写 px 直接用', () => {
  assert.equal(lineStepFrom('16px', '1.85'), 29.6, '正文样式 16px × 1.85')
  assert.equal(lineStepFrom('16px', '24px'), 24, 'px 形式不该再乘字号')
  assert.equal(lineStepFrom(undefined, '1.85'), undefined)
  assert.equal(lineStepFrom('16px', undefined), undefined)
  assert.equal(lineStepFrom('0px', '1.85'), undefined, '字号为 0 视为量不到')
  assert.equal(lineStepFrom('16px', 'auto'), undefined, 'auto 不是行高数值')
})

test('逐行扫视的步长按视图分流（正文页此前退化成硬编码 48px = 一行半）', () => {
  // 列表：用条目行高
  assert.equal(scanStepFor('list', { rowHeight: 40 }), 40)
  // 正文：用正文行高，绝不回落到列表的 48
  assert.equal(scanStepFor('article', { lineHeight: 29.6 }), 29.6)
  // 量不到时各用各的兜底
  assert.equal(scanStepFor('list', {}), LIST_ROW_STEP_FALLBACK)
  assert.equal(scanStepFor('article', {}), ARTICLE_LINE_STEP_FALLBACK)
  // 关键不变量：正文页即使只量到了「列表行高」也不许用它 —— 那正是原来的病
  assert.notEqual(scanStepFor('article', { rowHeight: 48 }), LIST_ROW_STEP_FALLBACK)
  // 非法值不产生 NaN
  for (const step of [scanStepFor('list', { rowHeight: Number.NaN }), scanStepFor('article', { lineHeight: -1 })]) {
    assert.equal(Number.isFinite(step), true)
  }
})

test('扫视步长量不到时不动（不再回落到「看起来能动」的常数）', () => {
  assert.equal(scanTop(100, 0, 1000, 1), 100, '步长 0 应当原地不动')
  assert.equal(scanTop(100, Number.NaN, 1000, 1), 100, 'NaN 步长应当原地不动')
})

test('滚动计算对非法输入免疫（NaN/0/负数不该把滚动条写坏）', () => {
  assert.equal(clampScrollTop(Number.NaN, 100), 0, 'NaN 必须归零，否则浏览器里滚动条会乱跳')
  assert.equal(clampScrollTop(50, Number.NaN), 0, '上限非法时视为不可滚动')
  assert.equal(clampScrollTop(-20, 100), 0)
  assert.equal(clampScrollTop(500, 100), 100)
  // 行高/视口高度缺失时用兜底步长，而不是产生 NaN
  assert.equal(Number.isFinite(scanTop(0, Number.NaN, 1000, 1)), true)
  assert.equal(Number.isFinite(pageTop(0, Number.NaN, 1000, 1)), true)
})

/**
 * 两列布局之后（2026-10-10 任务 4）：左栏自己也是 overflowY: auto 的可滚动容器，
 * 但滚动按键靠**标记属性**定位，而左栏打的是 data-rss-nav。
 *
 * 为什么值得再钉一次：读者眼里「左栏能滚」与「滚动键会去滚左栏」只差一个属性名，
 * 而后者在界面上表现为「按键毫无反应」——最贵的那类沉默失败（本仓库 2026-10-09 的
 * 详情页空格即同一族故障）。本用例把语义钉在选择器这一层；真 DOM 层的判据在
 * tests/scroll-dom.test.mjs 的「滚动不误命中左栏」。
 */
test('两列后：列表类视图共用右栏容器选择器，feeds 仍无容器', () => {
  assert.equal(scrollSelectorFor('list'), '[' + SCROLL_ATTR + '="list"]')
  // undefined 与「选择器查不到节点」是两回事：前者静默（订阅管理页不该刷警告），后者必须告警
  assert.equal(scrollSelectorFor('feeds'), undefined)
})
