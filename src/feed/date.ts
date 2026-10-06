/**
 * feed 日期归一：一切对外暴露的时间都是 ISO8601 UTC（毫秒精度）。
 *
 * 先交给 Date.parse（V8 能吃下绝大多数 RFC822 / ISO8601），失败再按 RFC822
 * 手工兜底——真实 feed 里 "Mon, 2 Apr 2018 10:00:00 +0800" 这种单位数日期是常态，
 * 恰恰是 Date.parse 最容易失手的一类。原始串另存 publishedRaw 供排查。
 */

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

/** RFC822 里的字母时区；未列出的按 UTC 处理（宁可偏，不可丢）。 */
const ZONE_OFFSET_MINUTES: Record<string, number> = {
  ut: 0, utc: 0, gmt: 0, z: 0,
  est: -300, edt: -240, cst: -360, cdt: -300,
  mst: -420, mdt: -360, pst: -480, pdt: -420,
}

const RFC822 = /^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[A-Za-z]{1,5})?\s*$/

/** 归一成 ISO8601 UTC；无法识别时返回 undefined（不编造日期）。 */
export function toIsoUtc(raw: string | undefined): string | undefined {
  const input = (raw ?? '').trim()
  if (!input) return undefined

  const direct = Date.parse(input)
  if (!Number.isNaN(direct)) return new Date(direct).toISOString()

  const match = RFC822.exec(input)
  if (!match) return undefined
  const [, day, monthName, yearText, hour, minute, second, zone] = match
  const month = MONTHS[monthName.toLowerCase()]
  if (month === undefined) return undefined

  const yearValue = Number(yearText)
  const year = yearText.length <= 2 ? (yearValue < 70 ? 2000 + yearValue : 1900 + yearValue) : yearValue

  let offsetMinutes = 0
  if (zone) {
    if (/^[+-]\d{4}$/.test(zone)) {
      const sign = zone[0] === '-' ? -1 : 1
      offsetMinutes = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)))
    } else {
      offsetMinutes = ZONE_OFFSET_MINUTES[zone.toLowerCase()] ?? 0
    }
  }

  const utcMs = Date.UTC(year, month, Number(day), Number(hour), Number(minute), Number(second ?? 0)) - offsetMinutes * 60_000
  const date = new Date(utcMs)
  if (Number.isNaN(date.getTime())) return undefined
  // 单位数日期可能滚到月份外（如 31 Feb）→ Date 会进位，这里显式拒绝明显的越界日期
  if (date.getUTCMonth() !== month) return undefined
  return date.toISOString()
}
