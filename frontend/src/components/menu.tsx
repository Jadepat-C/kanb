/**
 * One set of menu building blocks for both right-click (ContextMenu) and "⋯" (DropdownMenu) menus,
 * so the same items can be rendered by either.
 */
import clsx from 'clsx'
import { Check, ChevronRight } from 'lucide-react'
import { ContextMenu as RC, DropdownMenu as RD } from 'radix-ui'
import { useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { useMedia } from '../lib/dnd'

export type MenuKit = typeof RC
export const CTX = RC as MenuKit
export const DROP = RD as unknown as MenuKit

/**
 * A menu normally puts focus back where it was (the "⋯" button, or the right-clicked element) after it closes. An item
 * that opens an inline text box instead calls this first, so that box keeps the focus: otherwise it loses focus right
 * away (and saves and closes), and the keys meant for it go to whatever got the focus back.
 */
let keepFocus = false
export const keepFocusAfterClose = () => {
  keepFocus = true
}
export const closeAutoFocus = (e: Event) => {
  if (keepFocus) e.preventDefault()
  keepFocus = false
}

export const contentCls = 'z-50 min-w-48 rounded-lg border border-line bg-surface p-1 text-sm shadow-lg'
const itemCls =
  'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-black/5 dark:data-[highlighted]:bg-white/10'

export function MItem({
  M,
  onSelect,
  danger,
  disabled,
  keepOpen,
  checked,
  shortcut,
  children,
}: {
  M: MenuKit
  onSelect?: () => void
  danger?: boolean
  disabled?: boolean
  /** keep the menu open after selecting (toggles like labels) */
  keepOpen?: boolean
  checked?: boolean
  shortcut?: string
  children: ReactNode
}) {
  return (
    <M.Item
      disabled={disabled}
      onSelect={(e) => {
        if (keepOpen) e.preventDefault()
        onSelect?.()
      }}
      className={clsx(itemCls, danger && 'text-red-600')}
    >
      {children}
      {checked !== undefined && <Check size={14} className={clsx('ml-auto', !checked && 'invisible')} />}
      {shortcut && <span className="ml-auto pl-4 text-xs text-muted">{shortcut}</span>}
    </M.Item>
  )
}

export function MSub({ M, icon, label, children }: { M: MenuKit; icon?: ReactNode; label: ReactNode; children: ReactNode }) {
  return (
    <M.Sub>
      <M.SubTrigger className={clsx(itemCls, 'data-[state=open]:bg-black/5 dark:data-[state=open]:bg-white/10')}>
        {icon}
        {label}
        <ChevronRight size={14} className="ml-auto text-muted" />
      </M.SubTrigger>
      <M.Portal>
        <M.SubContent sideOffset={4} collisionPadding={8} className={clsx(contentCls, 'max-h-[70dvh] overflow-y-auto')}>
          {children}
        </M.SubContent>
      </M.Portal>
    </M.Sub>
  )
}

export const MSep = ({ M }: { M: MenuKit }) => <M.Separator className="my-1 h-px bg-[var(--border)]" />
export const MLabel = ({ M, children }: { M: MenuKit; children: ReactNode }) => (
  <M.Label className="truncate px-2 py-1 text-xs text-muted">{children}</M.Label>
)

/**
 * Touch screens have no right-click. There a long press already picks a card (or column, or board) up to drag it, so
 * the menu opens when you lift your finger after holding still: hold and move = drag, hold and let go = menu.
 * Radix's own long-press (open while still holding) and the browser's long-press menu are both kept out of the way.
 */
const HOLD_MS = 450
const SLOP_PX = 10
let press: { x: number; y: number; t: number; moved: boolean } | null = null
type Marked = Event & { __kanbMenu?: boolean }

/**
 * Touches this menu leaves alone: inside a text box (long-press there selects text / pastes), or in something rendered
 * elsewhere on the page but inside this element in React (a dialog opened from a card or column).
 */
const notOurs = (e: React.SyntheticEvent) => {
  const t = e.target as Element
  return !e.currentTarget.contains(t) || !!t.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]')
}

/** Right-click wrapper. Stops the event so an enclosing context menu (e.g. the column's) doesn't open too. */
export function ContextMenu({ trigger, children, onOpenChange }: { trigger: React.ReactElement; children: ReactNode; onOpenChange?: (o: boolean) => void }) {
  const touch = useMedia('(hover: none)')
  // on touch screens Radix's own handling (open 700 ms into any touch, even mid-drag or in a text box) stays off;
  // it's switched on just long enough to open the menu when a hold ends
  const [armed, setArmed] = useState(false)
  const touchHandlers = touch
    ? {
        onTouchStart: (e: React.TouchEvent) => {
          const n = e.nativeEvent as Marked
          if (n.__kanbMenu) return // an inner menu (e.g. the card inside a column) owns this touch
          n.__kanbMenu = true
          const p = e.touches[0]
          press = e.touches.length === 1 && !notOurs(e) ? { x: p.clientX, y: p.clientY, t: Date.now(), moved: false } : null
        },
        onTouchMove: (e: React.TouchEvent) => {
          const p = e.touches[0]
          if (press && p && Math.hypot(p.clientX - press.x, p.clientY - press.y) > SLOP_PX) press.moved = true
        },
        onTouchCancel: () => (press = null),
        onTouchEnd: (e: React.TouchEvent) => {
          const n = e.nativeEvent as Marked
          if (n.__kanbMenu) return
          n.__kanbMenu = true
          const p = press
          press = null
          if (!p || p.moved || Date.now() - p.t < HOLD_MS) return
          // no click after the long press: it would land on the menu that's about to open under the finger
          e.preventDefault()
          const el = e.currentTarget
          flushSync(() => setArmed(true))
          el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y }))
          setArmed(false)
          navigator.vibrate?.(10)
        },
      }
    : {}
  return (
    <RC.Root onOpenChange={onOpenChange}>
      <RC.Trigger
        asChild
        disabled={touch && !armed}
        {...touchHandlers}
        onContextMenu={(e) => {
          e.stopPropagation()
          // the browser's own long-press menu (Android): not on items (their menu opens on release instead), but
          // still in text boxes, where it's how you copy and paste
          if (touch && !armed && !notOurs(e)) e.preventDefault()
        }}
        className="[-webkit-touch-callout:none]"
      >
        {trigger}
      </RC.Trigger>
      <RC.Portal>
        <RC.Content collisionPadding={8} className={contentCls} onCloseAutoFocus={closeAutoFocus}>
          {children}
        </RC.Content>
      </RC.Portal>
    </RC.Root>
  )
}
