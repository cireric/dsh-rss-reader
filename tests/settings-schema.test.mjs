/**
 * 可调值判据的唯一一份（R8a 01，spec §4.1 / D2 / D3）。
 *
 * 为什么单测这个纯函数：读 settings.json、saveSettings 入参、设置页失焦前校验三处都调它；
 * 它把 rsshubBase 收成什么形态（trim / 去尾斜杠 / 拒 path）决定了文件里到底存什么，
 * 也决定了「填错当场拒绝」与「存的读得回」是不是同一件事。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTunableValue, TUNABLE_KEYS } from '../lib/settings-schema.js'

test('键表：四个数字键之外还有 rsshubBase（字符串键），顺序稳定', () => {
  assert.deepEqual(TUNABLE_KEYS, [
    'refreshFeedsPerRound',
    'refreshConcurrency',
    'minRefreshIntervalMs',
    'cleanupAfterDays',
    'rsshubBase',
  ])
})

test('rsshubBase：trim 后空串合法，http(s) 只保留源站，末尾斜杠去掉', () => {
  assert.equal(parseTunableValue('rsshubBase', ''), '', '空串 = 功能关闭，是合法值')
  assert.equal(parseTunableValue('rsshubBase', '   '), '', '只输入空白等同于清空')
  assert.equal(parseTunableValue('rsshubBase', 'https://rsshub.rssforever.com/'),
    'https://rsshub.rssforever.com', '末尾斜杠必须在存储形态里去掉')
  assert.equal(parseTunableValue('rsshubBase', '  http://127.0.0.1:1200/  '),
    'http://127.0.0.1:1200', '私网实例属于「出网时拒绝」，不是「配置非法」')
  assert.equal(parseTunableValue('rsshubBase', 'https://rsshub.example:8443'),
    'https://rsshub.example:8443', '非默认端口是源站的一部分')
})

test('rsshubBase：协议、path / query / hash、非字符串与非 URL 一律拒绝', () => {
  const bad = [
    'ftp://rsshub.example',
    'javascript:alert(1)',
    'https://rsshub.example/api',
    'https://rsshub.example/api/',
    'https://rsshub.example/?token=1',
    'https://rsshub.example/#top',
    'not a url',
    '//rsshub.example',
    5,
    null,
    undefined,
    {},
  ]
  for (const value of bad) {
    assert.equal(parseTunableValue('rsshubBase', value), undefined,
      '非法地址必须返回 undefined（不编造夹取值）：' + JSON.stringify(value))
  }
})

test('数字键的判据不变：整数 + 范围，其它类型仍 undefined', () => {
  assert.equal(parseTunableValue('refreshConcurrency', 5), 5)
  assert.equal(parseTunableValue('refreshFeedsPerRound', 0), 0)
  assert.equal(parseTunableValue('refreshConcurrency', 0), undefined)
  assert.equal(parseTunableValue('cleanupAfterDays', 1.5), undefined)
  assert.equal(parseTunableValue('refreshConcurrency', '5'), undefined)
})
