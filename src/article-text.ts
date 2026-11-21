/**
 * 正文块的**纯文本投影**（块模型 → 纯文本），零 node 依赖。
 *
 * 为什么必须独立于 `article.ts`（2026-11-21，R5 01）：`article.ts` import 了 `node:crypto` 与
 * `feed/fetch.js`（后者 import `node:dns/promises`），是 host-only 模块。而纯文本投影的消费者里，
 * `shared.ts` 的 `estimateReadingMinutes` 会打进客户端 bundle（`lib/client.js` 至今没有任何
 * `node:` 说明符），`search-worker.ts` 跑在 worker 线程。投影若住在 `article.ts`，client 侧一 import
 * 就把 node 内建拉进浏览器包 —— 而 `tsdown` 不会因此失败（它把内建原样留成 `require("node:crypto")`），
 * 失败被推迟到运行期。见 `docs/pitfalls.md` §1.7b。
 *
 * **依赖方向是单向的**：`article.ts` → 本模块。本模块**不许** import `article.js`（一旦反向，
 * 上面那条意义当场失效），也不许 import 任何 `node:*`。
 *
 * **与 `html-text.ts` 的边界**（两者的输入输出看起来都像「文本」，但服务的是两条不同的路径）：
 * - `htmlToText`：**HTML 片段 → 纯文本**。它服务「**没有 runs 的路径**」—— `pre` 之外的旧缓存、
 *   R4 的回退摘要（`paragraphsOf`）、列表行摘要。它的「标签→空格」是**有意的**，不是待修的遗留。
 * - 本模块：**块模型 → 纯文本**。它服务「已经抽成结构化块的正文」，是搜索 / 阅读时长 / 字符统计 /
 *   日志 / agent 工具共同的那一份投影。
 * 两者不是同一件事，**不许合并**：合并会让 `html-text.ts` 反过来依赖块形状，而它是 client/host
 * 共用的最底层。
 */

/**
 * 块内的一段内联语义。
 *
 * 五种 run 覆盖「技术文章正文里一半的信息在标记里」的那几种标记：链接 / 加粗 / 斜体 / 行内代码 /
 * 普通文字。**不做嵌套**：`<strong><em>x</em></strong>` 取最外层语义，内层样式丢失（有意，见 ADR-0007）。
 *
 * 为什么住在零 node 模块：渲染在客户端，派生 `text` 在宿主，两边都要认这个类型。
 */
export type InlineRun =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'strong'; readonly text: string }
  | { readonly kind: 'em'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'link'; readonly text: string; readonly href: string }

/**
 * 一份 run 流 → 纯文本。
 *
 * 这是「`text` 是 `runs` 的派生投影」这条不变量的**唯一**实现（ADR-0007）：带 runs 的块，其 `text`
 * 必须由本函数得出，不许再走 `htmlToText`——后者给每个标签塞一个空格，`"详见<a>官方文档</a>。"`
 * 会变成 `"详见 官方文档 。"`，于是「显示有链接、搜不到那个词」从结构上就躲不掉了。
 *
 * 归一化**不在这里做**：它必须发生在切 run 之前（否则 run 文本里带原始换行缩进，拼接结果与
 * 归一化过的 `text` 必然不等）。见 `collapseWhitespace`。
 */
export function runsToText(runs: readonly InlineRun[]): string {
  return runs.map((run) => run.text).join('')
}

/**
 * 可见文本的空白归一化：**连续空白收敛成单空格，再 trim**。
 *
 * 为什么需要它（2026-11-21，实测）：`htmlToText('<p>\n  <b>foo</b>\n  bar\n</p>')` ⇒ `"foo bar"`。
 * 真实 HTML 的 `<p>` 内部几乎总有换行与缩进，所以「先把可见文本归一化、再在归一化后的文本上切 run」
 * 是让 `runs.map(r => r.text).join('') === text` **严格相等**成立的前提。顺序反了，那条不变量当场红；
 * 而若改成「两边各自归一化后相等」这种弱判据，「`text` 里多一处空格」这类真实缺陷就会逃过判据
 * —— 空格恰恰是本仓库踩过的坑（`"详见 官方文档 。"` 让句子边界搜索失配）。
 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 只放行 http/https（挡掉 `javascript:` / `data:` —— 后者还可能是 1x1 跟踪像素）。
 *
 * 为什么住在零 node 模块而不是 `article.ts`：内联解析器（`article.ts`）与图片挑选（`pickImageUrl`）
 * 都要复用它，而它此前是 `article.ts` 的**模块私有**函数 —— 解析器不在那个文件里就拿不到。
 * `article.ts` 对本函数做 re-export，既有调用点一行不改。
 *
 * @param raw  - 原始地址（可能带空白、可能是相对地址）。
 * @param base - 解析相对地址的基准（正文路径必须传**重定向落点** finalUrl，不是请求 URL）。
 */
export function safeUrl(raw: string | undefined, base: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.startsWith('data:')) return undefined
  try {
    const resolved = base === undefined ? new URL(trimmed) : new URL(trimmed, base)
    return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.toString() : undefined
  } catch {
    return undefined
  }
}

/** 单元格 → 文本。表格单元格在块模型里是纯字符串；宽松输入按字符串读，不猜别的形状。 */
function cellToText(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '')
}

/**
 * 表格块 → 纯文本：**表头一行 + 每行单元格按行拼接（行内用空格分隔）**。
 *
 * 为什么表格需要自己的投影：它两个字段（`text` / `items`）都没有 —— 只按 `text` / `items` 读的实现
 * 会把整张表算成 0 字符，于是「一张大表格不占缓存额度」、搜索也搜不到表里的词。
 *
 * 入参是**块记录**而不是拆开的 `header` / `rows`：调用方手上从来只有一个块，拆开只会让每个调用点
 * 各写一遍取字段的代码（那正是本项要收口的东西）。
 */
export function tableToText(block: Record<string, unknown>): string {
  const lines: string[] = []
  const header = block['header']
  if (Array.isArray(header) && header.length > 0) lines.push(header.map(cellToText).join(' '))
  const rows = block['rows']
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (Array.isArray(row)) lines.push(row.map(cellToText).join(' '))
    }
  }
  return lines.join('\n')
}

/**
 * 单个块 → 纯文本。
 *
 * 入参用 `Record<string, unknown>` 而不是 `ArticleBlock`：**依赖方向不能反向**——块类型住在
 * host-only 的 `article.ts`，本模块若 import 它就把 `node:crypto` 拉回来。宽松入参让
 * `readonly ArticleBlock[]` 能直接传进来（`tsc --strict` 下成立），也让搜索 worker / 存储层
 * 手上那份「从 JSON 读回来的块」不必先声明成宿主类型。
 */
export function blockToText(block: Record<string, unknown>): string {
  const kind = block['kind']
  // 图片没有正文可读，alt 是它唯一可能携带的文字（缺席即空串，不编造占位文字）
  if (kind === 'img') return String(block['alt'] ?? '')
  if (kind === 'list') {
    const items = block['items']
    return Array.isArray(items) ? items.map(cellToText).join(' ') : ''
  }
  if (kind === 'table') return tableToText(block)
  return String(block['text'] ?? '')
}

/**
 * 块列表 → 纯文本（用于长度统计、搜索投影与日志）。
 *
 * ⚠️ 这是「富文本怎么压成纯文本」的**唯一**实现。七处消费者（搜索 / 阅读时长 / 字符统计三处 /
 * 日志 / agent 工具）要么改走它、要么读抽取时已派生好的 `text` / `items` —— **不许各自遍历 runs
 * 或表格的行列**：它们分布在不同的进程（搜索在 worker 线程）与不同的层（存储淘汰、Agent 工具），
 * 下次改这条规则时漏一处不会有任何断言翻红。
 *
 * 注意 `tools.ts` 里另有一个**输出 Markdown** 的 `blocksToMarkdown`：它服务「模型读 Markdown」，
 * 与本函数的「统计读纯文本」是两个口径，**不许合并**。
 */
export function blocksToText(blocks: readonly Record<string, unknown>[]): string {
  return blocks.map(blockToText).join('\n')
}
