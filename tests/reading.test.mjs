/**
 * 预计阅读时长（M5 01）的判据。
 *
 * 只钉一件事：**给定这份固定夹具，估算是几分钟**。速率常量刻意是整数近似值，所以这里的期望值
 * 不是「真相」，而是「我们承诺给用户看的那个数」——改速率就必须改这里，而且必须在报告里说明。
 *
 * 为什么分成中文块与英文块各测一遍、再测一次混排：三个失效形态互不覆盖。
 * ① 只数中文（漏掉英文）⇒ 纯英文块得 0；② 只数英文（忽略 CJK）⇒ 纯中文块得 0；
 * ③ 分词前不把 CJK 抹掉 ⇒ 中文里的标点串被当成单词，混排夹具当场偏大（见下面第三条断言的理由）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateReadingMinutes } from '../lib/shared.js'

/** 固定夹具的两种原料：恰好 n 个 CJK 字 / 恰好 n 个英文词（用空格分开，符合分词口径）。 */
const cjk = (n) => '中'.repeat(n)
const words = (n) => Array.from({ length: n }, (_, index) => 'word' + index).join(' ')

test('没有可读文本时返回 0：界面据此不显示任何数字（而不是「约 0 分钟」）', () => {
  for (const blocks of [[], [{ kind: 'img', src: 'x.png', alt: '图' }], [{ kind: 'p', text: '' }], [{ kind: 'p' }], [{ kind: 'p', text: 42 }]]) {
    assert.equal(estimateReadingMinutes(blocks), 0, JSON.stringify(blocks))
  }
})

test('CJK 按 300 字/分：600 字 = 2 分钟，601 字 = 3 分钟（向上取整，不四舍五入）', () => {
  assert.equal(estimateReadingMinutes([{ kind: 'p', text: cjk(600) }]), 2)
  assert.equal(estimateReadingMinutes([{ kind: 'p', text: cjk(601) }]), 3)
  assert.equal(estimateReadingMinutes([{ kind: 'p', text: cjk(300) }]), 1)
})

test('英文按 200 词/分：400 词 = 2 分钟，401 词 = 3 分钟', () => {
  assert.equal(estimateReadingMinutes([{ kind: 'p', text: words(400) }]), 2)
  assert.equal(estimateReadingMinutes([{ kind: 'p', text: words(401) }]), 3)
})

test('中英混排：两套速率各算各的，加起来再向上取整', () => {
  // 600/300 + 400/200 = 4 分钟；单看任何一半都只有 2
  assert.equal(estimateReadingMinutes([{ kind: 'p', text: cjk(600) + ' ' + words(400) }]), 4)
  // 605/300 + 600/200 = 2.0167 + 3 = 5.0167 ⇒ 6（只有真的相加再取整才会得到 6）
  assert.equal(estimateReadingMinutes([
    { kind: 'h', text: cjk(5) },
    { kind: 'p', text: cjk(600) + ' ' + words(400) },
    { kind: 'list', items: [words(100), words(100)] },
    { kind: 'img', src: 'x.png' },
    { kind: 'p', text: '' },
  ]), 6)
})

test('分词前必须把 CJK 抹掉：中文标点串不许被当成单词（否则混排会系统性偏大）', () => {
  // 1200 个 CJK 字 + 300 个「，」：正确口径 = 1200/300 = 4 分钟。
  // 不抹 CJK 直接按空白分词时，整段是一个词 ⇒ 4 + 1/200 ≈ 4，看不出差别 —— 所以夹具刻意让
  // 标点把文本切成 300 段：那种实现会数出 300 个「词」，得 4 + 1.5 = 5.5 ⇒ 6。
  const text = '中文内容，'.repeat(300)
  assert.equal(estimateReadingMinutes([{ kind: 'p', text }]), 4)
})

test('列表项与标题都算正文；图片块整块不计（图注也不计 —— 估的是量级，不值得为它加一条分支）', () => {
  assert.equal(estimateReadingMinutes([{ kind: 'list', items: [words(200)] }]), 1)
  assert.equal(estimateReadingMinutes([{ kind: 'h', text: cjk(300) }]), 1)
  // 一张图（连它的 200 词图注）不改变结果
  assert.equal(estimateReadingMinutes([{ kind: 'list', items: [words(200)] }, { kind: 'img', caption: words(200) }]), 1)
})
