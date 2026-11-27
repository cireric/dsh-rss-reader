/**
 * 「精选源」勾选条目 → OPML（R15 09，spec §4.3.2 / §6 A14）。
 *
 * 为什么不直接复用宿主 `src/opml.ts` 的 `buildOpml`：宿主模块 import 了 fast-xml-parser 与
 * `./refresh.js`（Node 侧模块）。客户端是一个单文件 bundle，既不许引第三方库，也不许引 node 内建
 * （docs/pitfalls.md §1.7 / §1.7b）—— 把宿主序列化器拖进来会直接打坏构建。
 *
 * 因此这里只保留宿主 `parseOpml` 认得的**最小子集**：`<outline text title xmlUrl>`。
 * 正确性不靠两条代码长得像，而靠 `tests/source-pack-import.test.mjs` 的 round-trip：
 * 客户端拼出的文本交给**真实的宿主 parseOpml**，解析出的 URL 与 folder 必须与条目一致。
 */
import type { CuratedSourceEntry } from '../shared.js'

/** XML 文本与属性值转义（& 必须最先替换，否则会把自己引入的实体再转义一次）。 */
function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * 把选中的源包条目拼成 OPML 2.0 文本。
 *
 * `category` 映射为分组 outline（宿主 parseOpml 把容器名写进订阅的 folder）；未分类条目直接挂在
 * `<body>` 下，folder 为空。分组顺序取首次出现顺序、组内保持条目顺序：同一份勾选永远得到同一份
 * 文本，便于排查与断言。
 */
export function buildSourcePackOpml(entries: ReadonlyArray<CuratedSourceEntry>): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head><title>DSH 精选源导入</title></head>',
    '  <body>',
  ]

  const groups = new Map<string, CuratedSourceEntry[]>()
  const loose: CuratedSourceEntry[] = []
  for (const entry of entries) {
    const category = entry.category?.trim()
    if (category === undefined || category === '') {
      loose.push(entry)
      continue
    }
    const bucket = groups.get(category) ?? []
    bucket.push(entry)
    groups.set(category, bucket)
  }

  const row = (entry: CuratedSourceEntry, indent: string): string => {
    const title = escapeXml(entry.title ?? entry.url)
    return indent + '<outline type="rss" text="' + title + '" title="' + title +
      '" xmlUrl="' + escapeXml(entry.url) + '"/>'
  }

  for (const entry of loose) lines.push(row(entry, '    '))
  for (const [category, bucket] of groups) {
    lines.push('    <outline text="' + escapeXml(category) + '" title="' + escapeXml(category) + '">')
    for (const entry of bucket) lines.push(row(entry, '      '))
    lines.push('    </outline>')
  }

  lines.push('  </body>', '</opml>')
  return lines.join('\n') + '\n'
}
