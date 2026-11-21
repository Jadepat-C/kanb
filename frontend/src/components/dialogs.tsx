/**
 * In-app replacements for window.confirm / window.prompt:
 *   if (await ask({ title, message, confirmLabel, danger: true })) …
 *   const v = await askText({ title, label, defaultValue })
 * <DialogHost /> (mounted once in main.tsx) renders them.
 */
import { AlertTriangle } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, Input } from './ui'

export interface AskOptions {
  title: string
  message?: ReactNode
  confirmLabel?: string
  danger?: boolean
  /** require typing this word (e.g. "Delete") before the button enables */
  typeToConfirm?: string
}
export interface AskTextOptions {
  title: string
  label?: string
  defaultValue?: string
  placeholder?: string
  inputType?: 'text' | 'number'
  confirmLabel?: string
}

type Req =
  | { id: number; kind: 'confirm'; opts: AskOptions; resolve: (v: boolean) => void }
  | { id: number; kind: 'text'; opts: AskTextOptions; resolve: (v: string | null) => void }

let queue: Req[] = []
let listener: ((q: Req[]) => void) | null = null
let seq = 0
const emit = () => listener?.([...queue])

export function ask(opts: AskOptions): Promise<boolean> {
  return new Promise((resolve) => {
    queue.push({ id: ++seq, kind: 'confirm', opts, resolve })
    emit()
  })
}

export function askText(opts: AskTextOptions): Promise<string | null> {
  return new Promise((resolve) => {
    queue.push({ id: ++seq, kind: 'text', opts, resolve })
    emit()
  })
}

function close(id: number) {
  queue = queue.filter((r) => r.id !== id)
  emit()
}

export function DialogHost() {
  const [items, setItems] = useState<Req[]>([])
  useEffect(() => {
    listener = setItems
    return () => {
      listener = null
    }
  }, [])
  const top = items[0]
  if (!top) return null
  return top.kind === 'confirm' ? (
    <ConfirmBox key={top.id} req={top} />
  ) : (
    <TextBox key={top.id} req={top} />
  )
}

function ConfirmBox({ req }: { req: Extract<Req, { kind: 'confirm' }> }) {
  const { t } = useTranslation()
  const { opts } = req
  const [typed, setTyped] = useState('')
  const ok = !opts.typeToConfirm || typed.trim().toLowerCase() === opts.typeToConfirm.toLowerCase()
  const done = (v: boolean) => {
    req.resolve(v)
    close(req.id)
  }
  return (
    <Dialog open onOpenChange={(o) => !o && done(false)} title={opts.title}>
      <form
        className="space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (ok) done(true)
        }}
      >
        {opts.message && (
          <div className="flex gap-3 text-sm">
            {opts.danger && <AlertTriangle size={20} className="mt-0.5 shrink-0 text-red-600" />}
            <div className="min-w-0">{opts.message}</div>
          </div>
        )}
        {opts.typeToConfirm && (
          <label className="block space-y-1 text-sm">
            <span className="text-muted">{t('confirm.typeToConfirm', { text: opts.typeToConfirm })}</span>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus placeholder={opts.typeToConfirm} />
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => done(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant={opts.danger ? 'danger' : 'primary'} disabled={!ok} autoFocus={!opts.typeToConfirm}>
            {opts.confirmLabel ?? t('common.yes')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function TextBox({ req }: { req: Extract<Req, { kind: 'text' }> }) {
  const { t } = useTranslation()
  const { opts } = req
  const [v, setV] = useState(opts.defaultValue ?? '')
  const done = (val: string | null) => {
    req.resolve(val)
    close(req.id)
  }
  return (
    <Dialog open onOpenChange={(o) => !o && done(null)} title={opts.title}>
      <form
        className="space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          done(v)
        }}
      >
        <label className="block space-y-1 text-sm">
          {opts.label && <span className="text-muted">{opts.label}</span>}
          <Input
            type={opts.inputType ?? 'text'}
            min={opts.inputType === 'number' ? 0 : undefined}
            value={v}
            onChange={(e) => setV(e.target.value)}
            placeholder={opts.placeholder}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => done(null)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary">{opts.confirmLabel ?? t('common.save')}</Button>
        </div>
      </form>
    </Dialog>
  )
}
