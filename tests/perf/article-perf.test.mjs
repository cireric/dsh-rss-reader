/**
 * 抽取的**输入规模上限**回归测试（2026-10-07 加）。
 *
 * 出事原因：抽取管线里每一段都用「惰性匹配 + 在正文里从每个起点重扫到文末」的形状。
 * 只要一段没有闭合标签的载荷，就退化成 O(标签数 x 全文)，2MB 的载荷实测 67 秒，
 * 而且这段代码跑在 host 进程里 —— 一次按键冻住整个 DSH（所有会话、所有流）。
 *
 * 这里用「绝不放行」的判据：线性实现下耗时是 1~10ms 量级，这里的上界留了几十倍余量，
 * 而二次实现会超界 2 倍以上 —— 既能稳定抓到回归，也不会在慢机器上误报。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractArticle } from '../../lib/article.js'

/** 各面各一个载荷：未闭合的丢弃块 / 未闭合的标题 / 未闭合的块级标签 / 裸尖括号 / 实体前缀。 */
const PAYLOADS = {
  '未闭合 <script>': '<script>'.repeat(25000),
  '未闭合 <title>': '<title>'.repeat(25000),
  '未闭合 <figure>': '<figure>'.repeat(25000),
  '裸尖括号': '<'.repeat(50000),
  '实体前缀': '&#x' + 'a'.repeat(200) + '&'.repeat(25000),
}

const BUDGET_MS = 300

for (const [name, payload] of Object.entries(PAYLOADS)) {
  test('抽取规模闸门：' + name + ' x N 的载荷必须在 ' + BUDGET_MS + 'ms 内完成', () => {
    const started = Date.now()
    const result = extractArticle(payload + '<p>' + '这是一段足够长的正文，用来确认抽取仍然返回结果。'.repeat(3) + '</p>', 'https://ex.test/')
    const elapsed = Date.now() - started
    assert.ok(Array.isArray(result.blocks), 'blocks 必须是数组')
    assert.ok(elapsed < BUDGET_MS, '抽取耗时 ' + elapsed + 'ms，超过 ' + BUDGET_MS + 'ms —— 疑似退化为二次扫描')
  })
}

test('抽取规模闸门：正常页面不受影响（对照）', () => {
  // 注意：两段都必须明显长于 MIN_PARAGRAPH_CHARS（40），否则会被当栏目噪声过滤掉——
  // 第一版这里用了 25 字的段落，于是断言 2 段却得到 0 段，是测试写错而不是代码错。
  const first = '第一段正文，长度必须明显超过四十个字符的散文门槛，这样它才会被保留下来，成为一个独立的段落块。'
  const second = '第二段正文，同样需要明显超过那个四十字符的散文门槛，否则会被当成栏目噪声整段丢掉。'
  const result = extractArticle('<p>' + first + '</p><h2>小标题</h2><p>' + second + '</p>', 'https://ex.test/')
  assert.equal(result.blocks.filter((b) => b.kind === 'p').length, 2)
  assert.equal(result.blocks.filter((b) => b.kind === 'h').length, 1)
})

test('抽取规模闸门：原始事故载荷（2MB / 25 万个未闭合 script）必须在 1s 内完成', () => {
  const payload = '<script>'.repeat(250000)
  assert.equal(payload.length, 2000000, '载荷应当正好是 2MB')
  const started = Date.now()
  const result = extractArticle(payload, 'https://ex.test/')
  const elapsed = Date.now() - started
  assert.ok(Array.isArray(result.blocks), 'blocks 必须是数组')
  assert.ok(elapsed < 1000, '耗时 ' + elapsed + 'ms —— 修复前在同一台机器上实测 67.1 秒')
})
