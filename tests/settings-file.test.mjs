/**
 * settings.json 的读 / 写两侧（R11 01，spec D1 / D2 / D6）。
 *
 * 为什么单独一个文件：这份文件是「随时可调的运行参数」的落点，坏掉的处置又分三类
 * （整份隔离 / 逐键丢弃 / 忽略未知键），三类混在一起时最容易被一条 `try { JSON.parse } catch {}`
 * 抹成一种。这里逐类钉住，判据是 specs 的 B9–B11。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSettingsFile, writeSettingsFile } from '../lib/storage/settings-file.js'

/** 每个用例一个独立目录：坏文件隔离会改目录内容，共享目录会让断言互相污染。 */
function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rss-settings-'))
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }))
}

test('settings.json 不存在：不创建文件、不报警、返回 absent', async () => {
  await withDir((dir) => {
    const path = join(dir, 'settings.json')
    const result = readSettingsFile(path)
    assert.deepEqual(result, { status: 'absent' })
    assert.equal(existsSync(path), false, '首装不是空态：读路径不得凭读创建文件')
    assert.deepEqual(readdirSync(dir), [], '目录里不该出现临时文件或隔离文件')
  })
})

test('settings.json 读取：只认白名单键，未知键读时忽略且不算坏值', async () => {
  await withDir((dir) => {
    const path = join(dir, 'settings.json')
    writeFileSync(path, JSON.stringify({
      version: 1,
      // rsshubBase 是「将来版本加过的键」的替身：本版不认，读时忽略、不报警。
      overrides: { refreshConcurrency: 8, rsshubBase: 'https://rsshub.example' },
    }))
    const result = readSettingsFile(path)
    assert.equal(result.status, 'ok', '合法文件必须读出 ok')
    assert.deepEqual(result.overrides, { refreshConcurrency: 8 })
    assert.equal(result.dropped, 0, '未知键不是坏值，不该计入「无法识别」')
  })
})

test('坏 JSON 与认不出的版本：整份隔离为 .corrupt-<时间戳>，原文件内容保留', async () => {
  await withDir((dir) => {
    for (const [index, text] of [
      '{ 截断的 JSON',
      JSON.stringify({ version: 2, overrides: { refreshConcurrency: 8 } }),
      JSON.stringify({ version: 1, overrides: [] }),
      JSON.stringify([]),
    ].entries()) {
      const path = join(dir, 'settings.json')
      writeFileSync(path, text)
      const result = readSettingsFile(path)
      assert.equal(result.status, 'corrupt', '第 ' + (index + 1) + ' 份坏文件必须整份隔离')
      assert.equal(existsSync(path), false, '隔离后原路径必须让位')
      const quarantined = readdirSync(dir).filter((name) => name.startsWith('settings.json.corrupt-'))
      assert.equal(quarantined.length, 1, '必须留下恰好一份隔离文件')
      assert.equal(readFileSync(join(dir, quarantined[0]), 'utf8'), text, '隔离文件必须是原文件，不做任何改写')
      assert.ok(result.quarantinedTo?.endsWith(quarantined[0]), '回执要告诉调用方隔离到哪儿了')
      rmSync(join(dir, quarantined[0]))
    }
  })
})

test('读失败（EISDIR）是 I/O 错误，不是坏文件：返回 unreadable 且不做隔离改名', async () => {
  await withDir((dir) => {
    const path = join(dir, 'settings.json')
    // 用「同名目录」稳定造一个 EISDIR：不需要伪造权限，跨平台/跨用户都成立。
    mkdirSync(path)
    const result = readSettingsFile(path)
    assert.equal(result.status, 'unreadable', '读失败必须是独立的 unreadable，不许冒名 corrupt')
    assert.match(result.reason ?? '', /EISDIR|目录|directory/i, '原因要能看出这是读失败')
    assert.equal(existsSync(path), true, 'I/O 错误不许隔离改名：原路径必须还在')
    assert.equal(statSync(path).isDirectory(), true, '原目录不能被搬走')
    assert.deepEqual(readdirSync(dir), ['settings.json'], '目录里不该出现 .corrupt-* 隔离文件')
  })
})

test('坏值逐键丢：合法项照用、文件不被自动重写（内容与 mtime 都不变）', async () => {
  await withDir((dir) => {
    const path = join(dir, 'settings.json')
    const text = JSON.stringify({
      version: 1,
      // refreshConcurrency = 0 非法、refreshFeedsPerRound = 1000 超上限、cleanupAfterDays = 45 合法。
      overrides: { refreshConcurrency: 0, refreshFeedsPerRound: 1000, cleanupAfterDays: 45 },
    })
    writeFileSync(path, text)
    const before = statSync(path).mtimeMs
    const result = readSettingsFile(path)
    assert.equal(result.status, 'ok', '坏值不该把整份文件判死')
    assert.deepEqual(result.overrides, { cleanupAfterDays: 45 }, '一次坏值只该抹掉它自己')
    assert.equal(result.dropped, 2, '两个坏值都要计数，页面据此提示「有 N 项」')
    assert.equal(readFileSync(path, 'utf8'), text, '读路径不得自动重写文件')
    assert.equal(statSync(path).mtimeMs, before, '读路径不得触碰文件')
  })
})

test('原子写：稀疏落盘、权限 0600、不留临时文件', async () => {
  await withDir((dir) => {
    const path = join(dir, 'settings.json')
    writeSettingsFile(path, { refreshConcurrency: 8 })
    const text = readFileSync(path, 'utf8')
    assert.deepEqual(JSON.parse(text), { version: 1, overrides: { refreshConcurrency: 8 } },
      '只写用户改过的键（稀疏覆盖），不把整份生效值钉进文件')
    assert.equal(statSync(path).mode & 0o777, 0o600, '设置文件与其他存储文件同权限')
    assert.deepEqual(readdirSync(dir), ['settings.json'], '临时文件必须被 rename 吃完')

    // 覆盖已有文件时同样原子：内容整份替换，不残留旧键。
    writeSettingsFile(path, { refreshConcurrency: 9, cleanupAfterDays: 60 })
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
      version: 1, overrides: { cleanupAfterDays: 60, refreshConcurrency: 9 },
    })
  })
})

test('原子写：非法值当场拒绝，且不留下半个文件', async () => {
  await withDir((dir) => {
    const path = join(dir, 'settings.json')
    writeSettingsFile(path, { refreshConcurrency: 8 })
    const before = readFileSync(path, 'utf8')
    assert.throws(() => writeSettingsFile(path, { cleanupAfterDays: 0 }), /不合法/)
    assert.equal(readFileSync(path, 'utf8'), before, '写失败时原文件不动')
    assert.deepEqual(readdirSync(dir), ['settings.json'], '失败路径也要清掉临时文件')
  })
})
