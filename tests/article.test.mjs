/**
 * 正文抽取的单测：这是「抽错了用户会立刻看到」的逻辑，用固定夹具钉住。
 *
 * 2026-10-06 输出模型由「纯文本段落」升级为「结构化块」——起因是用户反馈
 * 「图片不显示、样式变形」：纯文本无法表达标题/图片/列表/引用，图片更是被整块丢弃。
 * 因此断言从 paragraphs 改为 blocks，并新增图片与结构块的用例。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractArticle, isFrameable, pickImageUrl, attrOf, blocksToText } from '../lib/article.js'
// decodeEntities / htmlToText 已搬到 html-text.ts（2026-10-07），断言一条没动
import { decodeEntities, htmlToText } from '../lib/html-text.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(join(here, 'fixtures', 'article.html'), 'utf8')
const BASE = 'https://ex.test/posts/a'

/** 按 kind 取块，便于断言。 */
const of = (article, kind) => article.blocks.filter((block) => block.kind === kind)

test('实体解码：命名、十进制、十六进制都能还原', () => {
  assert.equal(decodeEntities('&amp; &lt; &gt; &quot; &apos;'), '& < > " \'')
  assert.equal(decodeEntities('&#8220;引号&#8221;'), '“引号”')
  assert.equal(decodeEntities('&#x2014;破折号'), '—破折号')
  assert.equal(decodeEntities('&nbsp;空格'), ' 空格')
  assert.equal(decodeEntities('&nosuchentity;'), '&nosuchentity;')
})

test('HTML 转文本：块级标签转换行，空白收敛，标签不留痕', () => {
  assert.equal(htmlToText('<p>一段</p><p>二段</p>'), '一段\n二段')
  assert.equal(htmlToText('甲<br>乙'), '甲\n乙')
  assert.equal(htmlToText('<div>  多余   空白  </div>'), '多余 空白')
  assert.ok(!htmlToText('<p>正文</p><script>x</script>').includes('script'))
})

test('抽取：正文保留为段落块，导航/页脚/脚本/短栏目被丢弃', () => {
  const article = extractArticle(fixture, BASE)
  const text = blocksToText(article.blocks)

  assert.equal(of(article, 'p').length, 2, '应当恰好两段正文，实际：' + of(article, 'p').length)
  assert.match(text, /第一段真正的正文/)
  assert.match(text, /第二段正文/)
  assert.match(text, /& 和中文引号 “测试”/, '实体应当被解码')

  assert.ok(!text.includes('这段绝不能出现在正文里'), 'script 内容泄漏进正文')
  assert.ok(!text.includes('导航里的段落'), '导航段落泄漏进正文')
  assert.ok(!text.includes('站点标语占位'), 'header 段落泄漏进正文')
  assert.ok(!text.includes('版权所有'), 'footer 段落泄漏进正文')
  assert.ok(!text.includes('分类：智能家居'), '短栏目未被长度门槛过滤')
})

test('图片：懒加载真地址优先，绝不留下占位图（用户点名的「图片不显示」）', () => {
  const article = extractArticle(fixture, BASE)
  const images = of(article, 'img')
  assert.ok(images.length >= 2, '图片块被丢掉了，实际只有 ' + images.length + ' 个')

  assert.equal(images[0].src, 'https://ex.test/images/real-photo.jpg', '应当用 data-src 而不是占位 src')
  assert.equal(images[0].alt, '一张真实照片')
  assert.equal(images[0].caption, '图注：这是图片说明')
  assert.match(images[1].src, /large\.jpg$/, 'srcset 应当取描述符最大的候选，实际：' + images[1].src)
})

test('pickImageUrl：srcset 取最大、占位协议被挡掉、相对地址转绝对', () => {
  assert.equal(pickImageUrl('<img srcset="a.jpg 100w, b.jpg 900w, c.jpg 400w">', 'https://ex.test/x/'), 'https://ex.test/x/b.jpg')
  // 以 / 开头是站点根相对，不是当前目录相对
  assert.equal(pickImageUrl('<img src="/p.jpg">', 'https://ex.test/x/'), 'https://ex.test/p.jpg')
  assert.equal(pickImageUrl('<img src="data:image/gif;base64,R0lGOD">', 'https://ex.test/'), undefined)
  assert.equal(pickImageUrl('<img src="javascript:alert(1)">', 'https://ex.test/'), undefined)
  assert.equal(pickImageUrl('<img alt="没有地址">', 'https://ex.test/'), undefined)
})

test('attrOf：单双引号与无引号都要认，属性名大小写不敏感', () => {
  assert.equal(attrOf('<img src="a.jpg">', 'src'), 'a.jpg')
  assert.equal(attrOf("<img src='b.jpg'>", 'src'), 'b.jpg')
  assert.equal(attrOf('<img src=c.jpg>', 'src'), 'c.jpg')
  assert.equal(attrOf('<img SRC="d.jpg">', 'src'), 'd.jpg')
  assert.equal(attrOf('<img alt="x">', 'src'), undefined)
})

test('结构块：标题分级、列表、引用都被保留（否则样式必然变形）', () => {
  const article = extractArticle(fixture, BASE)
  const headings = of(article, 'h')
  assert.ok(headings.some((h) => h.level === 2 && h.text === '二级小标题'), '二级标题丢失')

  const lists = of(article, 'list')
  assert.equal(lists.length, 1, '列表块丢失')
  assert.equal(lists[0].ordered, false)
  assert.equal(lists[0].items.length, 2)

  const quotes = of(article, 'quote')
  assert.equal(quotes.length, 1, '引用块丢失')
  assert.match(quotes[0].text, /引用文字/)
})

test('代码块必须保留换行与缩进，且长度门槛对它不适用', () => {
  const article = extractArticle(fixture, BASE)
  const codes = of(article, 'pre')
  assert.ok(codes.length >= 2, '代码块数量不对：' + codes.length)

  const main = codes.find((code) => code.text.includes('def main()'))
  assert.ok(main !== undefined, '代码块被整块丢掉了')
  assert.match(main.text, /\n {4}print\("hello"\)/, '代码块缩进丢了')
  assert.ok(codes.some((code) => code.text === 'x = 1'), '短代码块被长度门槛杀掉了')
})

test('文档顺序：块按出现顺序排列（图片不该跑到段落前面）', () => {
  const article = extractArticle(fixture, BASE)
  const kinds = article.blocks.map((block) => block.kind)
  const firstParagraph = kinds.indexOf('p')
  const firstImage = kinds.indexOf('img')
  assert.ok(firstParagraph >= 0 && firstImage > firstParagraph, '图片出现在首个段落之前，顺序错了：' + kinds.join(','))
})

test('可嵌性判定：按 X-Frame-Options / CSP frame-ancestors 决定能否 iframe', () => {
  const H = (pairs) => new Headers(pairs)
  assert.equal(isFrameable(H([])), true)
  assert.equal(isFrameable(H([['x-frame-options', 'SAMEORIGIN']])), false)
  assert.equal(isFrameable(H([['x-frame-options', 'DENY']])), false)
  assert.equal(isFrameable(H([['x-frame-options', 'allowall']])), true)
  assert.equal(isFrameable(H([['content-security-policy', "default-src 'self'; frame-ancestors 'none'"]])), false)
  assert.equal(isFrameable(H([['content-security-policy', 'frame-ancestors https://dsh.local']])), false)
  assert.equal(isFrameable(H([['content-security-policy', 'frame-ancestors *']])), true)
  assert.equal(isFrameable(H([['content-security-policy', "default-src 'self'"]])), true)
})

test('标题：og:title 优先；退化到 <title>；都没有则 undefined', () => {
  assert.equal(extractArticle(fixture).title, 'OG 标题：Tapo 智能插座 & 电量统计')
  assert.equal(extractArticle('<html><head><title>只有 title</title></head><body><p>' + '长'.repeat(50) + '</p></body></html>').title, '只有 title')
  assert.equal(extractArticle('<html><body><p>' + '长'.repeat(50) + '</p></body></html>').title, undefined)
})

test('退化路径：没有 <p> 的 div 版式也能抽出正文', () => {
  const long1 = '第一行正文'.repeat(12)
  const long2 = '第二行正文'.repeat(12)
  const article = extractArticle('<html><body><div><div>' + long1 + '</div><div>' + long2 + '</div></div></body></html>')
  assert.ok(article.blocks.length >= 2, 'div 版式应当取到正文')
  assert.match(blocksToText(article.blocks), /第一行正文/)
})

test('抽不出正文时返回空块（而不是编造内容）', () => {
  assert.deepEqual(extractArticle('<html><body><nav>仅导航</nav></body></html>').blocks, [])
})

test('实体解码：越界码点不得抛错（否则一次输入就能毁掉整页抽取）', () => {
  // 2026-10-07 安全评审 R4：&#x110000; 会让 String.fromCodePoint 抛 RangeError
  assert.equal(decodeEntities('&#x110000;'), '&#x110000;', '越界的十六进制引用按原文保留')
  assert.equal(decodeEntities('&#1114112;'), '&#1114112;', '越界的十进制引用同理')
  assert.equal(decodeEntities('&#x10ffff;'), '\u{10ffff}', '边界内的最大码点照常解码')
  assert.equal(decodeEntities('&#x41;'), 'A', '常规引用不受影响')
})
