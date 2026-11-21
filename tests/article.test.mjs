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
import { EXTRACTOR_REVISION, extractArticle, fetchArticle, isDecorativeImage, isFrameable, pickImageUrl, attrOf, blocksToText } from '../lib/article.js'
// decodeEntities / htmlToText 已搬到 html-text.ts（2026-10-07），断言一条没动
import { decodeEntities, htmlToText, paragraphsOf } from '../lib/html-text.js'
// 「这段摘要算不算正文」的判据与 40 字门槛同住 shared.ts：两处（列表行 / 正文面）共用一份
import { hasBodyText } from '../lib/shared.js'

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

test('paragraphsOf：HTML 按段落切块（空值认作没有段落，实体先解码再切）', () => {
  // 列表行要靠「有没有段落」区分两条兜底文案，所以 undefined 与空串必须同义地返回 []。
  assert.deepEqual(paragraphsOf(undefined), [], 'undefined = 源没给正文')
  assert.deepEqual(paragraphsOf(''), [], '空串 = 没有段落')
  assert.deepEqual(paragraphsOf('<p>一段</p>'), ['一段'])
  assert.deepEqual(paragraphsOf('<p>一段</p><p>二段</p><br>三段'), ['一段', '二段', '三段'])
  assert.deepEqual(paragraphsOf('<p>&amp; &lt; &#x2014;</p>'), ['& < —'], '实体必须解码后再切段')
})

test('hasBodyText：40 字门槛（拼接用单个空格，分隔符也数进长度）', () => {
  // 门槛与判据必须同住：这里钉的是**旧列表行判据的语义**（join(' ') 一次、trim 一次），
  // 列表行与正文面的回退内容都靠它，任何一边单独改门槛都会先让这条红。
  assert.equal(hasBodyText([]), false, '没有段落 = 没有正文')
  assert.equal(hasBodyText(['']), false, '空段不算正文')
  assert.equal(hasBodyText(['   ']), false, '纯空白不算正文')
  assert.equal(hasBodyText(['a'.repeat(39)]), false, '39 字低于门槛')
  assert.equal(hasBodyText(['a'.repeat(40)]), true, '恰好 40 字算正文（边界与旧判据同一边）')
  assert.equal(hasBodyText(['a'.repeat(20), 'b'.repeat(19)]), true, '两段拼接 20 + 1 空格 + 19 = 40 字')
  assert.equal(hasBodyText(['a'.repeat(20), 'b'.repeat(18)]), false, '拼接后 39 字：分隔符数进长度，不是各段分别判')
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

test('装饰性小图判据：CDN 尺寸描述符 ≤200 就当头像/图标丢掉（2026-10-08 用户实测）', () => {
  // 实测样本：同一张作者头像以 thumbnail/!72x72r 与 !100x100r 两种规格各出现多次，
  // 而正文图都是无尺寸描述符的原图。判据只看显式宽x高，不猜路径关键词。
  assert.equal(isDecorativeImage('https://cdn.test/a.JPG?imageMogr2/thumbnail/!72x72r/gravity/center'), true)
  assert.equal(isDecorativeImage('https://cdn.test/a.JPG?imageMogr2/thumbnail/!100x100r'), true)
  // 边界（如实写明，不假装覆盖）：只认「显式 WxH 描述符」这一种写法。像 ?w=64&h=64 这种
  // 拆成两个参数的形式**不认** —— 没有实测样本支持它，加规则只会引入误伤风险。
  assert.equal(isDecorativeImage('https://cdn.test/a.png?w=64&h=64'), false, '只认 WxH 描述符，不认拆开的 w/h 参数')
  assert.equal(isDecorativeImage('https://cdn.test/2026/10/06/article/abc.png'), false, '无尺寸描述符 = 正文图')
  assert.equal(isDecorativeImage('https://cdn.test/pic-1600x900.jpg'), false, '大尺寸描述符是正文图')
  assert.equal(isDecorativeImage('https://cdn.test/pic-201x201.jpg'), false, '刚好超过阈值要保留（阈值内才是装饰）')
})

test('抽取：装饰性小图与重复图都不进正文（sspai 那篇的回归）', () => {
  const avatar = 'https://cdnfile.test/avatar.JPG?imageMogr2/thumbnail/!100x100r'
  const body1 = 'https://cdnfile.test/2026/10/article/real1.png'
  const body2 = 'https://cdnfile.test/2026/10/article/real2.png'
  const html = '<html><body>'
    + '<p>' + '正'.repeat(60) + '</p>'
    + '<img src="' + avatar + '" alt="作者头像">'
    + '<p>' + '文'.repeat(60) + '</p>'
    + '<img src="' + body1 + '" alt="正文图一">'
    + '<p>' + '章'.repeat(60) + '</p>'
    + '<img src="' + body1 + '" alt="正文图一（卡片区重复）">'
    + '<img src="' + body1 + '" alt="正文图一（又重复）">'
    + '<img src="' + body2 + '" alt="正文图二">'
    + '</body></html>'
  const article = extractArticle(html, 'https://ex.test/post/1')
  const imgs = article.blocks.filter((b) => b.kind === 'img').map((b) => String(b.src))
  assert.ok(!imgs.some((s) => s.includes('avatar')), '头像（小尺寸描述符）不该进正文')
  assert.equal(imgs.filter((s) => s === body1).length, 2, '同一张正文图最多留 ' + 2 + ' 次（超过的重复丢掉）')
  assert.ok(imgs.includes(body2), '另一张正文图要留着')
})
/**
 * —— 正文容器识别（2026-10-09）——
 *
 * 为什么补这一层：抽取出图片/段落原先在**整页范围**里找，站点头像、页脚二维码、相关阅读卡片
 * 与正文一样满足「是个 img」「是个 p」，只能靠长度门槛与尺寸描述符逐条去猜（实测仍漏 6 张二维码）。
 * 改成「先认正文容器再抽块」之后，这些杂图不需要任何规则——它们根本不在容器里。
 *
 * 下面用**合成页面**把判据钉死（真实站点页面太大，不适合进夹具）。
 */
function wrapPage(sidebarLinks, bodyParagraphs, bodyImages = []) {
  const link = (i) => '<a href="/nav/' + i + '">导航条目' + i + '，这是一段足够长的链接文字用来抬高链接密度</a>'
  return '<html><body>'
    + '<div id="sidebar"><ul>' + Array.from({ length: sidebarLinks }, (_, i) => '<li>' + link(i) + '</li>').join('') + '</ul></div>'
    + '<div id="main"><article>'
    + bodyParagraphs.map((text) => '<p>' + text + '</p>').join('')
    + bodyImages.map((src) => '<img src="' + src + '" alt="正文图">').join('')
    + '</article></div>'
    + '<div id="footer"><img src="https://ex.test/static/qrcode.png" alt="站点二维码"></div>'
    + '</body></html>'
}

test('容器识别：导航列表与页脚二维码不进正文（杂图不再需要逐条规则）', () => {
  // 正文段落按**真实文章体量**写：容器识别的门槛是按「一篇文章」定的，夹具若只有几十个字符，
  // 侧栏链接反而比正文长，测的就不是判据而是夹具（第一版夹具踩到过）。
  const long = (n) => ('这是一段真正的正文内容，' + '重复以跨过容器识别与长度门槛。'.repeat(6) + '第' + n + '段。')
  const html = wrapPage(
    12,
    [long(1), long(2), long(3), long(4), long(5), long(6)],
    ['https://ex.test/photo/a.png'],
  )
  const article = extractArticle(html, 'https://ex.test/post/1')
  const text = blocksToText(article.blocks)
  assert.ok(text.includes('真正的正文内容'), '正文必须被抽出来，实际两段都丢了：' + text.slice(0, 120))
  assert.ok(!text.includes('导航条目'), '侧栏导航不该进正文（链接密度高）')
  const imgs = article.blocks.filter((b) => b.kind === 'img').map((b) => String(b.src))
  assert.ok(imgs.includes('https://ex.test/photo/a.png'), '正文图必须留着')
  assert.ok(!imgs.some((s) => s.includes('qrcode')), '页脚二维码不该进正文')
})

test('容器识别的兜底：认不出容器时必须退回整页，而不是把正文丢掉', () => {
  // 没有 p/div 分层、只有平铺长文本的版式（容器识别应当不产生可信候选，抽取照旧工作）
  const flat = '平铺正文'.repeat(40)
  const article = extractArticle('<html><body>' + flat + '</body></html>', 'https://ex.test/p')
  assert.ok(blocksToText(article.blocks).includes('平铺正文'), '认不出容器时仍必须抽到正文')
})

test('容器识别不得吃掉标题：标题仍从全页取（og:title 在 head 里，容器限定后不存在）', () => {
  const long = (n) => '正文段落内容重复以跨过门槛的判断。'.repeat(4) + n
  const html = '<html><head><meta property="og:title" content="容器限定后仍要拿到的标题"></head><body>'
    + '<div id="main"><article><p>' + long(1) + '</p><p>' + long(2) + '</p></article></div>'
    + '</body></html>'
  const article = extractArticle(html, 'https://ex.test/p')
  assert.equal(article.title, '容器限定后仍要拿到的标题')
  assert.ok(article.blocks.length >= 2, '正文段落不该丢')
})
/**
 * 抽取版本号的守护（2026-10-09 补）。
 *
 * 为什么值得专门钉一条：这个常量原先写死在 endpoints.ts，与抽取逻辑分居两地。上一轮改了抽取
 * 规则却没抬版本号，于是**已经缓存过的文章永远显示修复前的块** —— 用户看到的是「修了还是老样子」，
 * 而所有单测都是绿的（测试用的是新代码，缓存里躺着的是旧结果）。这类事故测试抓不到行为，只能抓
 * 「版本与应用它的地方是否还对得上」。
 */
test('抽取版本：常量必须由 article.ts 导出，且 endpoints 不得再写死数字', () => {
  assert.equal(typeof EXTRACTOR_REVISION, 'number')
  assert.ok(EXTRACTOR_REVISION >= 4, '正文 base 用落点这一版至少是 4，实际 ' + EXTRACTOR_REVISION)
  // 为什么是 >= 4：P1-1 改了「相对图片按哪个 URL 解析」，旧缓存里的错图 URL 只有靠版本号
  // 落后才会被重抓（endpoints 的缓存命中判据是 revision === EXTRACTOR_REVISION）。
  const endpoints = readFileSync(join(here, '..', 'src', 'endpoints.ts'), 'utf8')
  assert.match(endpoints, /ARTICLE_REVISION = EXTRACTOR_REVISION/, 'endpoints 必须引用抽取器导出的版本，而不是写字面量')
  assert.ok(
    !/const ARTICLE_REVISION = \d/.test(endpoints),
    'ARTICLE_REVISION 又被写死成数字了 —— 抽取规则一变它就会漂，缓存会一直挡住新结果',
  )
})
/**
 * 标题剥站点后缀（2026-10-09）。
 *
 * 起因是用户截图里标题出现两遍：og:title 带站点名，而正文里另有一个纯标题的 h1。
 * 判据刻意保守 —— 只在「确有分隔符 + 后缀明显短于标题」时才剥，其余原样保留。
 */
test('标题：剥掉站点后缀，但不碰本身就是标题的写法', () => {
  const page = (title) => '<html><head><meta property="og:title" content="' + title + '"></head><body>'
    + '<div id="main"><article><p>' + '正文段落内容重复以跨过门槛的判断。'.repeat(4) + '</p>'
    + '<p>' + '第二段同样长度的正文内容，用来让容器识别有足够依据。'.repeat(3) + '</p></article></div></body></html>'

  // 三种真实分隔符（实测：少数派用「-」、爱范儿用「|」）
  assert.equal(extractArticle(page('iPhone Duo，和它尚未解答的疑问 - 少数派')).title, 'iPhone Duo，和它尚未解答的疑问')
  assert.equal(extractArticle(page('黄仁勋发布史上最强 Surface！专为「无限智能」设计 | 爱范儿')).title, '黄仁勋发布史上最强 Surface！专为「无限智能」设计')
  // 中文破折号**不是**站点分隔符：它在中文标题里多用于副标题，拿它剥会把标题砍断
  assert.equal(extractArticle(page('一个足够长的标题 —— 副标题在这里')).title, '一个足够长的标题 —— 副标题在这里')

  // 边界：没有分隔符、后缀过长（多半是标题本身而非站点名）、标题过短 —— 都必须原样保留
  assert.equal(extractArticle(page('一个没有分隔符的普通标题')).title, '一个没有分隔符的普通标题')
  assert.equal(extractArticle(page('短标题 | 这里是一个非常长的后半段，明显不是站点名')).title, '短标题 | 这里是一个非常长的后半段，明显不是站点名')
  assert.equal(extractArticle(page('A | B')).title, 'A | B', '过短的标题一律不剥')
})


test('正文 base 用重定向落点 finalUrl：相对图片与相对链接都按落点解析，而不是请求 URL', async () => {
  const html = '<!doctype html><html><body><article><h1>标题</h1>'
    + '<p>' + '这是一段足够长的正文，用来通过四十字符的内容门槛，并确保抽取器能认出正文容器。'.repeat(2)
    + '详见<a href="doc/x">文档</a>。</p>'
    + '<img src="img/a.png" alt="示例图">'
    + '</article></body></html>'
  let calledWith = ''
  const fakeFetch = async (url) => {
    calledWith = url
    return { kind: 'ok', body: html, finalUrl: 'https://final.example/new/post' }
  }
  const result = await fetchArticle('https://origin.example/old/post', { timeoutMs: 1000, maxBytes: 1_000_000 }, undefined, fakeFetch)
  assert.equal(calledWith, 'https://origin.example/old/post', '请求仍打用户给的那个 URL（订阅身份不变）')
  assert.equal(result.kind, 'ok')
  const image = result.blocks.find((block) => block.kind === 'img')
  assert.ok(image !== undefined, '正文里的图片块必须保留')
  assert.equal(image.src, 'https://final.example/new/img/a.png',
    '相对 img src 必须按 finalUrl 解析：按请求 URL 会指向 origin.example/old/img/a.png（裂图）')
  // 链接走的是同一条 baseUrl（spec 验收 2）：301 换路径后相对链接不许落到旧地址。
  const link = result.blocks.flatMap((block) => block.runs ?? []).find((run) => run.kind === 'link')
  assert.ok(link !== undefined, '相对链接必须抽成 link run')
  assert.equal(link.href, 'https://final.example/new/doc/x',
    '相对链接也必须按 finalUrl 解析（按请求 URL 会指向 origin.example/old/doc/x）')
})

/**
 * —— 内联语义（R5 02）——
 *
 * 为什么这一族值得单独一组：抽取层过去把 `<a>` / `<strong>` / `<em>` / `<code>` 一律当
 * 「未知标签只留文本」，读者拿到的是删减过的文章。而 `text` 由 `runs` 派生之后，
 * 「显示有链接、搜不到那个词」这类不一致从结构上就躲不掉了 —— 下面第 6、7 条就是钉这件事的。
 */

/**
 * 够长到能过 40 字门槛的填充，避免每条夹具都要自己凑长度。
 *
 * ⚠️ 长度必须**明显**超过 40：夹具前缀（如「详见」+「官方文档」+「。」= 7 字）会加上去，
 * 31 字的填充配 7 字前缀恰好 38 字，会把整条用例推进「段落被门槛丢掉」的分支里。
 */
const PAD = '这是一段足够长的正文内容，用来让段落跨过四十个字符的门槛判断，再多写一点。'
/** 抽出正文里第一个段落块（夹具都只有一个正文段）。 */
const firstP = (html, base = BASE) => extractArticle(html, base).blocks.find((block) => block.kind === 'p')

test('内联：链接两侧是汉字时 text 无标签间隙，且 link run 带绝对地址', () => {
  const block = firstP('<article><p>详见<a href="https://ex.test/doc">官方文档</a>。' + PAD + '</p></article>')
  assert.ok(block !== undefined, '段落块必须抽出来')
  // 这条正是 htmlToText 会插空格的形态（"详见 官方文档 。"）；runs 派生之后必须无空格。
  assert.equal(block.text, '详见官方文档。' + PAD, 'text 不许有标签间隙')
  const link = block.runs.find((run) => run.kind === 'link')
  assert.ok(link !== undefined, '链接必须成为 link run')
  assert.equal(link.text, '官方文档')
  assert.equal(link.href, 'https://ex.test/doc', '绝对地址原样保留')
})

test('内联：相对链接按 baseUrl 解析成绝对地址', () => {
  const block = firstP('<article><p>详见<a href="/doc/x">文档</a>。' + PAD + '</p></article>', 'https://ex.test/post/a')
  const link = block.runs.find((run) => run.kind === 'link')
  assert.ok(link !== undefined)
  assert.equal(link.href, 'https://ex.test/doc/x', '/doc/x 是站点根相对，按 baseUrl 解析')
})

test('内联：javascript: / data: / mailto: 退化成纯文本，不产生可点链接', () => {
  // ⚠️ data: 的样本里不许出现裸 `<`：标签扫描器按「第一个 >」闭合，`data:text/html,<b>` 会把
  // 标签提前切断（既有限制，与本项无关）。用不含尖括号的 data URI 验同一条判据。
  for (const href of ['javascript:alert(1)', 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', 'mailto:a@b.c']) {
    const block = firstP('<article><p>详见<a href="' + href + '">文档</a>。' + PAD + '</p></article>')
    assert.equal(block.runs, undefined, href + ' 不该产生任何 link run（整段没有内联语义）')
    assert.equal(block.text, '详见文档。' + PAD, href + ' 的链接文字必须留下（只丢可点性）')
  }
})

test('内联：加粗 / 斜体 / 行内代码各成对应 run', () => {
  const block = firstP('<article><p>这是<b>加粗</b>与<i>斜体</i>与<code>npm i</code>。' + PAD + '</p></article>')
  const kinds = block.runs.map((run) => run.kind)
  assert.deepEqual(kinds, ['text', 'strong', 'text', 'em', 'text', 'code', 'text'])
  assert.equal(block.runs[1].text, '加粗')
  assert.equal(block.runs[3].text, '斜体')
  assert.equal(block.runs[5].text, 'npm i')
})

test('内联：嵌套 <strong><em>x</em></strong> 取最外层语义，只有一个 run', () => {
  const block = firstP('<article><p>这是<strong><em>x</em></strong>。' + PAD + '</p></article>')
  const inner = block.runs.filter((run) => run.kind !== 'text')
  assert.equal(inner.length, 1, '嵌套只产出一个语义 run，不假装支持两层')
  assert.equal(inner[0].kind, 'strong', '取最外层（strong），内层 em 丢失')
  assert.equal(inner[0].text, 'x')
  assert.equal(block.text, '这是x。' + PAD)
})

test('内联：未知标签只留文本，不产生新 run 类型', () => {
  const block = firstP('<article><p>这是<mark>高亮</mark>与<span class="x">span</span>。' + PAD + '</p></article>')
  assert.equal(block.runs, undefined, 'mark / span 不产生任何语义 run')
  assert.equal(block.text, '这是高亮与span。' + PAD, '文本一字不少')
})

test('内联：相邻同类 run 合并（否则 run 数等于标签数，结构上限形同虚设）', () => {
  const block = firstP('<article><p>这是<b>甲</b><b>乙</b>。' + PAD + '</p></article>')
  const strong = block.runs.filter((run) => run.kind === 'strong')
  assert.equal(strong.length, 1, '<b>甲</b><b>乙</b> 必须合并成一个 strong run')
  assert.equal(strong[0].text, '甲乙')
})

test('不变量：runs 拼接严格等于 text（含行内标签两侧是汉字的形态）', () => {
  const fixtures = [
    '<p>详见<a href="https://ex.test/d">官方文档</a>。' + PAD + '</p>',
    '<p>这是<b>加粗</b>与<i>斜体</i>与<code>码</code>。' + PAD + '</p>',
    '<p>  前后都有空白  <b> 中间也是  </b>  收尾  ' + PAD + '</p>',
    '<p><b>a</b><b>b</b>与<a href="/x">链接</a>' + PAD + '</p>',
  ]
  for (const html of fixtures) {
    const block = firstP('<article>' + html + '</article>')
    assert.ok(block !== undefined)
    if (block.runs === undefined) continue
    assert.equal(
      block.runs.map((run) => run.text).join(''),
      block.text,
      '严格相等（不是「归一化后相等」）：' + html.slice(0, 40),
    )
  }
})

test('归一化先于切 run：text 必须无换行、无连续空白（严格相等是自证的，这条才钉得住顺序）', () => {
  // ⚠️ 为什么需要这条：`runs.map(r=>r.text).join('') === text` 在「text 由 runs 派生」之后是
  // **自证**的——只要 text 是从 runs 算出来的，它永远成立，抓不到「归一化放错位置」。
  // 真正钉住顺序的是**字面期望值**：源 HTML 里的缩进与连续空白必须已经被收敛。
  const long = '这是一段足够长的正文内容用来确认这一段不会被四十字符门槛丢掉再多写一点点。'
  const block = firstP('<article><p>  前置空白  <b> 中间  </b>  收尾  ' + long + '</p></article>')
  assert.ok(block !== undefined)
  assert.equal(
    block.text,
    '前置空白 中间 收尾 ' + long,
    '连续空白收敛成单空格、首尾 trim；若归一化放到切 run 之后，这里会留着原始缩进',
  )
  assert.ok(!/\s{2}/.test(block.text), 'text 里不许有连续空白')
  assert.ok(!/\n/.test(block.text), 'text 里不许有换行（块内折行是块边界，不是文本内容）')
  // run 文本也必须是归一化后的形态（不能只有 text 干净、runs 脏）
  for (const run of block.runs ?? []) {
    assert.ok(!/\s{2}/.test(run.text), 'run 文本里不许有连续空白：' + JSON.stringify(run.text))
  }
})

test('不变量：纯文本段落不产出 runs（否则磁盘占用平白翻倍）', () => {
  const block = firstP('<article><p>' + PAD + PAD + '</p></article>')
  assert.ok(block !== undefined, '前提：段落必须过 40 字门槛')
  assert.equal(block.runs, undefined, '没有内联语义的段落不许塞一个 text run')
})

test('内联：run 数不超过块级内联标签数 + 1（每字符一个 <b> 也不许爆炸）', () => {
  // 极端夹具：38 个汉字，每个字各包一个 <b> —— 若实现不合并，会得到 38 个 run
  const chars = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥甲乙丙丁戊己'
  const html = '<article><p>' + [...chars].map((char) => '<b>' + char + '</b>').join('') + PAD + '</p></article>'
  const block = firstP(html)
  assert.ok(block.runs !== undefined)
  assert.equal(block.runs.filter((run) => run.kind === 'strong').length, 1, '相邻同类 run 必须合并成一个')
  assert.ok(block.runs.length <= 3, 'run 数必须远小于标签数，实际 ' + block.runs.length)
})

test('内联：<br> 仍切块（两个段落块），<br> 本身不产生 run', () => {
  const first = '第一段文字内容足够长以便通过四十字符门槛的判断与观察验证。'.repeat(2)
  const second = '第二段文字内容同样足够长以便通过门槛的判断与观察验证确认。'.repeat(2)
  const blocks = extractArticle('<article><p>' + first + '<br>' + second + '</p></article>', BASE).blocks
  assert.equal(blocks.length, 2, '<br> 是块分隔，不是 run')
  assert.deepEqual(blocks.map((block) => block.text), [first, second])
})

test('内联：p 内部的裸换行也切块（与 <br> 同一行为，保持既有语义）', () => {
  const first = '第一段文字内容足够长以便通过四十字符门槛的判断与观察验证。'.repeat(2)
  const blocks = extractArticle('<article><p>' + first + '\n' + first + '</p></article>', BASE).blocks
  assert.equal(blocks.length, 2, '源 HTML 折行仍是块边界（既有行为，不许被归一化吃掉）')
})

test('内联：占位符不许进 items / itemRuns（<li> 里嵌 <pre>）', () => {
  const long = '列表项文字足够长以便通过四十字符门槛的判断，这里再加一些文字凑够长度。'
  const blocks = extractArticle(
    '<article><ul><li>' + long + '<pre>code()</pre></li><li>' + long + '</li></ul><p>' + PAD.repeat(3) + '</p></article>',
    BASE,
  ).blocks
  const list = blocks.find((block) => block.kind === 'list')
  assert.ok(list !== undefined, '列表块必须保留')
  for (const item of list.items) assert.ok(!item.includes('\u0000'), 'items 里不许出现内部占位符：' + JSON.stringify(item))
  for (const runs of list.itemRuns ?? []) {
    for (const run of runs) assert.ok(!run.text.includes('\u0000'), 'run 文本里不许出现内部占位符')
  }
})

test('内联：列表项里的链接进 itemRuns，且与 items 等长同序', () => {
  const long = '列表项文字足够长以便通过四十字符门槛的判断，这里再加一些文字凑够长度。'
  const blocks = extractArticle(
    '<article><ul><li>详见<a href="/d">文档</a>。' + long + '</li><li>' + long + '</li></ul><p>' + PAD.repeat(3) + '</p></article>',
    BASE,
  ).blocks
  const list = blocks.find((block) => block.kind === 'list')
  assert.ok(list !== undefined)
  assert.ok(list.itemRuns !== undefined, '有链接的列表必须产出 itemRuns')
  assert.equal(list.itemRuns.length, list.items.length, 'itemRuns 与 items 等长')
  assert.equal(list.itemRuns[0].map((run) => run.text).join(''), list.items[0], '逐项严格相等')
  assert.equal(list.itemRuns[1].map((run) => run.text).join(''), list.items[1], '逐项严格相等（纯文本项也一样）')
  const link = list.itemRuns[0].find((run) => run.kind === 'link')
  assert.ok(link !== undefined)
  assert.equal(link.href, 'https://ex.test/d')
})

test('内联：标题与引用也带 runs', () => {
  const heading = extractArticle('<article><h2>这是<b>标题</b>里的加粗</h2><p>' + PAD.repeat(2) + '</p></article>', BASE)
    .blocks.find((block) => block.kind === 'h')
  assert.ok(heading !== undefined)
  assert.equal(heading.text, '这是标题里的加粗')
  assert.equal(heading.runs.find((run) => run.kind === 'strong')?.text, '标题')

  const quote = extractArticle('<article><blockquote>引用里的<a href="/q">链接</a></blockquote><p>' + PAD.repeat(2) + '</p></article>', BASE)
    .blocks.find((block) => block.kind === 'quote')
  assert.ok(quote !== undefined)
  assert.equal(quote.text, '引用里的链接')
  assert.equal(quote.runs.find((run) => run.kind === 'link')?.href, 'https://ex.test/q')
})

test('门槛判可见字符数：38 个汉字 + 6 个 <b> 的段落被丢弃，再加 3 个字被保留', () => {
  const base = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥甲乙丙丁戊己'
  assert.equal(base.length, 38, '夹具前提：38 个汉字')
  // 每 6 个字插一对 <b>，共 6 对 —— 旧实现 htmlToText 会数出 50 字（保留），实际只有 38 字可读
  const marked = (chars) => {
    const pairs = [0, 6, 12, 18, 24, 30]
    let html = ''
    for (const at of pairs) html += chars.slice(at, at + 3) + '<b>' + chars.slice(at + 3, at + 6) + '</b>'
    return html + chars.slice(36)
  }
  const dropped = extractArticle('<article><p>' + marked(base) + '</p></article>', BASE).blocks
  assert.equal(dropped.length, 0, '38 个可见字符低于 40 字门槛，必须丢弃（不许用插了空格的假长度凑数）')
  const kept = extractArticle('<article><p>' + marked(base + '甲乙丙') + '</p></article>', BASE).blocks
  assert.equal(kept.length, 1, '41 个可见字符应当保留')
  assert.equal(kept[0].text.length, 41)
})

test('搜索顺带修好：句子边界的词从搜不到变成搜得到', () => {
  // 旧实现把 "详见<a>官方文档</a>。" 变成 "详见 官方文档 。"，于是「详见官方文档」这个连续串搜不到。
  const block = firstP('<article><p>详见<a href="https://ex.test/d">官方文档</a>。' + PAD + '</p></article>')
  assert.ok(block.text.includes('详见官方文档'), '连续串必须可被搜索命中（旧实现是 "详见 官方文档 。"）')
})

/**
 * —— 表格块（R5 04）——
 *
 * 为什么这一族值得单独一组：一张参数对照表在旧实现里被 `tr` / `td` 边界切成若干段流水文字，
 * 行列关系彻底读不出来；更隐蔽的是它**不占字符额度**（`table` 块没有 `text` / `items` 字段），
 * 于是一张大表格在缓存淘汰口径里等于不存在。
 */

/** 取第一个表格块。 */
const firstTable = (html, base = BASE) => extractArticle(html, base).blocks.find((block) => block.kind === 'table')

test('表格：<thead> 的行进 header，其余行进 rows；没有 align 属性时字段整体缺席', () => {
  const table = firstTable(
    '<article><table>'
    + '<thead><tr><th>参数</th><th>值</th></tr></thead>'
    + '<tbody><tr><td>电压</td><td>220V</td></tr><tr><td>电流</td><td>10A</td></tr></tbody>'
    + '</table><p>' + PAD + '</p></article>',
  )
  assert.ok(table !== undefined, '表格块被整块丢掉了')
  assert.deepEqual(table.header, ['参数', '值'], 'thead 里的行必须是表头')
  assert.deepEqual(table.rows, [['电压', '220V'], ['电流', '10A']], '表体行要按行列保留')
  // 全列都没声明 align ⇒ 字段整体缺席，不是 [undefined, undefined]
  assert.equal('align' in table, false, '没有声明 align 时不许产出 align 字段')
})

test('表格：没有 thead 但首行全是 th 也当表头；纯 td 的表头缺席', () => {
  // 很多站点不写 thead，只把首行加粗 —— 判据是「首行全是 th」，不是「有没有 thead 标签」
  const implicit = firstTable(
    '<article><table><tr><th>型号</th><th>功率</th></tr><tr><td>A1</td><td>5W</td></tr></table><p>' + PAD + '</p></article>',
  )
  assert.ok(implicit !== undefined)
  assert.deepEqual(implicit.header, ['型号', '功率'], '首行全 th 必须当表头')
  assert.deepEqual(implicit.rows, [['A1', '5W']], '表头行不许同时留在 rows 里（否则首行显示两次）')

  // 纯 td：没有表头可言，全部行进 rows，header 字段缺席
  const plain = firstTable(
    '<article><table><tr><td>甲</td><td>乙</td></tr><tr><td>丙</td><td>丁</td></tr></table><p>' + PAD + '</p></article>',
  )
  assert.ok(plain !== undefined)
  assert.equal('header' in plain, false, '纯 td 的表格不许编造表头')
  assert.deepEqual(plain.rows, [['甲', '乙'], ['丙', '丁']])

  // 首行只有**部分**是 th 时不认表头：判据是「全是 th」，混排说明它不是表头行
  const mixed = firstTable(
    '<article><table><tr><th>甲</th><td>乙</td></tr><tr><td>丙</td><td>丁</td></tr></table><p>' + PAD + '</p></article>',
  )
  assert.ok(mixed !== undefined)
  assert.equal('header' in mixed, false, '首行混排 th/td 不构成表头')
  assert.deepEqual(mixed.rows, [['甲', '乙'], ['丙', '丁']])
})

test('表格：colspan 内容进起始列、被跨列留空；每行等长', () => {
  const table = firstTable(
    '<article><table>'
    + '<tr><th>项目</th><th colspan="2">规格</th></tr>'
    + '<tr><td>尺寸</td><td>宽</td><td>高</td></tr>'
    + '</table><p>' + PAD + '</p></article>',
  )
  assert.ok(table !== undefined)
  assert.deepEqual(table.header, ['项目', '规格', ''], 'colspan=2 的内容在起始列，下一列留空')
  assert.deepEqual(table.rows, [['尺寸', '宽', '高']])
  // 每行等长是「行列不错位」的可测形式：不存在短行，也不存在超宽行
  const widths = [table.header.length, ...table.rows.map((row) => row.length)]
  assert.deepEqual([...new Set(widths)], [3], '每行长度必须相等且等于 colCount，实际：' + JSON.stringify(widths))

  // ⚠️ colspan 后面**还有单元格**的形态才是真正的判据（上面那条不够）：
  // 被跨的列若不被占住，后面的「备注」会左移到第 2 列，整行与表头错位。
  // 而「colspan 是行内最后一格」时，短行右补空串会把差异原样补回来 —— 实测：只测那种形态
  // 时变异 `table-合并单元格错位` 幸存（78ms 全绿），补了这一条才见红。
  const followed = firstTable(
    '<article><table>'
    + '<tr><th>项目</th><th colspan="2">规格</th><th>备注</th></tr>'
    + '<tr><td>尺寸</td><td>宽</td><td>高</td><td>正常</td></tr>'
    + '</table><p>' + PAD + '</p></article>',
  )
  assert.ok(followed !== undefined)
  assert.deepEqual(followed.header, ['项目', '规格', '', '备注'],
    'colspan 之后的单元格必须留在第 4 列（被跨列不许被它占去）')
  assert.deepEqual(followed.rows, [['尺寸', '宽', '高', '正常']], '数据行同样不许左移')
})

test('表格：rowspan 的后续行被占列留空且位置正确（不左移）', () => {
  const table = firstTable(
    '<article><table>'
    + '<tr><th>区域</th><th>站点</th><th>读数</th></tr>'
    + '<tr><td rowspan="2">北区</td><td>A</td><td>1</td></tr>'
    + '<tr><td>B</td><td>2</td></tr>'
    + '</table><p>' + PAD + '</p></article>',
  )
  assert.ok(table !== undefined)
  assert.deepEqual(table.header, ['区域', '站点', '读数'])
  // 第二行没有「区域」格 —— 它被上一行占住。若实现不记占位，这里会变成 ['B','2','']：
  // 站点与读数各左移一列，整张表与表头错位。
  assert.deepEqual(table.rows, [
    ['北区', 'A', '1'],
    ['', 'B', '2'],
  ], 'rowspan 的后续行该列必须留空且**不左移**')
})

test('表格：畸形行归一后每行等长且等于 colCount（短行右补空串，长行撑宽全表）', () => {
  // 短行：第二行少一格 ⇒ 右补空串；长行：第三行多一格 ⇒ colCount 取最大值，全表跟着变宽。
  // 这是「不猜测合并语义」的直接代价（spec 决策 17 接受它），比悄悄丢数据可预期。
  const table = firstTable(
    '<article><table>'
    + '<tr><td>a1</td><td>a2</td><td>a3</td></tr>'
    + '<tr><td>b1</td></tr>'
    + '<tr><td>c1</td><td>c2</td><td>c3</td><td>c4</td></tr>'
    + '</table><p>' + PAD + '</p></article>',
  )
  assert.ok(table !== undefined)
  assert.deepEqual(table.rows, [
    ['a1', 'a2', 'a3', ''],
    ['b1', '', '', ''],
    ['c1', 'c2', 'c3', 'c4'],
  ], '每行都要补齐到 colCount=4')
  const widths = new Set(table.rows.map((row) => row.length))
  assert.deepEqual([...widths], [4], '每行长度必须相等')
})

test('表格：rowspan 超出表尾时只作用到表尾，不撑出空行', () => {
  // 第二行（表尾）声明 rowspan=5：越界的 4 行必须被忽略 —— 既不许补出 4 个空行，
  // 也不许让别的行少一格（那会变成「表尾突然变窄」）。
  const table = firstTable(
    '<article><table>'
    + '<tr><td rowspan="5">跨到底</td><td>a2</td></tr>'
    + '<tr><td>b2</td></tr>'
    + '</table><p>' + PAD + '</p></article>',
  )
  assert.ok(table !== undefined)
  assert.equal(table.rows.length, 2, 'rowspan 越界不许凭空多出行')
  assert.deepEqual(table.rows, [['跨到底', 'a2'], ['', 'b2']], '越界跨度只作用到表尾（本行就是表尾）')
})

test('表格：<tfoot> 丢弃、<caption> 不进数据行、单元格空白收敛成单空格', () => {
  const table = firstTable(
    '<article><table>'
    + '<caption>表一：参数对照</caption>'
    + '<thead><tr><th>参数</th><th>值</th></tr></thead>'
    + '<tbody><tr><td>\n  电压 \n  </td><td>220V</td></tr></tbody>'
    + '<tfoot><tr><td>脚注不该出现</td><td>x</td></tr></tfoot>'
    + '</table><p>' + PAD + '</p></article>',
  )
  assert.ok(table !== undefined)
  assert.deepEqual(table.header, ['参数', '值'])
  // caption 与 tfoot 的内容都不许混进数据行；单元格内部的换行与多余空白收敛成单空格
  assert.deepEqual(table.rows, [['电压', '220V']], 'tfoot / caption 不得进数据行，单元格空白要收敛')
  const flat = JSON.stringify(table)
  assert.ok(!flat.includes('脚注不该出现'), 'tfoot 必须整块丢弃')
  assert.ok(!flat.includes('参数对照'), 'caption 不是数据行（本轮不做 caption 块）')
})

test('表格：align 只认 align 属性，style="text-align" 不读，全列未声明时字段整体缺席', () => {
  // 属性形态：按**列**取第一个声明的值；整列都没声明的列在数组里保留 undefined 空位
  // （第 2 列的表头与单元格都没写 align ⇒ 该位是 undefined，且后面第 3 列不许因此左移）
  const byAttr = firstTable(
    '<article><table>'
    + '<tr><th align="center">参数</th><th>值</th><th align="right">备注</th></tr>'
    + '<tr><td>电压</td><td>220V</td><td align="left">正常</td></tr>'
    + '</table><p>' + PAD + '</p></article>',
  )
  assert.ok(byAttr !== undefined)
  assert.deepEqual(byAttr.align, ['center', undefined, 'right'],
    '按列取第一个声明：第 1 列来自 th，第 2 列两行都没声明 ⇒ undefined，第 3 列来自 th（td 的 left 是第二声明）')
  // 「第一个声明的值」而不是「最后一个」：第 3 列 th=right、td=left，取 right
  assert.equal(byAttr.align[2], 'right', '同一列多处声明时取**第一个**（文档顺序，表头先于表体）')

  // style 形态：**不读**（CSS 解析是脆弱规则且没有实测样本，spec 决策 19a 留在外面）
  const byStyle = firstTable(
    '<article><table>'
    + '<tr><th style="text-align:center">参数</th><th>值</th></tr>'
    + '<tr><td style="text-align: right">电压</td><td>220V</td></tr>'
    + '</table><p>' + PAD + '</p></article>',
  )
  assert.ok(byStyle !== undefined)
  assert.equal('align' in byStyle, false, 'style="text-align:…" 不许被读成 align')

  // 非法值（justify 等）忽略
  const byJustify = firstTable(
    '<article><table><tr><td align="justify">甲</td></tr></table><p>' + PAD + '</p></article>',
  )
  assert.ok(byJustify !== undefined)
  assert.equal('align' in byJustify, false, 'justify 不在 left/center/right 里，必须忽略')
})

test('纯文本投影：表格块摊成「表头一行 + 每行一行」，不许算成空', () => {
  // 为什么钉字面值而不是「runs 拼接」之类的派生量：期望值必须来自独立来源（spec 决策 10 的
  // 「表头 + 各行单元格按行拼接（行内用空格分隔）」）。表头与单元格各一行的形态也是搜索投影
  // 与字符统计的口径 —— 表格若被投影成空串，搜索搜不到、额度算成 0、时长算成 0，三处一起瞎。
  const text = blocksToText([{ kind: 'table', header: ['参数', '标称值'], rows: [['额定功率', '5W'], ['输入电压', '220V']] }])
  assert.equal(text, '参数 标称值\n额定功率 5W\n输入电压 220V')

  // 没有表头的表格（纯 td）只有数据行，不许凭空补一行表头
  assert.equal(blocksToText([{ kind: 'table', rows: [['甲', '乙']] }]), '甲 乙')
})

test('表格：<figure> 里的表格不被吞（三种形态都要救回来）', () => {
  const table = '<table><tr><th>参数</th><th>值</th></tr><tr><td>电压</td><td>220V</td></tr></table>'
  const tableOf = (html) => extractArticle('<article>' + html + '<p>' + PAD + '</p></article>', BASE)
    .blocks.filter((block) => block.kind === 'table')

  // 形态一：figure 里只有 table（旧实现返回 ' ' 整块丢弃 —— 实测确认过）
  const onlyTable = tableOf('<figure>' + table + '</figure>')
  assert.equal(onlyTable.length, 1, '<figure><table> 的表格必须救回来（旧实现整块丢）')
  assert.deepEqual(onlyTable[0].rows, [['电压', '220V']])

  // 形态二：figure 里既有 img 又有 table（旧实现找到 img 后把 inner 其余内容一起丢 ——
  // 这是票据原文没覆盖的形态，实测确认表格也会丢）
  const imgAndTable = tableOf('<figure><img src="https://cdn.test/a.png">' + table + '</figure>')
  assert.equal(imgAndTable.length, 1, '<figure><img><table> 的表格也必须留下')
  const kinds = extractArticle('<article><figure><img src="https://cdn.test/a.png">' + table + '</figure><p>' + PAD + '</p></article>', BASE)
    .blocks.map((block) => block.kind)
  assert.ok(kinds.includes('img') && kinds.includes('table'), '图片与表格必须都在，实际：' + kinds.join(','))

  // 形态三：figure 里只有 pre（旧实现同样整块丢；本票顺手一起救回，见「已知限制」的说明）
  const preOnly = extractArticle('<article><figure><pre>code here</pre></figure><p>' + PAD + '</p></article>', BASE)
    .blocks.filter((block) => block.kind === 'pre')
  assert.equal(preOnly.length, 1, '<figure><pre> 的代码块必须救回来（同为 figure 吞内容的形态）')

  // 既有行为不变：figure 里既无 img 也无 table / pre 时仍整块丢弃（纯装饰容器）。
  // 段落用 PAD.repeat(2)：PAD 本身只有 37 字，单个不够 40 字门槛，会得到空块 —— 那会让这条
  // 断言因为「段落被门槛丢掉」而假绿（实测踩到）。
  const decorative = extractArticle('<article><figure><figcaption>只是图注</figcaption></figure><p>' + PAD.repeat(2) + '</p></article>', BASE)
    .blocks
  assert.deepEqual(decorative.map((block) => block.kind), ['p'], '无 img / table / pre 的 figure 仍整块丢弃')
  assert.ok(!JSON.stringify(decorative).includes('只是图注'), '被丢弃的 figure 内容不许泄漏进正文')
})

test('内联：标签外的空格不并入链接（真机实测踩到：链接可点区域比看起来宽）', () => {
  // 真实形态（sspai 实测）：空格写在 <a> **外面**。若归一化把收敛出来的空格按「归前一个 / 归后一个」
  // 这种邻接规则分配，链接的可点区域会变成 " Vaultwarden" 或 "Vaultwarden "。
  // 判据：空白字符属于哪个 run，收敛后的那个空格就归哪个 run。
  const html = '<article><p>' + PAD + '自托管一个 <a href="/x">Vaultwarden</a> 自然而然提上了日程。</p></article>'
  const block = firstP(html)
  assert.ok(block !== undefined)
  const link = block.runs.find((run) => run.kind === 'link')
  assert.ok(link !== undefined)
  assert.equal(link.text, 'Vaultwarden', '标签外的空格不许并进链接文本')
  assert.equal(block.runs.map((run) => run.text).join(''), block.text, '不变量仍成立')
})

test('内联：标签内的空格属于链接（按空白自身归属，不是一刀切）', () => {
  // 与上一条是同一个判据的两面：空格在标签**内**时，它就属于那段链接文本（作者把它写进了 <a>）。
  // 一刀切「链接永远 trim」会让这种写法与源不一致，也会让 join===text 破掉。
  const html = '<article><p>' + PAD + '自托管一个<a href="/x"> Vaultwarden </a>自然而然提上了日程。</p></article>'
  const block = firstP(html)
  const link = block.runs.find((run) => run.kind === 'link')
  assert.ok(link !== undefined)
  assert.equal(link.text, ' Vaultwarden ', '标签内的空格保留在链接里（源里就在 <a> 之内）')
  assert.equal(block.runs.map((run) => run.text).join(''), block.text, '不变量仍成立')
})

test('内联：列表项 / 引用 / 标题里嵌的块不许静默消失', () => {
  // 评审实测抓到的回归：保护 pass 顺序是 figure → pre → table → ul → blockquote → img → h*，
  // 所以 li 里的 table 先被换成占位符，再轮到 ul 调内联解析。若占位符只是「切段时丢掉」，
  // 那份 table 块就再也不会被取出——读者丢内容，而且是静默的（基线是把表格摊成文字保住的）。
  const long = '列表项文字足够长以便通过四十字符门槛的判断，这里再加一些文字凑够长度。'
  const table = '<table><tr><td>参数</td><td>值</td></tr><tr><td>电压</td><td>220V</td></tr></table>'

  const list = extractArticle('<article><ul><li>' + long + table + '</li><li>' + long + '</li></ul></article>', BASE).blocks
  assert.ok(JSON.stringify(list).includes('220V'), 'li 里嵌的表格文字必须还在，实际：' + JSON.stringify(list.map((b) => b.kind)))

  const quote = extractArticle('<article><blockquote>' + long + table + '</blockquote></article>', BASE).blocks
  assert.ok(JSON.stringify(quote).includes('220V'), 'blockquote 里嵌的表格文字必须还在')

  const heading = extractArticle('<article><h2>标题' + table + '</h2><p>' + long.repeat(2) + '</p></article>', BASE).blocks
  assert.ok(JSON.stringify(heading).includes('220V'), '标题里嵌的表格文字必须还在')
})

test('表格：单元格里嵌的块不许漏出内部占位符', () => {
  // pre pass 先于 table pass 跑，所以 <td><pre>x=1</pre></td> 的单元格里会留下占位符。
  // 单元格是纯字符串（装不下一个块），所以只能把占位符剥掉——但它绝不能作为字符留下：
  // 读者会在表格里看到 `B0`（NUL 不可见），同时污染搜索索引与字符统计。
  const long = '正文段落内容重复以跨过门槛的判断并且确认它会被保留下来。'.repeat(3)
  const blocks = extractArticle(
    '<article><table><tr><th>代码示例</th></tr><tr><td><pre>x=1</pre></td></tr></table><p>' + long + '</p></article>',
    BASE,
  ).blocks
  const table = blocks.find((block) => block.kind === 'table')
  assert.ok(table !== undefined, '表格块必须保留')
  // ⚠️ 不能用 `JSON.stringify(table).includes('\u0000')`：JSON.stringify 会把 NUL **转义**成
  // 字面的反斜杠 u0000 六个字符，于是「含真实 NUL」永远判成 false —— 那是条空断言
  // （2026-11-21 变异实测：改成这个写法后 `table-单元格漏出占位符` 直接幸存）。
  // 直接查单元格字符串本身。
  for (const cell of table.rows.flat()) {
    assert.ok(!cell.includes('\u0000'), '单元格里不许出现内部占位符：' + JSON.stringify(cell))
  }
  for (const cell of table.header ?? []) {
    assert.ok(!cell.includes('\u0000'), '表头里不许出现内部占位符：' + JSON.stringify(cell))
  }
})
