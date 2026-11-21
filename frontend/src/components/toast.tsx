import clsx from 'clsx'
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { errorText } from '../lib/i18n'
import { Avatar } from './ui'

type Kind = 'success' | 'error' | 'info' | 'activity'
type Toast = { id: number; text: string; kind: Kind; who?: { name: string; color: string; src?: string } }
let listeners: ((t: Toast[]) => void)[] = []
let toasts: Toast[] = []
let seq = 0

function emit() {
  listeners.forEach((l) => l(toasts))
}

function dismiss(id: number) {
  toasts = toasts.filter((x) => x.id !== id)
  emit()
}

function push(t: Omit<Toast, 'id'>, ms: number) {
  const item = { ...t, id: ++seq }
  toasts = [...toasts, item].slice(-5)
  emit()
  setTimeout(() => dismiss(item.id), ms)
}

/** `toast(text)` = neutral info; second arg picks the style. */
export function toast(text: string, kind: Exclude<Kind, 'activity'> = 'info') {
  push({ text, kind }, kind === 'error' ? 6000 : 3500)
}
export const toastSuccess = (text: string) => toast(text, 'success')
export const toastError = (e: unknown) => toast(errorText(e), 'error')
/** Something another person did (shown with their avatar). */
export const toastActivity = (who: { name: string; color: string; src?: string }, text: string) => push({ text, kind: 'activity', who }, 5000)

export function Toaster() {
  const [items, setItems] = useState<Toast[]>([])
  useEffect(() => {
    listeners.push(setItems)
    return () => {
      listeners = listeners.filter((l) => l !== setItems)
    }
  }, [])
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(380px,calc(100vw-32px))] flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          className={clsx(
            'pointer-events-auto flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm shadow-lg',
            'animate-[toast-in_.18s_ease-out] bg-surface border-line',
            t.kind === 'error' && 'border-red-500/40',
          )}
        >
          {t.kind === 'activity' && t.who ? (
            <Avatar name={t.who.name} color={t.who.color} src={t.who.src} size={22} />
          ) : t.kind === 'success' ? (
            <CircleCheck size={18} className="mt-px shrink-0 text-green-600" />
          ) : t.kind === 'error' ? (
            <CircleAlert size={18} className="mt-px shrink-0 text-red-600" />
          ) : (
            <Info size={18} className="mt-px shrink-0 text-accent" />
          )}
          <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            {t.who && <span className="font-semibold">{t.who.name} </span>}
            {t.text}
          </div>
          <button onClick={() => dismiss(t.id)} className="shrink-0 rounded p-0.5 text-muted hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer" aria-label="close">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
