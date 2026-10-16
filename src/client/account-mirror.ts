/**
 * 六个动作共用的「乐观 → RPC → 覆盖 / 回滚」管线（2026-10-16 C3 收拢）。
 *
 * 收拢前的三处不一致（两轮体检都没抓全，最终逐行 read 出来的）：
 *  ① 失败策略分裂 —— toggleStar / toggleKeepUnread / toggleRead 失败回滚乐观态，
 *     markRead / markAllRead / undoMarkAll 失败只进 error 条、界面留在乐观态；
 *  ② toggleStar / toggleKeepUnread 把 `await callRpc(...)` 的回包整个丢掉，
 *     而回包里带着宿主按全量表算出的 unread / perFeedUnread（分发核按 carriesAccount 合并）；
 *  ③ 于是「乐观 → 覆盖 → 失败」的判据散在 6 处注释里，没有一处能对照出全貌。
 *
 * 2026-10-16 产品拍板：六个动作失败**统一回滚**（失败 = 动作没发生，界面回到按下前）。
 *
 * 不变量（全部收在本文件；store 侧动作只保留守卫与载荷组装）：
 *
 *  ① **账目的口径只有宿主回包一份** —— 成功路径一律 applyAccount 整体覆盖，客户端不从
 *     items 派生 unread / perFeedUnread（截断视图当真相 ⇒ 幽灵未读，任务 9 实测；
 *     详细推导仍在 src/client/store.ts 的 applyAccount 头注释，那是这条不变量的家）。
 *  ② **失败统一回滚，回滚用按下时刻的快照**而不是「反向增量」：夹取过 0 的减量
 *     （Math.max(0, n-1) 实际减了 0）没法用 +1 精确还原；快照把 optimistic 触碰过的
 *     每个字段恢复到按下那一刻的值，与夹取无关。
 *  ③ **回滚只恢复本动作触碰的字段**。并发窗口内另一个在飞动作若也改了同一字段，
 *     先失败者的恢复会盖掉它的乐观态 —— 分两类如实声明：
 *     · **账目**（unread / perFeedUnread）：任一成功回包整体覆盖自愈（六端点全 carriesAccount）；
 *     · **条目字段**（readAt / starred / keptUnread）：**不自愈**，要等下一次 overview 才与宿主
 *       一致（源码 trace 推导，未实测复现；三条件同立才触发：两动作在飞 + 交集条目 + 先失败
 *       后成功）。要消除就全面改 CAS 式回滚（恢复前比对「现值 === 本动作写入的乐观值」，
 *       约 3 行/动作）——已记入 HANDOFF 候选，单飞场景无差别，本轮不为低概率路径加复杂度。
 *     例外：undo 条带**身份 CAS**（见 undoMarkAll 的 rollback）—— 撤销条是单槽资源，
 *     被并发更晚的 A 盖写后，旧 batch 的恢复会把别人的条目盖回来。
 *  ④ **回包里的动作结果字段（starred / changed / itemId）刻意不落地**：乐观翻转已是
 *     本地真相，「翻转是否成功」由失败回滚保证；回包要纠正的是账目，不是动作本身。
 *
 * 动作 × 行为表（判据之家；tests/client-bundle.test.mjs 按此表钉用例与变异）：
 *
 *   动作               乐观更新                    成功                    失败（统一回滚）
 *   markRead           readAt + 账目减             applyAccount            readAt/账目回快照
 *   toggleStar         starred 翻转                applyAccount            starred 回按下前
 *   toggleKeepUnread   keptUnread 翻转             applyAccount            keptUnread 回按下前
 *   toggleRead（标读）  = markRead                  =                       =
 *   toggleRead（撤销）  readAt 清 + 账目加          applyAccount            readAt/账目回快照
 *   markAllRead        批量 readAt + 账目减 + undo  applyAccount（undo 留） 全部回快照 + undo 条撤掉
 *   undoMarkAll        批量 readAt 清 + 角标加     applyAccount（undo 清） 全部回快照 + undo 条恢复并重新武装
 *
 * 纯 Node ESM、不碰 DOM：单测经 tests/client-bundle.test.mjs 加载 lib/client.js 产物驱动。
 */
import type { Endpoint, UnreadAccount } from '../shared.js'

/** 管线的一格动作：守卫与载荷组装完之后，交给 run 的三步。 */
export interface MirrorAction {
  /** 打到哪个端点（shared.ts 的 Endpoint：拼错名字是编译错误） */
  endpoint: Endpoint
  payload?: unknown
  /** 按下即应用（RPC 发出前同步调用）：手感先行，界面先动。闭包捕获的必须是按下前的值。 */
  optimistic(): void
  /** 失败时把 optimistic 触碰过的每一处恢复到按下时刻（快照在动作体内捕获）。 */
  rollback(): void
}

export interface AccountMirrorDeps {
  callRpc: <T>(endpoint: Endpoint, payload?: unknown) => Promise<T>
  /** 回包整体覆盖账目 —— store.applyAccount 原样传入，不变量注释仍在它头上。 */
  applyAccount: (account: UnreadAccount) => void
  /** 错误可见（AGENTS.md 禁空 catch）：store 侧 `set({ error })`，由面板说出来。 */
  fail: (failure: unknown) => void
}

export function createAccountMirror(deps: AccountMirrorDeps): { run(action: MirrorAction): Promise<void> } {
  return {
    async run(action: MirrorAction): Promise<void> {
      action.optimistic()
      try {
        // 成功 = 以宿主回包为准整体覆盖账目（不变量 ①）；动作结果字段不落地（不变量 ④）。
        deps.applyAccount(await deps.callRpc<UnreadAccount>(action.endpoint, action.payload))
      } catch (failure) {
        // 失败 = 动作没发生（2026-10-16 拍板）：先回滚，错误再进 error 条 ——
        // 顺序不能反，面板渲染 error 不依赖回滚，但「报错的同时界面还是乐观态」自相矛盾。
        action.rollback()
        deps.fail(failure)
      }
    },
  }
}
