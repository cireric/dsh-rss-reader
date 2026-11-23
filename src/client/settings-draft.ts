/**
 * 设置行共用的草稿状态（R8a 评审 #4）：草稿 + 脏标记 + 「已保存 ✓」闪显。
 *
 * 为什么抽出来：四个数值行与 RSSHub 地址行原先各自复制了一份同样的状态机 —— 两份在
 * 「别的保存回包不许冲掉草稿」「已保存闪约 1.4 秒」这些不变量上必须逐字一致，复制两套
 * 迟早一处改一处忘。语义确有分叉的部分（数字行按模式解析、RSSHub 行还有测试连接）留在
 * 组件，这里只保留两条行共有的那部分；分叉用显式方法表达（reject / revert / succeed / fail），
 * 不做「一个万能 setState」式的隐式约定。
 *
 * dirty 用 ref 而不是 state：它只是提交守卫（聚焦后失焦不许写盘），不参与渲染；用 state
 * 会多一次无意义的重绘，也会让「回包到达时草稿是否该跟随」的判定多一帧延迟。
 */
import { useEffect, useRef, useState } from 'react'

/** 成功反馈的停留时间：短到不挡视线，长到能看见（spec D14.2 定稿「约 1.4 秒」）。 */
export const SAVED_FEEDBACK_MS = 1400

/** 一条设置行共享的草稿状态与迁移动作。 */
export interface SettingsDraft {
  /** 输入框里正在编辑的文本。 */
  draft: string
  /** 就地红字；undefined = 无错误。 */
  error: string | undefined
  /** 「已保存 ✓」是否在闪显窗口内。 */
  saved: boolean
  /** 是否有用户尚未提交的编辑（同步读，供提交守卫）。 */
  isDirty: () => boolean
  /** 用户键入：标脏、更新草稿、清红字。 */
  edit: (text: string) => void
  /** 非键入地替换草稿（如「恢复默认」）：清脏、清红字。 */
  replace: (text: string) => void
  /** 提交前：清掉上一次的红字与「已保存」，但不动草稿与脏标记。 */
  beginSave: () => void
  /** 输入非法：就地红字，不闪「已保存」。 */
  reject: (message: string) => void
  /** 编辑过但权威值没变：清脏并归位到权威值的展示形式。 */
  revert: () => void
  /** 保存成功：清脏、闪「已保存 ✓」约 1.4 秒。 */
  succeed: () => void
  /** 保存失败：保留草稿（脏标记不动），红字给出原因。 */
  fail: (message: string) => void
}

/**
 * 创建一个设置行的草稿状态。
 *
 * `effectiveText` 是宿主下发的权威值在当前行的展示文本（数字行按模式格式化，RSSHub 行是
 * `value ?? ''`）。只有用户没有未提交输入时草稿才跟随它 —— 这正是「另一个框保存成功后，
 * 不许把本框正在打的字冲掉」那条不变量的实现点。
 */
export function useSettingsDraft(effectiveText: string): SettingsDraft {
  const [draft, setDraft] = useState(effectiveText)
  const [error, setError] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const dirty = useRef(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (!dirty.current) setDraft(effectiveText)
  }, [effectiveText])

  // 卸载时清掉计时器：定时器回调更新一个已卸载组件的 state 是无意义的泄漏。
  useEffect(() => () => {
    if (savedTimer.current !== undefined) clearTimeout(savedTimer.current)
  }, [])

  const edit = (text: string): void => {
    dirty.current = true
    setDraft(text)
    setError(undefined)
  }

  const replace = (text: string): void => {
    dirty.current = false
    setDraft(text)
    setError(undefined)
  }

  const beginSave = (): void => {
    setError(undefined)
    setSaved(false)
  }

  const reject = (message: string): void => {
    setError(message)
    setSaved(false)
  }

  const revert = (): void => {
    dirty.current = false
    setDraft(effectiveText)
    setError(undefined)
  }

  const succeed = (): void => {
    dirty.current = false
    setSaved(true)
    if (savedTimer.current !== undefined) clearTimeout(savedTimer.current)
    savedTimer.current = setTimeout(() => setSaved(false), SAVED_FEEDBACK_MS)
  }

  const fail = (message: string): void => {
    // 草稿与 dirty 都不动：失败后输入框里还是用户写的那份，回包不许把它冲掉。
    setError(message)
    setSaved(false)
  }

  return {
    draft, error, saved, isDirty: () => dirty.current,
    edit, replace, beginSave, reject, revert, succeed, fail,
  }
}
