/**
 * 客户端样式表的结构判据（R15 08 回归）。
 *
 * 病象：票 08 往 `STYLE` 里插入精选源规则时，把 `.dsh-rss-explore-url` 的收尾行
 * `font-size:12px; overflow-wrap:anywhere; }` 挤掉了。少一个 `}` 会让紧随其后的整段
 * `.dsh-rss-pack-*` 规则被当成 `explore-url` 的属性文本吞掉 —— 精选源视图的布局全部失效，
 * 而任何组件测试都照绿（CSS 不参与 render 断言）。
 *
 * 所以这里钉两条**结构不变量**：
 *   1. 样式表的 `{` / `}` 必须配平（少一个就说明有规则被吞）；
 *   2. `.dsh-rss-explore-url` 与 `.dsh-rss-pack-page` 必须是两条各自闭合的完整规则，
 *      且前者带上它原本就有的字号 / 换行属性。
 *
 * 读 `src/client/index.tsx` 而不是 `lib/client.js`：这类判据要的是源码里的规则边界，
 * bundle 只是把同一份字符串再包一层；样式表不是「lib 产物才生效」的那类逻辑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync('src/client/index.tsx', 'utf8')
const START = 'const STYLE = `'
const start = source.indexOf(START)
assert.notEqual(start, -1, '找不到 STYLE 模板字面量：测试锚点需要跟着源码结构调整')
const end = source.indexOf('\n`', start + START.length)
assert.notEqual(end, -1, '找不到 STYLE 模板字面量的结束反引号')
const css = source.slice(start + START.length, end)

/** 取一条**独立闭合**的规则体；贪婪到第一个 `}` 就能发现「被下一条选择器吞掉」。 */
function ruleBodyOf(selector) {
  const match = css.match(new RegExp('\\' + selector + '\\s*\\{([^}]*)\\}'))
  assert.ok(match !== null, '缺少规则：' + selector)
  return match[1]
}

test('样式表花括号配平，且 explore-url / pack-page 是各自独立的完整规则', () => {
  const opens = (css.match(/\{/g) ?? []).length
  const closes = (css.match(/\}/g) ?? []).length
  assert.equal(opens, closes,
    'CSS 花括号必须配平（少一个 `}` 会把后面的规则整段吞进前一条规则）')

  const exploreUrl = ruleBodyOf('.dsh-rss-explore-url')
  assert.match(exploreUrl, /flex:1 1 240px/, '拼出的地址仍是可伸缩的 monospace 块')
  assert.match(exploreUrl, /font-size:12px/, '收尾的字号属性必须回到 explore-url 自己身上')
  assert.match(exploreUrl, /overflow-wrap:anywhere/, '长地址必须能换行')
  assert.equal(exploreUrl.includes('.dsh-rss-pack-page'), false,
    'explore-url 的规则里出现 pack-page 选择器 ⇒ 它吞掉了下一段规则')

  const packPage = ruleBodyOf('.dsh-rss-pack-page')
  assert.match(packPage, /overflow-y:auto/, '精选源页仍是独立可滚动的容器')
})
