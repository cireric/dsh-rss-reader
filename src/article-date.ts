/**
 * 文章页的**发布日期抽取**（R9 回溯，纯函数）。
 *
 * 为什么单独一个模块：回溯要按真实发布日期把文章排进条目库，而 `feed/date.ts` 的 `toIsoUtc`
 * 只吃 feed 里的时间串；文章页 HTML 的写法是另一回事（元数据、可见文本、URL 三种载体）。
 *
 * 只认 spec §4.4 列出的五级来源，**依次尝试、命中即停**；一级里解析失败就交给下一级。
 * 认不出就返回 `undefined` —— 不拿抓取时间冒充（AGENTS「不编造数据」、spec §4.4）。
 */
import { decodeEntities, htmlToText } from './html-text.js'

/**
 * 无时区的日期按这个偏移解释。spec §11 D10 拍板 +08:00（样本与目标站点都在中国）；
 * 它只影响排序时刻与 ISO 串里的 UTC 值，不改变站点写的那个日历日期。
 */
const DEFAULT_OFFSET_MINUTES = 8 * 60

/** 日期各部分；`day` 缺省表示「只有年月」——这种一律不产生日期。 */
interface DateParts {
  year: number
  month: number
  day: number | undefined
  hour: number
  minute: number
  second: number
  offsetMinutes: number
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29
  return DAYS_IN_MONTH[month - 1] ?? 0
}

/**
 * 组装 ISO8601 UTC；任何一部分越界都返回 `undefined`（不编、不让 Date 帮忙进位）。
 *
 * 日历校验是显式的：`2020-02-31` 交给 `Date.UTC` 会滚成 3 月 2 日，那就成了**另一天**的日期。
 */
function isoOf(parts: DateParts): string | undefined {
  // 只有年月 ⇒ 不产生日期：补 01 是编日期（FYKANG 的那一级刻意不抄，spec §4.4 / §11 D3）
  if (parts.day === undefined) return undefined
  if (parts.month < 1 || parts.month > 12) return undefined
  if (parts.day < 1 || parts.day > daysInMonth(parts.year, parts.month)) return undefined
  if (parts.hour < 0 || parts.hour > 23) return undefined
  if (parts.minute < 0 || parts.minute > 59) return undefined
  if (parts.second < 0 || parts.second > 59) return undefined
  // 用 setUTCFullYear 而不是 Date.UTC：后者把 0..99 年当成 1900+（4 位年份只剩 0000..0999 这一档，
  // 虽然现实里不会出现，但「写进去的年份要就是写进去的」不该有例外）
  const date = new Date(0)
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day)
  date.setUTCHours(parts.hour, parts.minute, parts.second, 0)
  const utcMs = date.getTime() - parts.offsetMinutes * 60_000
  return Number.isNaN(utcMs) ? undefined : new Date(utcMs).toISOString()
}

/** ISO 系列的时区后缀：`Z` / `+08:00` / `+0800`；缺省按 +08:00。 */
function offsetOf(zone: string | undefined): number {
  if (zone === undefined || zone === '') return DEFAULT_OFFSET_MINUTES
  if (zone === 'Z' || zone === 'z') return 0
  const sign = zone[0] === '-' ? -1 : 1
  const digits = zone.slice(1).replace(':', '')
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)))
}

/** `YYYY-MM-DD[THH:MM[:SS[.fff]]][Z|±HH:MM]`；不完整的日期（只有年月）直接不匹配。 */
const ISO_DATETIME = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[Tt ](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.\d+)?)?)?\s*([Zz]|[+-]\d{2}:?\d{2})?$/

function parseIsoDate(raw: string): string | undefined {
  const match = ISO_DATETIME.exec(raw.trim())
  if (match === null) return undefined
  const [, year, month, day, hour, minute, second, zone] = match
  return isoOf({
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour ?? 0),
    minute: Number(minute ?? 0),
    second: Number(second ?? 0),
    offsetMinutes: offsetOf(zone),
  })
}

/** 取出页面里所有同名标签（`<time …>` / `<abbr …>` / `<meta …>` 的整段原文）。 */
function tagsOf(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp('<' + name + '\\b[^>]*>', 'gi'))].map((match) => match[0])
}

/** 读一个属性的值（三种引号形态）；attribute 前必须有空白，避免 `data-href` 冒充 `href`。 */
function attributeOf(tag: string, name: string): string | undefined {
  const pattern = new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i')
  const match = pattern.exec(tag)
  if (match === null) return undefined
  const value = match[1] ?? match[2] ?? match[3]
  return value === undefined ? undefined : decodeEntities(value).trim()
}

/** 第 1 级：`<time datetime="…">`。 */
function fromTimeElement(html: string): string | undefined {
  for (const tag of tagsOf(html, 'time')) {
    const raw = attributeOf(tag, 'datetime')
    if (raw === undefined) continue
    const iso = parseIsoDate(raw)
    if (iso !== undefined) return iso
  }
  return undefined
}

/** 第 2 级：`<abbr class="published" title="…">`（阮一峰样本）。 */
function fromAbbrPublished(html: string): string | undefined {
  for (const tag of tagsOf(html, 'abbr')) {
    const classes = attributeOf(tag, 'class')?.toLowerCase().split(/\s+/).filter((token) => token !== '') ?? []
    if (!classes.includes('published')) continue
    const raw = attributeOf(tag, 'title')
    if (raw === undefined) continue
    const iso = parseIsoDate(raw)
    if (iso !== undefined) return iso
  }
  return undefined
}

/** 第 3 级认的 meta 键。`datePublished` 是 schema.org 的 itemprop，比对前统一小写。 */
const META_DATE_KEYS = new Set(['article:published_time', 'date', 'datepublished'])

/** 第 3 级：`<meta property="article:published_time">` / `<meta name="date">` / `<meta itemprop="datePublished">`。 */
function fromMeta(html: string): string | undefined {
  for (const tag of tagsOf(html, 'meta')) {
    const key = (attributeOf(tag, 'property') ?? attributeOf(tag, 'name') ?? attributeOf(tag, 'itemprop') ?? '').toLowerCase()
    if (!META_DATE_KEYS.has(key)) continue
    const raw = attributeOf(tag, 'content')
    if (raw === undefined) continue
    const iso = parseIsoDate(raw)
    if (iso !== undefined) return iso
  }
  return undefined
}

/** 可见文本里的日期词（spec §4.4 第 4 级）。英文词要求整词，避免 `update` / `candidate` 误命中。 */
const VISIBLE_DATE_WORD = /\b(?:date|published|posted)\b|日期|发布时间|发布于|发表于|提交于/gi

const VISIBLE_CN = /^[\s:：]*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*(\d{1,2})[:：](\d{1,2})(?:[:：](\d{1,2}))?)?/
const VISIBLE_EN = /^[\s:：]*([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s*(\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s*([AaPp][Mm]))?/
const VISIBLE_ISO = /^[\s:：]*(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/

const MONTH_NAMES: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

/** 12 小时制 → 24 小时制；没有 AM/PM 时原样返回。 */
function hour24Of(hour: number, meridiem: string | undefined): number | undefined {
  if (meridiem === undefined) return hour
  const upper = meridiem.toUpperCase()
  if (upper === 'AM') return hour === 12 ? 0 : hour
  if (upper === 'PM') return hour === 12 ? 12 : hour + 12
  return undefined
}

/**
 * 日期词后面的日期串。三种写法按 spec §4.4 列出的顺序试，**第一条解析成功**的就是它。
 * 正则都以 `^` 锚在日期词右侧，所以正文里孤立出现的日期不会被当成发布日期。
 */
function parseVisibleDate(rest: string): string | undefined {
  const cn = VISIBLE_CN.exec(rest)
  if (cn !== null) {
    return isoOf({
      year: Number(cn[1]),
      month: Number(cn[2]),
      day: Number(cn[3]),
      hour: Number(cn[4] ?? 0),
      minute: Number(cn[5] ?? 0),
      second: Number(cn[6] ?? 0),
      offsetMinutes: DEFAULT_OFFSET_MINUTES,
    })
  }
  const en = VISIBLE_EN.exec(rest)
  if (en !== null) {
    const month = MONTH_NAMES[en[1].toLowerCase()]
    const hour = hour24Of(Number(en[4] ?? 0), en[7])
    if (month === undefined || hour === undefined) return undefined
    return isoOf({
      year: Number(en[3]),
      month,
      day: Number(en[2]),
      hour,
      minute: Number(en[5] ?? 0),
      second: Number(en[6] ?? 0),
      offsetMinutes: DEFAULT_OFFSET_MINUTES,
    })
  }
  const iso = VISIBLE_ISO.exec(rest)
  if (iso !== null) {
    return isoOf({
      year: Number(iso[1]),
      month: Number(iso[2]),
      day: Number(iso[3]),
      hour: Number(iso[4] ?? 0),
      minute: Number(iso[5] ?? 0),
      second: Number(iso[6] ?? 0),
      offsetMinutes: DEFAULT_OFFSET_MINUTES,
    })
  }
  return undefined
}

/**
 * 可见文本：先把 `script` / `style` / 注释整段去掉，再交给 `htmlToText`。
 * 它们的内容不是「读者看得见的字」——JS 里的 `date: 2020-01-03` 不该冒充发布日期。
 */
function visibleTextOf(html: string): string {
  return htmlToText(html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' '))
}

/** 第 4 级：可见文本里「日期词 + 日期串」的第一条（`htmlToText` 之后，不会读到标签属性）。 */
function fromVisibleText(html: string): string | undefined {
  const text = visibleTextOf(html)
  for (const word of text.matchAll(VISIBLE_DATE_WORD)) {
    const rest = text.slice((word.index ?? 0) + word[0].length)
    const iso = parseVisibleDate(rest)
    if (iso !== undefined) return iso
  }
  return undefined
}

/** URL 路径里的年月日。`/` 与 `-` 两种分隔都认；日是可选的，缺日时由 `isoOf` 明确拒绝。 */
const URL_FULL_DATE = /(?:^|\/)(\d{4})[/-](\d{1,2})(?:[/-](\d{1,2}))?(?![0-9])/

/** 第 5 级：URL 里**完整**的 `YYYY/MM/DD` 或 `YYYY-MM-DD`；只有年月不产生日期。 */
function fromUrlDate(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const match = URL_FULL_DATE.exec(parsed.pathname)
  if (match === null) return undefined
  return isoOf({
    year: Number(match[1]),
    month: Number(match[2]),
    day: match[3] === undefined ? undefined : Number(match[3]),
    hour: 0,
    minute: 0,
    second: 0,
    offsetMinutes: DEFAULT_OFFSET_MINUTES,
  })
}

/**
 * 文章页 → 发布时间（ISO8601 UTC）；认不出返回 `undefined`。
 *
 * 五级来源依次尝试、命中即停：`<time datetime>` → `<abbr class="published">` → meta 三种 →
 * 可见文本「日期词 + 日期串」 → URL 完整年月日（spec §4.4）。
 */
export function articleDateOf(html: string, url: string): string | undefined {
  return fromTimeElement(html)
    ?? fromAbbrPublished(html)
    ?? fromMeta(html)
    ?? fromVisibleText(html)
    ?? fromUrlDate(url)
}
