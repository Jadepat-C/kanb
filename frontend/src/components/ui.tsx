import clsx from 'clsx'
import { Dialog as RDialog, DropdownMenu as RMenu, Popover as RPopover } from 'radix-ui'
import { X } from 'lucide-react'
import { forwardRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'

type Variant = 'primary' | 'ghost' | 'outline' | 'danger'

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }>(
  function Button({ variant = 'outline', size = 'md', className, ...p }, ref) {
    return (
      <button
        ref={ref}
        {...p}
        className={clsx(
          'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none cursor-pointer',
          size === 'sm' ? 'h-7 px-2 text-xs' : 'h-9 px-3 text-sm',
          variant === 'primary' && 'bg-accent text-white hover:bg-indigo-700',
          variant === 'outline' && 'border border-line bg-surface hover:bg-black/5 dark:hover:bg-white/5',
          variant === 'ghost' && 'hover:bg-black/5 dark:hover:bg-white/10',
          variant === 'danger' && 'bg-red-600 text-white hover:bg-red-700',
          className,
        )}
      />
    )
  },
)

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return (
    <input
      ref={ref}
      {...p}
      className={clsx(
        'h-9 w-full rounded-md border border-line bg-surface px-3 text-sm outline-none focus:ring-2 focus:ring-accent/60',
        className,
      )}
    />
  )
})

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </label>
  )
}

export function Avatar({ name, color, size = 24, src }: { name: string; color: string; size?: number; src?: string | null }) {
  const [broken, setBroken] = useState(false)
  // initials from the display name only (labels look like "Name · @username")
  const initials = [...name.split(' · ')[0].trim()].slice(0, 2).join('').toUpperCase()
  if (src && !broken)
    return (
      <img
        src={src}
        alt=""
        title={name}
        onError={() => setBroken(true)}
        className="inline-block shrink-0 rounded-full bg-[var(--surface-2)] object-cover ring-2 ring-[var(--surface)]"
        style={{ width: size, height: size }}
      />
    )
  return (
    <span
      title={name}
      className="inline-flex shrink-0 items-center justify-center rounded-full font-medium text-white ring-2 ring-[var(--surface)]"
      style={{ background: color, width: size, height: size, fontSize: size * 0.42 }}
    >
      {initials}
    </span>
  )
}

export function Dialog({
  open,
  onOpenChange,
  title,
  children,
  wide,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title?: ReactNode
  children: ReactNode
  wide?: boolean
}) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px]" />
        <RDialog.Content
          aria-describedby={undefined}
          className={clsx(
            'fixed left-1/2 top-[4vh] z-50 max-h-[92vh] w-[calc(100vw-24px)] -translate-x-1/2 overflow-y-auto rounded-xl border border-line bg-surface shadow-2xl outline-none',
            wide ? 'max-w-5xl' : 'max-w-md',
          )}
        >
          {title !== undefined && (
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <RDialog.Title className="text-base font-semibold">{title}</RDialog.Title>
              <RDialog.Close className="rounded p-1 text-muted hover:bg-black/5 dark:hover:bg-white/10" aria-label="close">
                <X size={18} />
              </RDialog.Close>
            </div>
          )}
          {title === undefined && <RDialog.Title className="sr-only">dialog</RDialog.Title>}
          {children}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}

export const Menu = RMenu.Root
export const MenuTrigger = RMenu.Trigger
export function MenuContent({ children, align = 'end' }: { children: ReactNode; align?: 'start' | 'end' }) {
  return (
    <RMenu.Portal>
      <RMenu.Content
        align={align}
        sideOffset={4}
        className="z-50 min-w-44 rounded-lg border border-line bg-surface p-1 text-sm shadow-lg"
      >
        {children}
      </RMenu.Content>
    </RMenu.Portal>
  )
}
export function MenuItem({ children, onSelect, danger }: { children: ReactNode; onSelect?: () => void; danger?: boolean }) {
  return (
    <RMenu.Item
      onSelect={onSelect}
      className={clsx(
        'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-black/5 dark:data-[highlighted]:bg-white/10',
        danger && 'text-red-600',
      )}
    >
      {children}
    </RMenu.Item>
  )
}
export const MenuSeparator = () => <RMenu.Separator className="my-1 h-px bg-[var(--border)]" />
export const MenuLabel = ({ children }: { children: ReactNode }) => (
  <RMenu.Label className="px-2 py-1 text-xs text-muted">{children}</RMenu.Label>
)

export function Popover({ trigger, children, align = 'start' }: { trigger: ReactNode; children: ReactNode; align?: 'start' | 'end' }) {
  return (
    <RPopover.Root>
      <RPopover.Trigger asChild>{trigger}</RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content
          align={align}
          sideOffset={4}
          className="z-50 w-64 rounded-lg border border-line bg-surface p-2 text-sm shadow-lg outline-none"
        >
          {children}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  )
}

export function Spinner() {
  return <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
}

export const PALETTE = ['#64748b', '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#0ea5e9', '#6366f1', '#a855f7', '#ec4899']

export function ColorPicker({ value, onChange, allowNone }: { value: string | null; onChange: (c: string | null) => void; allowNone?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {allowNone && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className={clsx('h-6 w-6 rounded-full border border-line bg-surface cursor-pointer', !value && 'ring-2 ring-accent ring-offset-1')}
          aria-label="none"
        >
          <X size={12} className="mx-auto text-muted" />
        </button>
      )}
      {PALETTE.map((c) => (
        <button
          type="button"
          key={c}
          onClick={() => onChange(c)}
          className={clsx('h-6 w-6 rounded-full cursor-pointer', value === c && 'ring-2 ring-accent ring-offset-1 ring-offset-[var(--surface)]')}
          style={{ background: c }}
          aria-label={c}
        />
      ))}
    </div>
  )
}

/** On/off switch. */
export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40 cursor-pointer ${checked ? 'bg-accent' : 'bg-zinc-300 dark:bg-zinc-600'}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${checked ? 'left-4.5' : 'left-0.5'}`} />
    </button>
  )
}
