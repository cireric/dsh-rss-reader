/** 跟随滚动的边界行为：三种情况必须各归其位，且"已在视内"不得抖动。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextScrollTop, clampScrollTop, scanTop, pageTop } from '../lib/list-scroll.js'

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

test('滚动计算对非法输入免疫（NaN/0/负数不该把滚动条写坏）', () => {
  assert.equal(clampScrollTop(Number.NaN, 100), 0, 'NaN 必须归零，否则浏览器里滚动条会乱跳')
  assert.equal(clampScrollTop(50, Number.NaN), 0, '上限非法时视为不可滚动')
  assert.equal(clampScrollTop(-20, 100), 0)
  assert.equal(clampScrollTop(500, 100), 100)
  // 行高/视口高度缺失时用兜底步长，而不是产生 NaN
  assert.equal(Number.isFinite(scanTop(0, Number.NaN, 1000, 1)), true)
  assert.equal(Number.isFinite(pageTop(0, Number.NaN, 1000, 1)), true)
})
