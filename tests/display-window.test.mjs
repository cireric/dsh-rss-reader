/**
 * 显示窗边界（src/display-window.ts）的模块级判据 —— **不读 store、不碰 DOM**。
 *
 * 这是「读者本地日 → 半开区间」的**唯一裁决者**（ADR-0005 决定 2）：宿主与客户端都只调它，
 * 谁都不许自己再算一份时区。所以边界正确性必须在这里被钉死，而不是在端点或界面层各测一遍。
 *
 * 日期算术只许走**本地日期构造器逐日推算**（`new Date(y, m, d - n)`）：DST 的自然日可能是
 * 23 或 25 小时，`now - 3 * 86400e3` 不是「近 3 天」。jsdom 没有真实时区、宿主进程的 TZ 也不该
 * 被测试假设，所以 DST 的两条用例用 `TZ=America/New_York` 的**子进程**跑（spec 测试决策 Seam 4）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { displayWindowBoundsOf, startOfLocalDay } from '../lib/display-window.js'

const HOUR = 3600 * 1000

/** 本地时刻的四个分量：断言「是不是本地午夜」只有它说得清（ISO 串本身是 UTC）。 */
const localOf = (iso) => {
  const date = new Date(iso)
  return [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()]
}

/** 一次取齐档位结果；「全部」不是窗口而是「没有窗口」，所以 loop 里单独断言。 */
const boundsOf = (range, now) => displayWindowBoundsOf(range, now)

test('档位：全部 = 没有窗口（undefined），其余三个档位都给出半开区间', () => {
  const now = new Date(2026, 10, 20, 13, 45, 30)
  assert.equal(boundsOf('all', now), undefined, '「全部」不是窗口 —— 回 undefined，调用方据此不带窗口')
  for (const range of ['today', '3d', '7d']) {
    const bounds = boundsOf(range, now)
    assert.equal(typeof bounds.from, 'string', range + ' 必须有 from')
    assert.equal(typeof bounds.to, 'string', range + ' 必须有 to')
    assert.match(bounds.from, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, range + ' 的 from 必须是 toISOString() 形态')
    assert.match(bounds.to, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, range + ' 的 to 必须是 toISOString() 形态')
    assert.ok(bounds.from < bounds.to, range + ' 必须是 [from, to) 这样的正区间')
  }
})

test('今天：本地今天午夜到本地明天午夜（不是 UTC 日界，也不是 24 小时前的此刻）', () => {
  const now = new Date(2026, 10, 20, 13, 45, 30)
  const { from, to } = boundsOf('today', now)

  assert.deepEqual(localOf(from), [2026, 11, 20, 0, 0, 0, 0], 'from 必须是本地今天的 00:00:00.000')
  assert.deepEqual(localOf(to), [2026, 11, 21, 0, 0, 0, 0], 'to 必须是本地明天的 00:00:00.000（半开区间，不等于日末）')
  assert.equal(Date.parse(to) - Date.parse(from), 24 * HOUR, '普通日子是 24 小时')
})

test('近 3 天 = 含今天在内的 3 个自然日（from 是今天 − 2 天的午夜）', () => {
  const now = new Date(2026, 10, 20, 13, 45, 30)
  const { from, to } = boundsOf('3d', now)
  assert.deepEqual(localOf(from), [2026, 11, 18, 0, 0, 0, 0], '3 天含今天：今天 20 日 ⇒ from 是 18 日午夜（不是 17 日）')
  assert.deepEqual(localOf(to), [2026, 11, 21, 0, 0, 0, 0], 'to 仍是明天午夜')
  assert.equal(Date.parse(to) - Date.parse(from), 3 * 24 * HOUR)
})

test('近 7 天 = 含今天在内的 7 个自然日（from 是今天 − 6 天的午夜）', () => {
  const now = new Date(2026, 10, 20, 0, 0, 0) // 午夜整点：跨零点也不许把「今天」算丢
  const { from, to } = boundsOf('7d', now)
  assert.deepEqual(localOf(from), [2026, 11, 14, 0, 0, 0, 0], '7 天含今天：从 14 日午夜起算')
  assert.deepEqual(localOf(to), [2026, 11, 21, 0, 0, 0, 0])
})

test('跨月 / 跨年：日期构造器自己借位，不许手写「日 − 2」的字符串拼接', () => {
  // 3 月 1 日的「近 3 天」= 2 月 27 日 → 3 月 2 日（2026 不是闰年）
  const march = boundsOf('3d', new Date(2026, 2, 1, 9, 0, 0))
  assert.deepEqual(localOf(march.from), [2026, 2, 27, 0, 0, 0, 0], '跨月：3 月 1 日往前两个自然日是 2 月 27 日')
  assert.deepEqual(localOf(march.to), [2026, 3, 2, 0, 0, 0, 0])

  // 1 月 1 日的「近 7 天」= 去年 12 月 26 日 → 1 月 2 日
  const newYear = boundsOf('7d', new Date(2027, 0, 1, 9, 0, 0))
  assert.deepEqual(localOf(newYear.from), [2026, 12, 26, 0, 0, 0, 0], '跨年：1 月 1 日往前六个自然日是去年 12 月 26 日')
  assert.deepEqual(localOf(newYear.to), [2027, 1, 2, 0, 0, 0, 0])
})

test('startOfLocalDay：给「此刻」回本地今天的 00:00:00.000（今天起点只此一处）', () => {
  const start = startOfLocalDay(new Date(2026, 10, 20, 23, 59, 59, 999))
  assert.deepEqual(localOf(start.toISOString()), [2026, 11, 20, 0, 0, 0, 0])
  assert.equal(start.getTime(), new Date(2026, 10, 20).getTime(), '与本地日期构造器逐毫秒相同')
})

/**
 * DST 子进程：父进程的 TZ 不该被假设，而 DST 只在特定时区发生。
 * 子进程里用本地日期构造器造「那一天的本地中午」，再取窗口 —— 这样断言的是模块本身的算术，
 * 不是测试文件所在的时区。
 */
function runInNewYork(year, monthIndex, day) {
  const moduleUrl = pathToFileURL(resolve('lib/display-window.js')).href
  const script = `
    const { displayWindowBoundsOf } = await import(process.env.MODULE_URL)
    const now = new Date(Number(process.env.YEAR), Number(process.env.MONTH_INDEX), Number(process.env.DAY), 12, 0, 0)
    const local = (iso) => {
      const date = new Date(iso)
      return [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()]
    }
    const today = displayWindowBoundsOf('today', now)
    const three = displayWindowBoundsOf('3d', now)
    console.log(JSON.stringify({
      todayFrom: today.from, todayTo: today.to, todayFromLocal: local(today.from), todayToLocal: local(today.to),
      todayHours: (Date.parse(today.to) - Date.parse(today.from)) / 3600000,
      threeFrom: three.from, threeTo: three.to, threeHours: (Date.parse(three.to) - Date.parse(three.from)) / 3600000,
      offsetMinutes: new Date(today.from).getTimezoneOffset(),
    }))
  `
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env,
      TZ: 'America/New_York',
      MODULE_URL: moduleUrl,
      YEAR: String(year),
      MONTH_INDEX: String(monthIndex),
      DAY: String(day),
    },
    encoding: 'utf8',
  })
  return JSON.parse(output)
}

test('DST 春季：23 小时的自然日仍是「今天」，近 3 天 = 71 小时（不是毫秒减法）', () => {
  // 2026-03-08 美东春季调时：02:00 EST → 03:00 EDT，这一天只有 23 小时
  const result = runInNewYork(2026, 2, 8)
  assert.deepEqual(result.todayFromLocal, [2026, 3, 8, 0, 0], 'from 必须仍是本地 3 月 8 日 00:00')
  assert.deepEqual(result.todayToLocal, [2026, 3, 9, 0, 0], 'to 必须仍是本地 3 月 9 日 00:00')
  assert.equal(result.todayHours, 23, 'DST 春季这一天是 23 小时；若是 24 或 23.0 之外的数，说明没按自然日算')
  assert.equal(result.threeHours, 71, '近 3 天含今天 = 23 + 24 + 24 = 71 小时；毫秒减法会得到 72')
  assert.equal(result.offsetMinutes, 300, '前置条件：子进程确实跑在 America/New_York（EST 偏移 300 分钟）')
})

test('DST 秋季：25 小时的自然日仍是「今天」，近 3 天 = 73 小时（不是毫秒减法）', () => {
  // 2026-11-01 美东秋季调时：02:00 EDT → 01:00 EST，这一天有 25 小时
  const result = runInNewYork(2026, 10, 1)
  assert.deepEqual(result.todayFromLocal, [2026, 11, 1, 0, 0], 'from 必须仍是本地 11 月 1 日 00:00')
  assert.deepEqual(result.todayToLocal, [2026, 11, 2, 0, 0], 'to 必须仍是本地 11 月 2 日 00:00')
  assert.equal(result.todayHours, 25, 'DST 秋季这一天是 25 小时')
  assert.equal(result.threeHours, 73, '近 3 天含今天 = 24 + 24 + 25 = 73 小时；毫秒减法会得到 72')
  assert.equal(result.offsetMinutes, 240, '前置条件：子进程确实跑在 America/New_York（EDT 偏移 240 分钟）')
})
