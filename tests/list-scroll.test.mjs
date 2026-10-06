/** 跟随滚动的边界行为：三种情况必须各归其位，且"已在视内"不得抖动。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextScrollTop } from '../lib/list-scroll.js'

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
