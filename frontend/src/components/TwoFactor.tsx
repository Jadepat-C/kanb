import { useQueryClient } from '@tanstack/react-query'
import { Copy, Download, ShieldCheck, Smartphone } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api'
import { errorText } from '../lib/i18n'
import type { User } from '../lib/types'
import { toast, toastError, toastSuccess } from './toast'
import { Button, Dialog, Field, Input } from './ui'
import { copyText } from '../lib/clipboard'

/** Profile section: turn the authenticator app on/off, switch phones, new recovery codes. */
export function TwoFactorSection({ me }: { me: User }) {
  const { t } = useTranslation()
  const [dialog, setDialog] = useState<'setup' | 'disable' | 'codes' | null>(null)
  return (
    <section className="space-y-3 rounded-xl border border-line bg-surface p-5">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">{t('twofa.title')}</h2>
        {me.totp_enabled ? (
          <span className="flex items-center gap-1 rounded bg-green-500/15 px-1.5 py-px text-xs font-medium text-green-700 dark:text-green-400">
            <ShieldCheck size={12} /> {t('twofa.on')}
          </span>
        ) : (
          <span className="rounded bg-black/5 px-1.5 py-px text-xs text-muted dark:bg-white/10">{t('twofa.off')}</span>
        )}
      </div>
      <p className="text-sm text-muted">{me.totp_enabled ? t('twofa.onHint') : t('twofa.offHint')}</p>
      {me.require_2fa && <p className="text-xs text-muted">{t('twofa.requiredNote')}</p>}
      <div className="flex flex-wrap gap-2">
        {me.totp_enabled ? (
          <>
            <Button onClick={() => setDialog('setup')}>
              <Smartphone size={14} /> {t('twofa.changeDevice')}
            </Button>
            <Button onClick={() => setDialog('codes')}>{t('twofa.newCodes')}</Button>
            {/* while an admin requires it, it can't be turned off */}
            {!me.require_2fa && (
              <Button variant="danger" onClick={() => setDialog('disable')}>
                {t('twofa.turnOff')}
              </Button>
            )}
          </>
        ) : (
          <Button variant="primary" onClick={() => setDialog('setup')}>
            <ShieldCheck size={14} /> {t('twofa.turnOn')}
          </Button>
        )}
      </div>
      {dialog === 'setup' && <SetupDialog me={me} onClose={() => setDialog(null)} />}
      {(dialog === 'disable' || dialog === 'codes') && <PasswordDialog mode={dialog} onClose={() => setDialog(null)} />}
    </section>
  )
}

/**
 * `holdMe`: leave the cached /me alone until the dialog closes. On the forced-setup screen, marking 2FA as on right
 * away would let the app in at once and take the recovery codes off the screen before they're saved.
 */
export function SetupDialog({ me, onClose, holdMe }: { me: User; onClose: () => void; holdMe?: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [setup, setSetup] = useState<{ qr_svg: string; secret: string } | null>(null)
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [codes, setCodes] = useState<string[] | null>(null)
  // when switching phones the password is asked first; a fresh setup starts right away
  const needPassword = me.totp_enabled
  const start = () => api.post<{ qr_svg: string; secret: string }>('/me/2fa/setup').then(setSetup, toastError)
  const started = useRef(false)
  useEffect(() => {
    if (needPassword || started.current) return
    started.current = true
    start()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const confirm = async () => {
    setBusy(true)
    setErr('')
    try {
      const r = await api.post<{ recovery_codes: string[] }>('/me/2fa/enable', { code, password: needPassword ? password : undefined })
      setCodes(r.recovery_codes)
      if (!holdMe) qc.setQueryData<User>(['me'], (u) => u && { ...u, totp_enabled: true })
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  if (codes) return <RecoveryCodes codes={codes} onClose={onClose} title={t('twofa.enabledTitle')} />
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={me.totp_enabled ? t('twofa.changeDevice') : t('twofa.turnOn')}>
      <form
        className="space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (!setup) start()
          else confirm()
        }}
      >
        {!setup ? (
          <>
            <p className="text-sm text-muted">{t('twofa.passwordFirst')}</p>
            <Field label={t('auth.password')}>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus required autoComplete="current-password" />
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" disabled={!password}>
                {t('common.next')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              <li>{t('twofa.step1')}</li>
              <li>{t('twofa.step2')}</li>
              <li>{t('twofa.step3')}</li>
            </ol>
            <div className="flex flex-col items-center gap-2">
              <img
                src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(setup.qr_svg)}`}
                alt="QR"
                className="h-48 w-48 rounded-lg bg-white p-1"
              />
              <div className="text-center text-xs text-muted">
                {t('twofa.cantScan')}
                <code className="mt-1 block select-all rounded bg-black/5 px-2 py-1 font-mono text-sm tracking-wider text-[var(--text)] dark:bg-white/10">{setup.secret}</code>
              </div>
            </div>
            <Field label={t('twofa.code')}>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                className="text-center font-mono text-lg tracking-[0.4em]"
                autoFocus
              />
            </Field>
            {err && <p className="text-sm text-red-600">{err}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" disabled={busy || code.length !== 6}>
                {t('twofa.confirm')}
              </Button>
            </div>
          </>
        )}
      </form>
    </Dialog>
  )
}

function PasswordDialog({ mode, onClose }: { mode: 'disable' | 'codes'; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const submit = async () => {
    setErr('')
    try {
      if (mode === 'disable') {
        await api.post('/me/2fa/disable', { password })
        qc.setQueryData<User>(['me'], (u) => u && { ...u, totp_enabled: false })
        toastSuccess(t('twofa.turnedOff'))
        onClose()
      } else {
        const r = await api.post<{ recovery_codes: string[] }>('/me/2fa/recovery', { password })
        setCodes(r.recovery_codes)
      }
    } catch (e) {
      setErr(errorText(e))
    }
  }
  if (codes) return <RecoveryCodes codes={codes} onClose={onClose} title={t('twofa.newCodes')} />
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={mode === 'disable' ? t('twofa.turnOff') : t('twofa.newCodes')}>
      <form
        className="space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <p className="text-sm text-muted">{mode === 'disable' ? t('twofa.turnOffHint') : t('twofa.newCodesHint')}</p>
        <Field label={t('auth.password')}>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus required autoComplete="current-password" />
        </Field>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant={mode === 'disable' ? 'danger' : 'primary'} disabled={!password}>
            {mode === 'disable' ? t('twofa.turnOff') : t('twofa.generate')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

/** Shown once: the user must save these somewhere safe. */
function RecoveryCodes({ codes, title, onClose }: { codes: string[]; title: string; onClose: () => void }) {
  const { t } = useTranslation()
  const [saved, setSaved] = useState(false)
  const text = codes.join('\n')
  return (
    <Dialog open onOpenChange={(o) => !o && saved && onClose()} title={title}>
      <div className="space-y-4 p-5">
        <p className="text-sm">{t('twofa.codesHint')}</p>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg border border-line bg-black/[0.03] p-4 font-mono text-sm dark:bg-white/5">
          {codes.map((c) => (
            <span key={c} className="select-all text-center">
              {c}
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => copyText(text).then((ok) => (ok ? (setSaved(true), toastSuccess(t('common.copied'))) : toast(t('common.copyManually'))))}>
            <Copy size={14} /> {t('common.copy')}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              const a = document.createElement('a')
              a.href = URL.createObjectURL(new Blob([`${t('twofa.fileHeader')}\n\n${text}\n`], { type: 'text/plain' }))
              a.download = 'kanban-recovery-codes.txt'
              a.click()
              URL.revokeObjectURL(a.href)
              setSaved(true)
            }}
          >
            <Download size={14} /> {t('common.download')}
          </Button>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="accent-[var(--color-accent)]" />
          {t('twofa.savedThem')}
        </label>
        <div className="flex justify-end">
          <Button variant="primary" disabled={!saved} onClick={onClose}>
            {t('common.done')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
