/**
 * 视口选批与整篇计划（R7 04，spec §4.3 / §5.5 / 验收 3/4/5/6）。
 *
 * 这一层刻意不碰 DOM：`pickBatch` 的入参只有矩形、已翻索引与每块字符数，所以「空可见集退化 /
 * 块比视口长 / 跨批续选 / 12 块 2000 字符 / 2000–6000 独占 / >6000 跳过 / 30000 边界」都能在
 * 没有 jsdom 的进程里直接钉住。DOM 只负责量矩形（见 translate-progress.test.mjs）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  articleTranslatePlanOf,
  pickBatch,
  TRANSLATE_ARTICLE_MAX_CHARS,
  TRANSLATE_BATCH_MAX_BLOCKS,
  TRANSLATE_BATCH_MAX_CHARS,
  TRANSLATE_BLOCK_MAX_CHARS,
} from '../lib/translate-blocks.js'

const RECT = (top, bottom, left = 0, right = 600) => ({ top, bottom, left, right })
/** 视口：竖直 0..500。 */
const CONTAINER = RECT(0, 500)

/** 生成 count 个按文档顺序、彼此不重叠的块矩形；`topOf` 决定它们在视口内还是外。 */
function geometriesOf(count, topOf = (index) => 10 + index * 100) {
  return Array.from({ length: count }, (_, index) => {
    const top = topOf(index)
    return { index, rect: RECT(top, top + 50) }
  })
}

function pick({ count, chars, translated = [], container = CONTAINER, topOf } = {}) {
  return pickBatch({
    rects: geometriesOf(count, topOf),
    container,
    translated: new Set(translated),
    chars,
  })
}

test('空可见集（停在顶部 / 尚未渲染完）⇒ 从第一个可翻块开始取一批', () => {
  // 所有块都在视口下方：可见集为空，必须退化到文档顺序的第一批，而不是返回空数组。
  const batch = pick({ count: 3, chars: [10, 10, 10], topOf: (index) => 900 + index * 100 })
  assert.deepEqual(batch, [0, 1, 2])
})

test('块比视口长（矩形完全覆盖视口）也算可见，且按文档顺序排第一批', () => {
  const batch = pickBatch({
    rects: [
      // 0 号块从视口上方一直延伸到视口下方（比 500px 的视口长）；1 号块在视口外。
      { index: 0, rect: RECT(-1000, 2000) },
      { index: 1, rect: RECT(900, 950) },
    ],
    container: CONTAINER,
    translated: new Set(),
    chars: [10, 10],
  })
  assert.deepEqual(batch, [0], '只有 0 号可见，1 号不能因为「不在视口」被跳过而混进第一批')
})

test('跨批续选：已翻块跳过，从剩余第一个块继续', () => {
  // 0/1 已翻且仍在视口里 —— 不能因为「可见集非空」就返回已翻块，也不能直接卡住。
  const batch = pick({
    count: 4,
    chars: [10, 10, 10, 10],
    translated: [0, 1],
    topOf: (index) => (index < 2 ? 10 + index * 60 : 900 + index * 100),
  })
  assert.deepEqual(batch, [2, 3])
})

test('一批最多 12 块：第 13 块留给下一批', () => {
  assert.equal(TRANSLATE_BATCH_MAX_BLOCKS, 12)
  const chars = Array.from({ length: 13 }, () => 100)
  const first = pick({ count: 13, chars, topOf: () => 900 })
  assert.deepEqual(first, Array.from({ length: 12 }, (_, index) => index))
  const second = pick({
    count: 13,
    chars,
    translated: first,
    topOf: () => 900,
  })
  assert.deepEqual(second, [12], '已翻的 12 块必须跳过')
})

test('一批最多 2000 字符：恰好 2000 收下，多 1 个字符就切到下一批', () => {
  assert.equal(TRANSLATE_BATCH_MAX_CHARS, 2000)
  assert.deepEqual(pick({ count: 3, chars: [1000, 1000, 1], topOf: () => 900 }), [0, 1])
  assert.deepEqual(pick({ count: 3, chars: [1000, 1001, 1000], topOf: () => 900 }), [0])
  assert.deepEqual(
    pick({ count: 3, chars: [1000, 1001, 1000], translated: [0], topOf: () => 900 }),
    [1],
    '下一批从剩余第一个块继续（1001 + 1000 超过 2000，只能装 1 号）',
  )
})

test('单块 2000 < 字符 ≤ 6000 ⇒ 独占一批（该批放宽到 6000）', () => {
  assert.equal(TRANSLATE_BLOCK_MAX_CHARS, 6000)
  // 2500 字的块后面跟着两个短块：长块只能一个人一批，后面的块不许被吸进来。
  assert.deepEqual(pick({ count: 3, chars: [2500, 10, 10], topOf: () => 900 }), [0])
  assert.deepEqual(
    pick({ count: 3, chars: [2500, 10, 10], translated: [0], topOf: () => 900 }),
    [1, 2],
  )
  // 短块在前、长块在后：短块先成一批，遇到长块就截断（不能跳过它继续装后面的短块）。
  assert.deepEqual(pick({ count: 3, chars: [100, 3000, 100], topOf: () => 900 }), [0])
  assert.deepEqual(
    pick({ count: 3, chars: [100, 3000, 100], translated: [0], topOf: () => 900 }),
    [1],
  )
})

test('单块 > 6000 ⇒ 不进任何批，也不占用批内名额', () => {
  const batch = pick({ count: 3, chars: [7000, 10, 10], topOf: () => 900 })
  assert.deepEqual(batch, [1, 2], '7000 字的块必须跳过，10 字的块照常成批')
})

test('整篇计划：30000 字符正常、30001 拒绝（> 而不是 >=）', () => {
  assert.equal(TRANSLATE_ARTICLE_MAX_CHARS, 30000)
  const atLimit = Array.from({ length: 15 }, () => ({ kind: 'p', text: '字'.repeat(2000) }))
  const planAtLimit = articleTranslatePlanOf(atLimit)
  assert.equal(planAtLimit.chars, 30000)
  assert.equal(planAtLimit.tooLong, false, '恰好 30000 必须放行')
  assert.equal(planAtLimit.totalBlocks, 15)

  const over = [
    ...Array.from({ length: 14 }, () => ({ kind: 'p', text: '字'.repeat(2000) })),
    { kind: 'p', text: '字'.repeat(2001) },
  ]
  const planOver = articleTranslatePlanOf(over)
  assert.equal(planOver.chars, 30001)
  assert.equal(planOver.tooLong, true, '30001 必须拒绝')
})

test('整篇计划：超长块单独列出，不计入可翻块数（Y 不含超长块）', () => {
  const plan = articleTranslatePlanOf([
    { kind: 'p', text: '字'.repeat(6001) },
    { kind: 'p', text: '短' },
    { kind: 'p', text: '   ' },
    { kind: 'pre', text: '代码不算' },
  ])
  assert.deepEqual(plan.overlongBlocks, [0])
  assert.deepEqual(plan.eligibleBlocks, [1])
  assert.equal(plan.totalBlocks, 1)
  assert.equal(plan.chars, 6002, '整篇字符口径包含超长块（上限判断用）；空白块记 0')
})
