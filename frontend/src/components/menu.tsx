/**
 * One set of menu building blocks for both right-click (ContextMenu) and "⋯" (DropdownMenu) menus,
 * so the same items can be rendered by either.
 */
import clsx from 'clsx'
import { Check, ChevronRight } from 'lucide-react'
import { ContextMenu as RC, DropdownMenu as RD } from 'radix-ui'
import type { ReactNode } from 'react'
import { touchOnly } from '../lib/dnd'

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

/** Right-click wrapper. Stops the event so an enclosing context menu (e.g. the column's) doesn't open too. */
export function ContextMenu({ trigger, children, onOpenChange }: { trigger: React.ReactElement; children: ReactNode; onOpenChange?: (o: boolean) => void }) {
  return (
    <RC.Root onOpenChange={onOpenChange}>
      {/* off on touch screens: long-press there picks the item up to drag it; menus open from a "⋯" button instead */}
      <RC.Trigger asChild disabled={touchOnly()} onContextMenu={(e) => e.stopPropagation()}>
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
