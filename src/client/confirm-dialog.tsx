/**
 * 确认框的共享外壳（R11 评审 S6 / P7）：三处模态复用同一份「role=dialog + aria-modal +
 * Esc + 焦点归还 + 取消/确认」的实现 —— A 的「全部标为已读」、设置页的「恢复默认」与「立即清理」。
 *
 * 为什么 Esc 挂在 **window 的捕获阶段**，而不是卡片的 onKeyDown：
 *  - 卡片 onKeyDown 只在焦点已经进框时收得到；刚点开确认框、焦点还在触发按钮上的那一瞬，
 *    Esc 会沿 document 冒泡到 `routeKey` 的 `back`，在设置页里直接退出设置页（评审 P7）。
 *  - `routeKey` 的监听器挂在 document（冒泡）。确认框若也挂 document，事件 target 恰好是
 *    document 时两者同处 target 阶段，只按注册顺序执行 —— 先注册的 routeKey 仍会先跑。
 *    挂 window 捕获阶段才能稳定先于任何 document 监听器，并且对「焦点在框内 / 框外」都成立。
 *  - 捕获阶段先 `preventDefault + stopPropagation`，routeKey 与卡片自己的处理都不会再跑；
 *    这里就是唯一的 Esc 出口，不再出现「两处各写一份、行为漂移」。
 *
 * 测试锚点（`data-rss-*-confirm` / `-ok` / `-cancel`）由调用点原样传入：共享的是控件形状与
 * 键盘语义，不是 DOM 命名 —— 既有 DOM 测试因此不用改锚点。
 */
import { useEffect, useRef, type ReactNode, type RefObject } from 'react'

export interface ConfirmDialogProps {
  /** `aria-labelledby` 指向的标题节点 id。 */
  readonly titleId: string
  /** 标题内容（ReactNode：MarkAll 的标题带动态条数）。 */
  readonly title: ReactNode
  /** 标题节点上的动态测试锚点（如 `data-rss-markall-count`）。 */
  readonly titleAttrs?: Readonly<Record<string, string>>
  /** 遮罩层的测试锚点（如 `data-rss-cleanup-confirm`）。 */
  readonly rootAttrs?: Readonly<Record<string, string>>
  /** 卡片的测试锚点（如 `data-rss-reset-confirm`）。 */
  readonly cardAttrs?: Readonly<Record<string, string>>
  /** 确认按钮的测试锚点（如 `data-rss-reset-ok`）。 */
  readonly confirmAttrs?: Readonly<Record<string, string>>
  /** 取消按钮的测试锚点（如 `data-rss-reset-cancel`）。 */
  readonly cancelAttrs?: Readonly<Record<string, string>>
  readonly confirmLabel: ReactNode
  readonly cancelLabel?: string
  /** 正在执行：两个按钮禁用，Esc 也不关框（与原来「恢复中」的语义一致）。 */
  readonly busy?: boolean
  readonly confirmDisabled?: boolean
  /** 确认键的 ref：调用点需要时（MarkAll 的范围下拉选完把焦点还给它）。 */
  readonly confirmRef?: RefObject<HTMLButtonElement>
  /** 标题与按钮之间的内容（范围选择 / 将变化的项 / 说明）。 */
  readonly children?: ReactNode
  /** 就地错误（恢复默认失败）。 */
  readonly error?: ReactNode
  /**
   * 关闭（取消 / Esc / 确认）后焦点归还给谁。
   *
   * 放在卸载时执行而不是每个出口各写一遍：三条出口都会让本组件卸载，焦点归还因此只有
   * 一个时机；调用点只负责算出「触发这次确认的那个控件」。
   */
  readonly returnFocus?: () => void
  readonly onCancel: () => void
  readonly onConfirm: () => void
}

export function ConfirmDialog(props: ConfirmDialogProps): ReactNode {
  const {
    titleId, title, titleAttrs, rootAttrs, cardAttrs, confirmAttrs, cancelAttrs,
    confirmLabel, cancelLabel = '取消', busy = false, confirmDisabled = false, confirmRef,
    children, error, returnFocus, onCancel, onConfirm,
  } = props
  const localConfirmRef = useRef<HTMLButtonElement | null>(null)
  const confirmButton = confirmRef ?? localConfirmRef
  // Esc 处理器在 effect 生命周期里；回调走 ref 读取最新值，避免把 onCancel 的闭包钉在
  // 「注册那一刻」的 props 上（与 keyboard-routing 的闭包捕获是同一族教训）。
  const cancelRef = useRef(onCancel)
  cancelRef.current = onCancel
  const returnFocusRef = useRef(returnFocus)
  returnFocusRef.current = returnFocus

  // 打开即聚焦确认键：Enter 直接确认，Tab 到取消（与三处原实现同一条键盘流）。
  useEffect(() => { confirmButton.current?.focus() }, [confirmButton])

  // 卸载时归还焦点。调用点自己判断触发器是否还在文档里（例如成功恢复默认后按钮会禁用）。
  useEffect(() => () => { returnFocusRef.current?.() }, [])

  useEffect(() => {
    const onKeyDown = (event: Event): void => {
      // EventTarget 的监听器签名是 Event；键盘事件在这里用结构判据收窄，不用全局 instanceof。
      if (!('key' in event) || event.key !== 'Escape') return
      // 先断开传播再判断 busy：正在写盘的确认框也不许把 Esc 漏给 routeKey。
      event.preventDefault()
      event.stopPropagation()
      if (busy) return
      cancelRef.current()
    }
    // window 捕获阶段：见文件头注释（document target 时捕获/冒泡同阶段，注册顺序不可靠）。
    const view = document.defaultView
    const target: EventTarget = view ?? document
    target.addEventListener('keydown', onKeyDown, true)
    return () => { target.removeEventListener('keydown', onKeyDown, true) }
  }, [busy])

  return (
    <div className="dsh-rss-confirm" {...rootAttrs}>
      <div className="dsh-rss-confirm-card" role="dialog" aria-modal="true" aria-labelledby={titleId} {...cardAttrs}>
        <div className="dsh-rss-confirm-title" id={titleId} {...titleAttrs}>{title}</div>
        {children}
        {error}
        <div className="dsh-rss-confirm-actions">
          <button type="button" className="dsh-rss-btn" disabled={busy}
            {...cancelAttrs} onClick={onCancel}>{cancelLabel}</button>
          <button ref={confirmButton} type="button" className="dsh-rss-btn dsh-rss-btn--primary"
            disabled={busy || confirmDisabled} {...confirmAttrs} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
