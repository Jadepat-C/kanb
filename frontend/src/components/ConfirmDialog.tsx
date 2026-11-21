import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, Input } from './ui'

/** Confirmation for destructive actions. With `typeToConfirm`, the user must type that text (e.g. the board name). */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  typeToConfirm,
  danger = true,
  onConfirm,
  onClose,
}: {
  title: string
  message: ReactNode
  confirmLabel: string
  typeToConfirm?: string
  danger?: boolean
  onConfirm: () => Promise<unknown> | void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const ok = !typeToConfirm || typed.trim() === typeToConfirm.trim()
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={title}>
      <form
        className="space-y-4 p-5"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!ok) return
          setBusy(true)
          try {
            await onConfirm()
            onClose()
          } finally {
            setBusy(false)
          }
        }}
      >
        <div className="text-sm">{message}</div>
        {typeToConfirm && (
          <label className="block space-y-1 text-sm">
            <span className="text-muted">{t('confirm.typeToConfirm', { text: typeToConfirm })}</span>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus placeholder={typeToConfirm} />
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} disabled={!ok || busy} autoFocus={!typeToConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
