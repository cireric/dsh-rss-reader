/**
 * 正文抽取的单测：这是 D 方案里唯一"抽错了用户会立刻看到"的逻辑，用固定夹具钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { decodeEntities, extractArticle, htmlToText, isFrameable } from '../lib/article.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(join(here, 'fixtures', 'article.html'), 'utf8')

test('实体解码：命名、十进制、十六进制都能还原', () => {
  assert.equal(decodeEntities('&amp; &lt; &gt; &quot; &apos;'), '& < > " \'')
  assert.equal(decodeEntities('&#8220;引号&#8221;'), '“引号”')
  assert.equal(decodeEntities('&#x2014;破折号'), '—破折号')
  assert.equal(decodeEntities('&nbsp;空格'), ' 空格')
  // 不认识的实体原样保留（不编造）
  assert.equal(decodeEntities('&nosuchentity;'), '&nosuchentity;')
})

test('HTML 转文本：块级标签转换行，空白收敛，标签不留痕', () => {
  assert.equal(htmlToText('<p>一段</p><p>二段</p>'), '一段\n二段')
  assert.equal(htmlToText('甲<br>乙'), '甲\n乙')
  assert.equal(htmlToText('<div>  多余   空白  </div>'), '多余 空白')
  assert.ok(!htmlToText('<p>正文</p><script>x</script>').includes('script'))
})

test('抽取：正文段落保留，导航/页脚/脚本/短栏目被丢弃', () => {
  const article = extractArticle(fixture)
  const text = article.paragraphs.join('\n')

  assert.equal(article.paragraphs.length, 4, '两段正文 + 两个代码块，实际：' + article.paragraphs.length)
  assert.match(text, /第一段真正的正文/)
  assert.match(text, /第二段正文/)
  // 实体在抽取里被解码
  assert.match(text, /& 和中文引号 “测试”/)

  // 四类反例都必须不在正文里
  assert.ok(!text.includes('这段绝不能出现在正文里'), 'script 内容泄漏进正文')
  assert.ok(!text.includes('导航里的段落'), '导航段落泄漏进正文')
  assert.ok(!text.includes('站点标语占位'), 'header 段落泄漏进正文')
  assert.ok(!text.includes('版权所有'), 'footer 段落泄漏进正文')
  // 短栏目（分类：…）按长度门槛被丢弃
  assert.ok(!text.includes('分类：智能家居'), '短栏目未被长度门槛过滤')
})

test('代码块必须保留且有换行（代码被当普通段落折行 = 用户点名的「全变样」）', () => {
  const article = extractArticle(fixture)
  const code = article.paragraphs.find((p) => p.includes('def main()'))
  assert.ok(code !== undefined, '代码块被整块丢掉了')
  // 换行与缩进要留下来，客户端才能按 pre-wrap + 等宽渲染
  assert.ok(code.includes('\n'), '代码块内部换行丢了')
  assert.match(code, /\n {4}print\("hello"\)/, '代码块缩进丢了')
  // 夹具里还有一个只有 5 个字符的代码块：长度门槛对代码块必须不适用，否则它会被静默丢掉
  assert.ok(
    article.paragraphs.includes('x = 1'),
    '短代码块被长度门槛杀掉了 —— 门槛只该作用于散文段落',
  )
})

test('可嵌性判定：按 X-Frame-Options / CSP frame-ancestors 决定能否 iframe', () => {
  const H = (pairs) => new Headers(pairs)
  // 无任何策略 = 允许
  assert.equal(isFrameable(H([])), true)
  // 实测真实站点：github.blog 发 SAMEORIGIN，MDN 发 DENY
  assert.equal(isFrameable(H([['x-frame-options', 'SAMEORIGIN']])), false)
  assert.equal(isFrameable(H([['x-frame-options', 'DENY']])), false)
  assert.equal(isFrameable(H([['x-frame-options', 'allowall']])), true)
  // CSP frame-ancestors：只有通配 * 放行
  assert.equal(isFrameable(H([['content-security-policy', "default-src 'self'; frame-ancestors 'none'"]])), false)
  assert.equal(isFrameable(H([['content-security-policy', 'frame-ancestors https://dsh.local']])), false)
  assert.equal(isFrameable(H([['content-security-policy', 'frame-ancestors *']])), true)
  // 没有 frame-ancestors 的 CSP 不影响判定
  assert.equal(isFrameable(H([['content-security-policy', "default-src 'self'"]])), true)
})

test('标题：og:title 优先（它比 <title> 干净，去掉站点名后缀）', () => {
  assert.equal(extractArticle(fixture).title, 'OG 标题：Tapo 智能插座 & 电量统计')
})

test('无 og:title 时退化到 <title>；都没有则 title 为 undefined', () => {
  assert.equal(extractArticle('<html><head><title>只有 title</title></head><body><p>' + '长'.repeat(50) + '</p></body></html>').title, '只有 title')
  assert.equal(extractArticle('<html><body><p>' + '长'.repeat(50) + '</p></body></html>').title, undefined)
})

test('退化路径：没有 <p> 的 div 版式也能抽出正文行', () => {
  const long1 = '第一行正文'.repeat(12)
  const long2 = '第二行正文'.repeat(12)
  const html = '<html><body><div><div>' + long1 + '</div><div>' + long2 + '</div></div></body></html>'
  const article = extractArticle(html)
  assert.ok(article.paragraphs.length >= 2, 'div 版式应当走退化路径取到正文行')
  assert.match(article.paragraphs.join('\n'), /第一行正文/)
})

test('抽不出正文时返回空段落（而不是编造内容）', () => {
  assert.deepEqual(extractArticle('<html><body><nav>仅导航</nav></body></html>').paragraphs, [])
})