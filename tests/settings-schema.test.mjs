/**
 * 可调值判据的唯一一份（R8a 01，spec §4.1 / D2 / D3）。
 *
 * 为什么单测这个纯函数：读 settings.json、saveSettings 入参、设置页失焦前校验三处都调它；
 * 它把 rsshubBase 收成什么形态（trim / 去尾斜杠 / 拒 path）决定了文件里到底存什么，
 * 也决定了「填错当场拒绝」与「存的读得回」是不是同一件事。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BOOLEAN_TUNABLE_KEYS, parseTunableValue, TUNABLE_KEYS } from '../lib/settings-schema.js'

test('键表：数字键 + 字符串键 + 布尔键，顺序稳定', () => {
  assert.deepEqual(TUNABLE_KEYS, [
    'refreshFeedsPerRound',
    'refreshConcurrency',
    'minRefreshIntervalMs',
    'cleanupAfterDays',
    'rsshubBase',
    'translateProvider',
    'translateModel',
    'translateEffort',
    'translateNoticeAck',
  ])
  assert.deepEqual(BOOLEAN_TUNABLE_KEYS, ['translateNoticeAck'], '布尔键单独成组，不混进字符串键')
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


test('R7 02 翻译三键：只做 trim + 长度 ≤ 200 的形状校验，不做语义校验', () => {
  for (const key of ['translateProvider', 'translateModel', 'translateEffort']) {
    assert.equal(parseTunableValue(key, ''), '', key + '：空串 = 未配置，是合法值')
    assert.equal(parseTunableValue(key, '   '), '', key + '：纯空白 trim 成空串')
    assert.equal(parseTunableValue(key, '  deepseek  '), 'deepseek', key + '：存 trim 后的值')
    assert.equal(parseTunableValue(key, 'x'.repeat(200)), 'x'.repeat(200), key + '：200 字符是边界内')
    assert.equal(parseTunableValue(key, 'x'.repeat(201)), undefined, key + '：超过 200 字符拒绝')
    for (const bad of [5, null, undefined, {}, [], true]) {
      assert.equal(parseTunableValue(key, bad), undefined, key + '：非字符串拒绝：' + JSON.stringify(bad))
    }
    // 「不做语义校验」：不存在的 provider / model 名字照样存得下，合法路由由模型目录在运行期裁决。
    assert.equal(parseTunableValue(key, 'not-a-real-route'), 'not-a-real-route')
  }
})

test('R7 02 translateNoticeAck：只认布尔，其它一律拒绝（不做真值转换）', () => {
  assert.equal(parseTunableValue('translateNoticeAck', true), true)
  assert.equal(parseTunableValue('translateNoticeAck', false), false)
  for (const bad of ['true', 1, 0, null, undefined, {}, []]) {
    assert.equal(parseTunableValue('translateNoticeAck', bad), undefined,
      '非布尔必须拒绝（不编造真值）：' + JSON.stringify(bad))
  }
})
