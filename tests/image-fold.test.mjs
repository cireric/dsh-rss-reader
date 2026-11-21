/**
 * 图片折叠的**决策层**：把正文块切成「图片组」，并回答「这一组现在该不该渲染 <img>」。
 *
 * 为什么这两件事要单独抽成纯函数来钉（spec 决策 16 / 5 / 6）：
 *  - 「相邻」是渲染概念，不是抽取概念 —— 抽取层不知道版面怎么排，把它塞进去会让缓存内容
 *    依赖排版决定（改一次就要抬 EXTRACTOR_REVISION）。放客户端纯函数就能随便改。
 *  - 「该不该渲染」必须只有**一个**裁决点。此前渲染层各自写 `expandImages === true` 的形态
 *    最容易出的事故是「提示说折叠、DOM 里却有 img」——两者读了不同的表达式。
 *
 * 本文件只测纯函数（Seam 1）；DOM 里有没有 <img>、提示文案、Tab 序那些在 scroll-dom.test.mjs。
 * 写法沿用 tests/list-scroll.test.mjs 的纯函数族：一个行为一条用例，断言写死期望值。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupImageBlocks, shouldRenderImage, foldOf } from '../lib/image-fold.js'

/** 造一个 img 块（wire 形状：`kind` + `src`，与抽取层产出的块同形）。 */
const img = (src) => ({ kind: 'img', src, alt: src.toUpperCase() })
/** 造一个普通段落块。 */
const p = (text) => ({ kind: 'p', text })
/** 空段落 —— 视觉上没有内容，但它**仍然是块**，必须断开图片组（spec 决策 16）。 */
const EMPTY_P = { kind: 'p', text: '' }

// ── 分组边界 ────────────────────────────────────────────────────────────────

test('分组：单张图自成一组', () => {
  const groups = groupImageBlocks([p('前'), img('a'), p('后')])
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].blockIndexes, [1])
  assert.deepEqual(groups[0].blocks.map((block) => block['src']), ['a'])
})

test('分组：连续三张图合成一组（一次展开三张，不是三组）', () => {
  const groups = groupImageBlocks([p('前'), img('a'), img('b'), img('c'), p('后')])
  assert.equal(groups.length, 1, '三张相邻的图必须归为一组')
  assert.deepEqual(groups[0].blockIndexes, [1, 2, 3])
  assert.deepEqual(groups[0].blocks.map((block) => block['src']), ['a', 'b', 'c'])
})

test('分组：中间夹一段文字就断开（1 + 2）', () => {
  const groups = groupImageBlocks([img('a'), p('中间这段文字把图断开'), img('b'), img('c')])
  assert.equal(groups.length, 2, '文字块必须断开图片组')
  assert.deepEqual(groups.map((group) => group.blockIndexes), [[0], [2, 3]])
})

test('分组：夹一个**空的** p 也断开（空块不是「看不见」的块）', () => {
  // 这条容易做错：实现者看到 text === '' 就以为「没有内容，可以跳过」。
  // 但块顺序是读者的阅读顺序，跳过空块等于把两段本来分开的图并成一组，
  // 读者点一次提示会放出两张毫不相干的图。
  const groups = groupImageBlocks([img('a'), EMPTY_P, img('b')])
  assert.equal(groups.length, 2, '空的 p 同样要断开图片组')
  assert.deepEqual(groups.map((group) => group.blockIndexes), [[0], [1 + 1]])
})

test('分组：没有 img 块时返回空数组（正文无图不是错误）', () => {
  assert.deepEqual(groupImageBlocks([p('只有文字'), { kind: 'h', level: 2, text: '标题' }]), [])
  assert.deepEqual(groupImageBlocks([]), [])
})

test('分组：kind 缺失或非字符串的块按 p 处理（与 article-pane 的分派同一条规则）', () => {
  // 旧缓存的块可能没有 kind。渲染层把「认不出」当段落画，分组也必须当段落 ——
  // 否则一个缺 kind 的块会被当成图片之间的「透明」分隔物，组的边界与画出来的东西对不上。
  const groups = groupImageBlocks([img('a'), { text: '没有 kind 的块' }, img('b')])
  assert.equal(groups.length, 2, '认不出的块按段落处理 ⇒ 断开')
  assert.deepEqual(groups.map((group) => group.blockIndexes), [[0], [2]])
})

test('分组：组序号是 0..N-1 连续整数（组覆盖的 Set 就装这个数）', () => {
  const groups = groupImageBlocks([img('a'), p('x'), img('b'), p('y'), img('c'), img('d')])
  assert.deepEqual(groups.map((group) => group.index), [0, 1, 2])
})

// ── 顺序判据（spec 验收 20） ────────────────────────────────────────────────

test('顺序判据：分组输出顺序 = 输入块顺序（折叠前后段落与图片的相对位置不变）', () => {
  // 用一张交错的夹具：任何「先收集所有图再分组」的实现都会把顺序打乱。
  const blocks = [img('a'), p('1'), img('b'), img('c'), p('2'), p('3'), img('d'), EMPTY_P, img('e')]
  const groups = groupImageBlocks(blocks)
  const flattened = groups.flatMap((group) => group.blockIndexes)
  assert.deepEqual(flattened, [0, 2, 3, 6, 8], '组的顺序与组内顺序都必须与输入一致')
  for (let at = 1; at < flattened.length; at += 1) {
    assert.ok(flattened[at] > flattened[at - 1], '块下标必须严格递增：' + flattened.join(','))
  }
})

test('顺序判据：每个组拿到的 blockIndexes 与 blocks 一一对应', () => {
  // 消费方要么用下标回查、要么直接用块。两者错位时症状是「点第一组，第二组亮了」。
  const blocks = [p('前'), img('a'), img('b'), p('中'), img('c')]
  for (const group of groupImageBlocks(blocks)) {
    assert.equal(group.blocks.length, group.blockIndexes.length)
    for (let at = 0; at < group.blockIndexes.length; at += 1) {
      assert.equal(group.blocks[at], blocks[group.blockIndexes[at]], '第 ' + group.index + ' 组的第 ' + at + ' 项错位了')
    }
  }
})

// ── 折叠判定真值表（spec 决策 5：组覆盖 ?? 篇覆盖 ?? 偏好） ─────────────────

const NONE = new Set()

/**
 * 真值表。**期望值全部写死**，不由公式推出来 —— 否则断言就是在重算实现，
 * 永远不会与实现意见不同（TDD 的反面：tautological test）。
 *
 * 三条语义来源（spec 决策 5）：
 *  1. 组覆盖命中 ⇒ 渲染（读者明确点过的那一组，不该被全局开关盖掉）；
 *  2. 否则 篇覆盖 ?? 偏好；
 *  3. 组覆盖只影响它自己那一组。
 */
const TRUTH_TABLE = [
  // [偏好, 篇覆盖, 组覆盖, 组序号, 期望, 说明]
  [true, undefined, NONE, 0, true, '默认展开：什么都不设就渲染'],
  [false, undefined, NONE, 0, false, '偏好折叠：渲染层不画 <img>'],
  [false, true, NONE, 0, true, '篇级覆盖为 true 时压过折叠偏好'],
  [true, false, NONE, 0, false, '篇级覆盖为 false 时压过展开偏好'],
  [false, undefined, new Set([0]), 0, true, '组级覆盖命中 ⇒ 渲染'],
  [false, false, new Set([0]), 0, true, '组级优先于篇级（读者点过这一组）'],
  [true, false, new Set([0]), 0, true, '组级优先于篇级（展开偏好下同样成立）'],
  [false, undefined, new Set([1]), 0, false, '组覆盖只影响它自己那一组'],
  [false, undefined, new Set([0]), 1, false, '组覆盖的序号不许错位到邻组'],
  [false, true, NONE, 3, true, '篇级覆盖对所有组序号一视同仁'],
  [true, undefined, NONE, 7, true, '偏好对所有组序号一视同仁'],
]

for (const [preference, articleOverride, groupOverrides, groupIndex, expected, why] of TRUTH_TABLE) {
  const label = '偏好=' + preference + ' 篇=' + String(articleOverride)
    + ' 组=' + JSON.stringify([...groupOverrides]) + ' 序号=' + groupIndex + ' ⇒ ' + expected
  test('折叠真值表：' + label + '（' + why + '）', () => {
    assert.equal(shouldRenderImage(preference, articleOverride, groupOverrides, groupIndex), expected, why)
  })
}

test('折叠判定：组覆盖为空集合与「没有覆盖」等价（默认参数不该改变语义）', () => {
  assert.equal(shouldRenderImage(false, undefined, new Set(), 0), false)
  assert.equal(shouldRenderImage(true, undefined, new Set(), 0), true)
})

// ── 唯一裁决点（spec 决策 6：foldOf 与 shouldRenderImage 是同一处裁决者） ─────

test('foldOf 返回的判定体与 shouldRenderImage 逐格一致（两层派生只有一处算）', () => {
  // 这条钉的是「只有一个裁决点」这个不变量本身：foldOf 若自己复制了一份判定逻辑，
  // 两份迟早分叉，症状是「i 键按了没反应」或「提示说折叠、DOM 里有 img」。
  for (const [preference, articleOverride, groupOverrides, groupIndex, expected] of TRUTH_TABLE) {
    const fold = foldOf(preference, articleOverride, groupOverrides)
    assert.equal(
      fold.shouldRender(groupIndex), expected,
      'foldOf 与真值表不一致：偏好=' + preference + ' 篇=' + String(articleOverride)
        + ' 组=' + JSON.stringify([...groupOverrides]) + ' 序号=' + groupIndex,
    )
    assert.equal(
      fold.shouldRender(groupIndex),
      shouldRenderImage(preference, articleOverride, groupOverrides, groupIndex),
      'foldOf 与 shouldRenderImage 分叉了（两层派生被算了两遍）',
    )
  }
})

test('foldOf：同一份判定体可以反复查询多组，互不影响', () => {
  // ArticleView 会对每一组各问一次，所以判定体必须是可重复调用的纯查询，不能是「问一次就变」。
  const fold = foldOf(false, undefined, new Set([1]))
  assert.equal(fold.shouldRender(0), false)
  assert.equal(fold.shouldRender(1), true)
  assert.equal(fold.shouldRender(2), false)
  assert.equal(fold.shouldRender(1), true, '重复查询同一组必须给同一个答案')
})

test('foldOf：判定体不持有会变的引用（外部改动 Set 不影响已取出的判定体）', () => {
  // 组覆盖的 Set 住在 index.tsx 的 state 里，换篇时会被替换。判定体若直接闭包那个 Set，
  // 渲染与「读者上次点过什么」就会脱钩 —— 这里把「取快照」这个约定钉住。
  const groups = new Set([0])
  const fold = foldOf(false, undefined, groups)
  assert.equal(fold.shouldRender(0), true)
  groups.add(1)
  assert.equal(fold.shouldRender(1), false, '判定体不该跟着外部 Set 的后续改动变')
})
