#!/usr/bin/env node
/**
 * 备份/恢复的**校验器**（M5 04）。
 *
 * 用法：`node scripts/verify-backup.mjs <备份目录>`
 *
 * 它回答一个问题：**这份副本能不能拿来恢复**。四类必查项各自显式失败：
 *   ① 缺文件（rss.db / config.json）；
 *   ② 库打不开或损坏（`PRAGMA integrity_check` 不是 ok）；
 *   ③ 版本不认识（不在 1..当前物理版本之间 —— 比当前版本老可以升级，比它新说明是别的插件版本写的）；
 *   ④ 库里有条目、订阅却是空的（`assertSubscriptionsNotLost` 的同一条判据：
 *      「返回空订阅」在用户眼里就是「我的订阅全没了」）。
 *
 * **只读**：全程 `readOnly: true` 打开、不写任何文件 —— 校验失败时原数据必须原样留着，
 * 这是「损坏副本不许把好数据覆盖掉」的第一步。
 *
 * 退出码：0 = 可以恢复；2 = 拒绝恢复（消息逐条列出哪里不合格）。
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { SCHEMA_VERSION } from '../lib/storage/db.js'

const CONFIG_VERSION = 1

/** 逐条检查，最后一起汇报（一次看完所有问题，比改一个跑一次强）。 */
function main(argv) {
  const dir = argv[2]
  if (dir === undefined || dir.trim() === '') {
    console.error('用法：node scripts/verify-backup.mjs <备份目录>')
    return 2
  }
  const failures = []
  const notes = []
  const ok = (text) => notes.push('  ✓ ' + text)
  // 失败项同时写 stderr：运维通常只重定向 stderr（2>verify.log），失败原因不能只躺在 stdout 里
  const bad = (text) => { failures.push(text); notes.push('  ✗ ' + text); console.error('  ✗ ' + text) }

  const dbPath = join(dir, 'rss.db')
  const configPath = join(dir, 'config.json')

  // ① 文件在不在
  let dbSize = 0
  try {
    const stat = statSync(dbPath)
    if (!stat.isFile()) throw new Error('不是普通文件')
    dbSize = stat.size
    ok('rss.db 存在（' + dbSize + ' 字节）')
  } catch (error) {
    bad('rss.db 缺失或不可读：' + dbPath + '（' + String(error) + '）')
  }

  let config = undefined
  try {
    const text = readFileSync(configPath, 'utf8')
    config = JSON.parse(text)
    ok('config.json 可解析（' + text.length + ' 字符）')
  } catch (error) {
    bad('config.json 缺失或不是合法 JSON：' + configPath + '（' + String(error) + '）')
  }

  if (config !== undefined) {
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      bad('config.json 的顶层不是对象')
    } else if (config.version !== CONFIG_VERSION) {
      bad('config.json 的 version 是 ' + JSON.stringify(config.version) + '，本版只认 ' + CONFIG_VERSION)
    } else if (config.feeds === null || typeof config.feeds !== 'object' || Array.isArray(config.feeds)) {
      bad('config.json 的 feeds 不是「feedId → 记录」的映射')
    } else {
      ok('config.json 版本与形状合格，订阅 ' + Object.keys(config.feeds).length + ' 条')
    }
  }

  // ②③④ 库：版本、完整性、订阅非空
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch (error) {
    bad('rss.db 打不开（' + String(error) + '）')
  }
  if (db !== undefined) {
    try {
      const version = db.prepare('PRAGMA user_version').get()?.user_version
      if (typeof version !== 'number') {
        bad('读不出库的格式版本（返回 ' + JSON.stringify(version) + '）')
      } else if (version < 1 || version > SCHEMA_VERSION) {
        // 比当前版本新 = 别的（更新的）插件写的；比 1 小 = 不是我们的库
        bad('库的格式版本是 ' + version + '，本版支持 1..' + SCHEMA_VERSION)
      } else {
        ok('库版本 ' + version + '（本版支持 1..' + SCHEMA_VERSION + '，较老的会在启动时升级）')
      }

      const integrity = db.prepare('PRAGMA integrity_check').get()?.integrity_check
      if (integrity !== 'ok') bad('integrity_check 不通过：' + JSON.stringify(integrity))
      else ok('integrity_check = ok')

      // 老库（v1/v2）没有 tags 表，缺表是正常的；其余错误一律往上抛，不静默当 0
      const count = (table) => {
        try {
          return Number(db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n)
        } catch (error) {
          if (String(error).includes('no such table')) return undefined
          throw error
        }
      }
      const items = count('items')
      const feedCount = config !== undefined && config !== null && typeof config === 'object'
        && config.feeds !== null && typeof config.feeds === 'object' && !Array.isArray(config.feeds)
        ? Object.keys(config.feeds).length
        : 0
      if (items !== undefined && items > 0 && feedCount === 0) {
        // 与 src/index.ts 的 assertSubscriptionsNotLost 同一条判据
        bad('库里有 ' + items + ' 条条目，但 config.json 里一条订阅都没有 —— 订阅副本丢了，拒绝恢复')
      } else if (items !== undefined) {
        ok('条目 ' + items + ' 条；正文缓存 ' + (count('texts') ?? 0) + ' 条；标签 ' + (count('tags') ?? 0) + ' 个')
      }
    } catch (error) {
      // 库头能打开、第一条查询就炸（典型的截断/垃圾字节）：这里必须变成「拒绝恢复」而不是让脚本崩掉
      bad('库读不出来（校验中抛错）：' + String(error))
    } finally {
      try {
        db.close()
      } catch (error) {
        // 只读句柄关不掉不影响结论，但必须留痕（本仓库禁止空 catch）
        console.error('  ! 关闭校验用的只读句柄失败：' + String(error))
      }
    }
  }

  console.log('备份目录：' + dir)
  console.log(notes.join('\n'))
  if (failures.length > 0) {
    console.error('\n拒绝恢复：' + failures.length + ' 项不合格（上面带 ✗ 的行）。原数据未做任何改动。')
    return 2
  }
  console.log('\n可以恢复。')
  return 0
}

process.exitCode = main(process.argv)
