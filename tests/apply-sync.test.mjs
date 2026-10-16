/**
 * 宿主接线的同步段契约（2026-10-15 H2 Task 3 · Q7 判据 ④）。
 *
 * 这条约束在搬动之前只活在 src/index.ts 的注释里：apply 必须是**同步**的，且所有 ctx.effect
 * 都要在同步段登记完 —— 一旦在里面 await 过，fiber 可能已被 reload/dispose，随后的 ctx.effect
 * 会抛 "cannot create effect on inactive context"（2026-10-08 实测栈：Fiber._reload → apply →
 * ctx.effect）。搬动生命周期之后它更关键：session.start() 是异步的，很容易顺手写成 await。
 *
 * 判据用**假 ctx**是刻意的：这里要验的正是「ctx.effect 什么时候被调用」，而真 DSH 跑起来根本
 * 不会在热重载竞态里稳定复现它。用一个记录调用栈的假 ctx，比等真机报错便宜且确定。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

test('apply：所有 ctx.effect 都在同步段登记完（登记时 apply 尚未 await 任何东西）', () => {
  const savedHome = process.env.DSH_HOME
  const savedProfile = process.env.USERPROFILE
  const home = mkdtempSync(join(tmpdir(), 'rss-apply-sync-'))
  const registrations = []
  try {
    process.env.DSH_HOME = home
    process.env.USERPROFILE = home
    const ctx = {
      logger: { info: () => {}, warn: () => {} },
      // 关键：effect 被调用时**记录同步标志**。真 cordis 会在登记之后才让 apply 返回；
      // 这里我们要验的是「登记发生在 apply 还在跑的时候」，而不是「登记成功」。
      effect: (callback, name) => {
        registrations.push({ name, whileApplyRunning: true })
        return () => {}
      },
      webServer: { register: () => () => {} },
      connection: { requestRejection: () => 401 },
    }
    // 同步调用 apply（不 await）—— 若 apply 内部 await 过再登记 effect，这里的记录会暴露顺序
    apply(ctx, { feeds: ['https://feed0.example.com/atom.xml'], timeoutMs: 1000 })
    assert.equal(registrations.length, 2, '两条 effect：路由注册 + 生命周期')
    assert.deepEqual(registrations.map((entry) => entry.name).sort(),
      ['dsh-rss-reader: http route', 'dsh-rss-reader: sqlite storage + start refresh'])
  } finally {
    rmSync(home, { recursive: true, force: true })
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    if (savedProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = savedProfile
  }
})

test('apply：同步返回（不是 promise）—— 依赖它的宿主按同步 apply 契约工作', () => {
  const savedHome = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'rss-apply-sync2-'))
  try {
    process.env.DSH_HOME = home
    const ctx = {
      logger: { info: () => {}, warn: () => {} },
      effect: () => () => {},
      webServer: { register: () => () => {} },
      connection: { requestRejection: () => 401 },
    }
    const returned = apply(ctx, { feeds: [], timeoutMs: 1000 })
    assert.equal(returned, undefined, 'apply 必须同步返回 undefined；返回 promise 会让调用方的登记顺序失准')
  } finally {
    rmSync(home, { recursive: true, force: true })
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
  }
})
