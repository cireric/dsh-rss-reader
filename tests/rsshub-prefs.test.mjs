/**
 * RSSHub 用户偏好的单一判据（R15 06 / 07 / ADR-0001）。
 *
 * 评审发现 `hiddenNamespaces` 的归一化有三份实现（读侧 / 写侧 / 检索侧），trim / 去重 / 排序
 * 各不相同；`hideNsfw` 的默认 true 散在四处。这里钉三件事：
 *   1. 纯函数取三者里最严的一份（trim → 丢空串 → 去重 → 稳定排序）；
 *   2. 读侧（validateConfig）与写侧（save 落盘）都走同一份，落盘顺序不随调用方写法变；
 *   3. 默认隐藏 NSFW 只有一个来源，只有显式 false 才关闭。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_HIDE_NSFW,
  RSSHUB_INSTANCE_MAX,
  effectiveHideNsfw,
  normalizeHiddenNamespaces,
} from '../lib/rsshub-prefs.js'
import { readConfigFile } from '../lib/storage/config-file.js'
import { createRsshubSettings } from '../lib/rsshub-settings.js'
import { Config } from '../lib/config.js'

test('normalizeHiddenNamespaces：trim → 丢空串 / 非字符串 → 去重 → 码位稳定排序', () => {
  assert.deepEqual(
    normalizeHiddenNamespaces(['  zhihu  ', 'github', 'github', '', '   ', 5, null, 'GitHub']),
    ['GitHub', 'github', 'zhihu'],
    '不同大小写是两个站点（namespace 等值匹配），空串 / 非字符串丢弃，重复只留一次',
  )
  assert.deepEqual(
    normalizeHiddenNamespaces(['zhihu', 'github']),
    normalizeHiddenNamespaces(['github', 'zhihu']),
    '同一集合换个写法必须得到同一份值（游标栅栏与「已隐藏 N」都靠它）',
  )
  assert.deepEqual(normalizeHiddenNamespaces(undefined), [], '缺省 = 不隐藏')
  assert.deepEqual(normalizeHiddenNamespaces('github'), [], '非数组按空列表处理，不把垃圾值当站点名')
})

test('effectiveHideNsfw：缺省 / 认不出的值都回到默认隐藏，只有显式 false 才关闭', () => {
  assert.equal(DEFAULT_HIDE_NSFW, true)
  assert.equal(effectiveHideNsfw(undefined), true, '缺省 = 隐藏')
  assert.equal(effectiveHideNsfw(true), true)
  assert.equal(effectiveHideNsfw(false), false, '用户显式打开「显示 NSFW」才放行')
  assert.equal(effectiveHideNsfw(null), true, 'null 不是「打开」')
  assert.equal(RSSHUB_INSTANCE_MAX, 5, '实例池上限只有这一个定义')
})

test('读侧与写侧共用同一份归一化：手改文件里的乱序 / 重复 / 空串读回后是排序去重的集合', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rss-prefs-'))
  const configPath = join(dir, 'config.json')
  try {
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      feeds: {},
      rsshub: {
        instances: [],
        hiddenNamespaces: ['  zhihu  ', 'github', 'github', '', 5],
        // 故意不写 hideNsfw：读侧必须用同一份默认值。
      },
    }), 'utf8')

    const file = readConfigFile(configPath)
    assert.deepEqual(file.rsshub?.hiddenNamespaces, ['github', 'zhihu'],
      '读侧归一化与检索侧同一份：排序去重，而不是原样带回')
    assert.equal(file.rsshub?.hideNsfw, DEFAULT_HIDE_NSFW, '缺字段 = 默认隐藏（不是 false）')

    const control = createRsshubSettings({ config: Config({ rsshubBase: '' }), configPath, log: () => {} })
    const saved = control.save({ hiddenNamespaces: ['zhihu', '  github ', 'zhihu', ''] })
    assert.equal(saved.ok, true)
    assert.deepEqual(saved.snapshot.hiddenNamespaces, ['github', 'zhihu'], '写侧也排序去重')
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).rsshub.hiddenNamespaces, ['github', 'zhihu'],
      '落盘的就是归一后的值：读 / 写 / 检索三处不会各说各话')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
