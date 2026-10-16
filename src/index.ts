/**
 * @dsh-external/dsh-rss-reader —— 宿主接线（2026-10-15 H2 之后本文件只剩这一件事）。
 *
 * **这个文件现在只做四件事**：导出 schema 与身份 → 解析配置 → **同步**登记两个 effect →
 * 把 dispatch 与生命周期 session 接起来。装载链、刷新编排、传输壳、日志策略都搬进了各自的
 * module（src/lifecycle.ts · src/endpoints.ts · src/storage/log-file.ts），它们不 import cordis、
 * 不碰 ctx，因此可以被直接驱动来测 —— 这正是搬动的目的。
 *
 * 仍然不含定时器：刷新由「装载时」与「浏览器半打开面板时」触发，且受最小间隔节流；
 * 验收标准 §6 要求卸载不留残余，常驻轮询等确有必要时再单独设计。
 * 也不注册模型工具：模型可见即已记录（技能硬规则 #8），阅读面走 UI。
 */
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { join } from 'node:path'
import { storageRoot } from './storage/paths.js'
import { createLogger } from './storage/log-file.js'
import type { FeedOutcome } from './refresh.js'
import { Config } from './config.js'
import type { Config as ConfigShape } from './config.js'
// **入口必须导出 schema 本身**：宿主（含注入器）靠它给 config 补默认值。
// 2026-10-08 实测的回归：拆分把 Config 搬进 config.ts 时只 import 没再导出，于是注入器传进来的
// config 不再经过 schema —— 全字段 undefined，抓取 / 正文缓存闸门 / 清理端点三处硬故障。
export { Config }
import { createDispatch, createHttpHandler } from './endpoints.js'
import { createLifecycle } from './lifecycle.js'
import { ROUTE_PATH } from './shared.js'

export const name = '@dsh-external/dsh-rss-reader'

/**
 * 硬依赖：RPC 通道 + web server。
 * connection 的 rpc.handle 会把逻辑通道落成一条物理路由，因此它内部要取 ctx.webServer——
 * 自己没声明注入就抛 "cannot get property webServer without inject"（实测，注入器把这条
 * 原本会被吞掉的错误回传后一眼定位）。
 *
 * ⚠️ 这里曾声明过 `storageDomain`，Task 8 随自持存储一并摘掉：插件不再打开任何存储域，
 * 留着会让「切回存储域」看起来只差改一行代码，实际是数据已经搬走了、装回来只会读到空库。
 *
 * ⚠️ 但**依赖还在**（`package.json` 的 peerDependency + `build.sh` 的 link_pkg）：
 * `src/domain.ts` 仍 import `defineDomain`（定义 readerDomain），`src/store.ts` 仍 import type，
 * 删掉那条 link 会让从零 build 直接 TS2307（实测）。存活的唯一消费者是旧适配器 `createStore`，
 * 它只被测试当同义性基线用（见 scripts/build.sh 的注释）。**别把这三处的删除当成一步**。
 */
export const inject = ['connection', 'webServer']

/**
 * 刷新结果的人类可读摘要 —— **措辞归宿主**：生命周期只负责跑与记，摘要面向人。
 */
function summarize(outcomes: readonly FeedOutcome[]): string {
  if (outcomes.length === 0) return '未配置订阅源（Config.feeds 为空），跳过刷新'
  const lines = outcomes.map((outcome) => {
    const head = outcome.url + ' → ' + outcome.status + (outcome.status === 'added' ? '(+' + outcome.added + ')' : '')
    const notes: string[] = []
    if (outcome.untrusted !== undefined) {
      notes.push('⚠ ' + outcome.untrusted + ' 条身份不可信（源内 id 撞车且 URL 不同，已按 URL 重算）')
    }
    if (outcome.reclaimed !== undefined) {
      notes.push('ℹ ' + outcome.reclaimed + ' 条认回老身份（源改过 id 形态或链接，未产生重复）')
    }
    if (outcome.reason !== undefined) notes.push(outcome.reason)
    return notes.length === 0 ? head : head + '（' + notes.join('；') + '）'
  })
  return '刷新完成，共 ' + outcomes.length + ' 源:\n' + lines.join('\n')
}

export function apply(ctx: Context, rawConfig: ConfigShape): void {
  // ⚠️ apply 必须是**同步**的，且所有 ctx.effect 都要在同步段登记完。
  // 一旦在里面 await 过，fiber 可能已被 reload/dispose，随后的 ctx.effect 会抛
  // "cannot create effect on inactive context"（实测栈：Fiber._reload → apply → ctx.effect）。
  // 因此下面两处 effect 都只登记同步的「开始 / 归还 disposer」，异步部分在各自 module 内部。
  //
  // 先解析配置：下面 logger 的落点就要用 config，所以它必须是 apply 的第一件事。
  const config = Config(rawConfig ?? {} as ConfigShape)
  // 自持存储的落点：**不传 dshHome**，交给 storageRoot → resolveDshHome（Task 2 的唯一算法）。
  // 这里原先还手抄过一份 `process.env.DSH_HOME || join(homedir(), '.dsh')`，只给旧日志路径用
  // —— 路径来源现在只有一份。
  const storagesRoot = storageRoot()
  // 订阅映射与视图偏好的落点（Task 2 的 config.json）：宿主半只在装配处用它，其余读写全在 store 里
  const configFile = join(storagesRoot, 'config.json')

  // ⚠️ logger 在存储根目录**被建之前**就要能用：装载链最开始那几条日志（配置未经解析、清理
  // 超期日志）都早于 ensureStorageRoot。createLogger 自己 mkdir，所以那条线不会断；它同时
  // 保证默认落点的目录是 0700（订阅与已读态同住，umask 默认的 0755 不行）。
  const log = createLogger({
    logFile: config.logFile,
    storagesRoot,
    sink: (line) => ctx.logger?.info?.(line),
    warn: (line) => ctx.logger?.warn?.(line),
  })

  // 宿主没替我们解析过 config 时要留痕（见上面 Config 导出的注释：缺了它就是这个症状）
  if (rawConfig?.feeds === undefined || rawConfig?.timeoutMs === undefined) {
    log('宿主传入的配置未经 schema 解析（' + JSON.stringify(rawConfig ?? null).slice(0, 60) + '），已按 schema 默认值补齐')
  }

  // 生命周期：打开 → 刷新 → 关停。它与 ctx 无关，测试直接 start/stop（2026-10-15 H2）。
  const session = createLifecycle({ config, storagesRoot, configFile, log, summarize })

  // 端点注册表：14 个端点一处声明（src/endpoints.ts）。
  const dispatch = createDispatch({
    config, log,
    ready: session.ready,
    refreshNow: session.refreshNow,
    lastRefreshCompletedAt: session.lastRefreshCompletedAt,
    articleAttempts: session.articleAttempts,
  })

  ctx.effect(() => {
    let dispose: (() => void) | undefined
    try {
      dispose = ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PATH,
        // 传输层（准入 / 方法 / 读 body / 信封）在 endpoints.ts；这里只负责注册。
        handler: createHttpHandler(dispatch, {
          requestRejection: (req) => ctx.connection.requestRejection(req),
        }),
      })
    } catch (error) {
      // 热重载竞态：上一代 fiber 的路由没被释放时，这里会撞 "duplicate prefix route"。
      // webServer 只提供 register(route) 返回 disposer，**没有「列出/注销路由」的公开 API**，
      // 所以插件侧无法自救（清残留路由是注入器 dev_clear_routes 的事，或重启 DSH）。
      // 但至少要响亮地说清楚发生了什么、怎么恢复 —— 而不是让 fiber 带着一条只躺在注入器日志里的
      // 错误静默死掉。2026-10-08 实测：插件因此静默宕机约 7 小时，测试全绿、插件日志毫无痕迹。
      log('HTTP 路由注册失败：' + String(error))
      log('恢复：先清残留路由再重新注入（注入器 dev_clear_routes prefix=' + ROUTE_PATH + ' → dev_inject_plugin），或重启 DSH 进程')
      throw error
    }
    return () => {
      dispose?.()
    }
  }, 'dsh-rss-reader: http route')

  // 自持存储与启动刷新：同步登记，异步部分全在 session 内部。
  ctx.effect(() => {
    const starting = session.start()
    return async () => {
      await session.stop()
      await starting
    }
  }, 'dsh-rss-reader: sqlite storage + start refresh')
}
