/**
 * 翻译块的纯函数层（R7 01，spec §4.3 / D10 / 验收 8）。
 *
 * 为什么单独一层：可翻块的种类与字符口径（list 按 `items.join('\n')`）是跨票事实，
 * 但「哪些块能进请求」与「回包怎么对号入座」不依赖 DOM / 宿主。把它们钉在这里，
 * 后续 03/04 改批次编排时不用碰这些不变量。
 *
 * 判据刻意只走公开面：传块数组与回包，断言下标 / 译文 Map / 整批失败。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyBatch,
  blockIndexOfTranslateId,
  translatableBlocksOf,
  translatableTextOf,
  translateBlockIdOf,
} from '../lib/translate-blocks.js'

/** 一份覆盖全部七种块的夹具：只有 p / h / quote / list 这四种可翻。 */
const BLOCKS = [
  { kind: 'p', text: '第一段' },
  { kind: 'pre', text: 'const x = 1' },
  { kind: 'h', level: 2, text: '小标题' },
  { kind: 'img', src: 'https://img.example/a.png', alt: '图' },
  { kind: 'list', ordered: false, items: ['甲', '乙'] },
  { kind: 'table', header: ['列'], rows: [['值']] },
  { kind: 'quote', text: '引用' },
]

test('可翻块只取 p / h / quote / list；pre / img / table 不占编号', () => {
  assert.deepEqual(translatableBlocksOf(BLOCKS), [0, 2, 4, 6])
})

test('可翻块的文本口径：段落/标题/引用取 text，list 按 items.join 换行', () => {
  assert.equal(translatableTextOf(BLOCKS[0]), '第一段')
  assert.equal(translatableTextOf(BLOCKS[2]), '小标题')
  assert.equal(translatableTextOf(BLOCKS[4]), '甲\n乙', 'list 的字符口径是 items.join(\'\\n\')')
  assert.equal(translatableTextOf(BLOCKS[6]), '引用')
  assert.equal(translatableTextOf(BLOCKS[1]), '', '不可翻块没有待译文本')
  // 2026-11-26 评审：非字符串项不能 String() 成 "[object Object]" 发给模型；认不出就当空。
  assert.equal(translatableTextOf({ kind: 'list', items: ['甲', null, 3] }), '甲\n\n', 'list 非字符串项不编造文本')
})

test('applyBatch：正常回包按 b + 块下标还原 Map，标题单独还原', () => {
  const result = applyBatch(
    [{ id: 'b0', text: 'Hello' }, { id: 'b2', text: 'World' }],
    { title: '你好', items: [{ id: 'b0', text: '你好世界' }, { id: 'b2', text: '世界' }] },
  )
  assert.equal(result.ok, true)
  assert.equal(result.title, '你好')
  assert.deepEqual([...result.blocks.entries()], [[0, '你好世界'], [2, '世界']])
})

test('applyBatch：少给一条 ⇒ 整批失败，不把剩余译文贴到别的段落', () => {
  const result = applyBatch(
    [{ id: 'b0', text: 'Hello' }, { id: 'b2', text: 'World' }],
    { items: [{ id: 'b0', text: '你好世界' }] },
  )
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'misaligned')
})

test('applyBatch：多给一条 ⇒ 整批失败', () => {
  const result = applyBatch(
    [{ id: 'b0', text: 'Hello' }],
    { items: [{ id: 'b0', text: '你好世界' }, { id: 'b7', text: '多余' }] },
  )
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'misaligned')
})

test('applyBatch：编号重复 ⇒ 整批失败（哪怕条数碰巧相等）', () => {
  const result = applyBatch(
    [{ id: 'b0', text: 'Hello' }, { id: 'b2', text: 'World' }],
    { items: [{ id: 'b0', text: '你好世界' }, { id: 'b0', text: '又一条' }] },
  )
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'misaligned')
})

test('applyBatch：空 / 纯空白译文不算失败，但该块没有译文（退回原文）', () => {
  const result = applyBatch(
    [{ id: 'b0', text: 'Hello' }, { id: 'b2', text: 'World' }],
    { title: '   ', items: [{ id: 'b0', text: '   ' }, { id: 'b2', text: '\n世界\n' }] },
  )
  assert.equal(result.ok, true)
  assert.equal(result.title, undefined, '纯空白标题等于没有标题')
  assert.equal(result.blocks.has(0), false, '空译文不产生空段落')
  assert.equal(result.blocks.get(2), '\n世界\n', '非空译文原样保留（含换行）')
})

test('块编号只有一套编解码：b + 下标 ⇄ 下标，非法 id 认不出就 undefined', () => {
  assert.equal(translateBlockIdOf(0), 'b0')
  assert.equal(translateBlockIdOf(42), 'b42')
  assert.equal(blockIndexOfTranslateId('b0'), 0)
  assert.equal(blockIndexOfTranslateId('b42'), 42)
  assert.equal(blockIndexOfTranslateId('b'), undefined, '没有下标不算编号')
  assert.equal(blockIndexOfTranslateId('x1'), undefined)
  assert.equal(blockIndexOfTranslateId('b1x'), undefined, '尾部杂物不许被正则前缀放过')
  assert.equal(blockIndexOfTranslateId('b-1'), undefined)
  assert.equal(blockIndexOfTranslateId('b01'), undefined, '前导零不是规范形式：b01 与 b1 会解码成同一下标')
})
