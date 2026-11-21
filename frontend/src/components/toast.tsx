import { useEffect, useState } from 'react'
import { errorText } from '../lib/i18n'

type Toast = { id: number; text: string; kind: 'error' | 'info' }
let listeners: ((t: Toast[]) => void)[] = []
let toasts: Toast[] = []
let seq = 0

function emit() {
  listeners.forEach((l) => l(toasts))
}

export function toast(text: string, kind: Toast['kind'] = 'info') {
  const t = { id: ++seq, text, kind }
  toasts = [...toasts, t]
  emit()
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id)
    emit()
  }, 4000)
}

export const toastError = (e: unknown) => toast(errorText(e), 'error')

export function Toaster() {
  const [items, setItems] = useState<Toast[]>([])
  useEffect(() => {
    listeners.push(setItems)
    return () => {
      listeners = listeners.filter((l) => l !== setItems)
    }
  }, [])
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          className={
            'pointer-events-auto rounded-lg px-4 py-2 text-sm shadow-lg ' +
            (t.kind === 'error' ? 'bg-red-600 text-white' : 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900')
          }
        >
          {t.text}
        </div>
      ))}
    </div>
  )
}
