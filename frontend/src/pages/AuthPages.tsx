import { useQueryClient } from '@tanstack/react-query'
import { KeyRound, Languages, MailCheck, Moon, ShieldCheck, Sun } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { toastSuccess } from '../components/toast'
import { SetupDialog } from '../components/TwoFactor'
import { Button, Field, Input, Spinner } from '../components/ui'
import { api } from '../lib/api'
import { errorText, setLocale } from '../lib/i18n'
import { isDark, setTheme } from '../lib/prefs'
import type { User } from '../lib/types'

/** Centered card with language/theme toggles, shared by the sign-in related pages. */
export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  const { i18n } = useTranslation()
  const [, force] = useState(0)
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="absolute right-4 top-4 flex gap-1">
        <Button variant="ghost" size="sm" onClick={() => setLocale(i18n.language === 'th' ? 'en' : 'th')}>
          <Languages size={15} /> {i18n.language === 'th' ? 'ไทย' : 'EN'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setTheme(isDark() ? 'light' : 'dark')
            force((x) => x + 1)
          }}
        >
          {isDark() ? <Sun size={15} /> : <Moon size={15} />}
        </Button>
      </div>
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-line bg-surface p-6 shadow-sm">
        <div className="flex items-center gap-3">
          <img src="/favicon.svg" alt="" className="h-9 w-9" />
          <div>
            <h1 className="text-lg font-semibold">{title}</h1>
            {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
          </div>
        </div>
        {children}
      </div>
    </div>
  )
}

function NewPasswordFields({ onSubmit, busy, submitLabel }: { onSubmit: (pw: string) => void; busy: boolean; submitLabel: string }) {
  const { t } = useTranslation()
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const mismatch = pw2.length > 0 && pw !== pw2
  return (
    <form
      className="space-y-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault()
        if (pw === pw2) onSubmit(pw)
      }}
    >
      <Field label={t('profile.newPassword')} hint={t('errors.password_too_short')}>
        <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} minLength={8} required autoFocus autoComplete="new-password" />
      </Field>
      <Field label={t('auth.confirmPassword')}>
        <Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} minLength={8} required autoComplete="new-password" />
      </Field>
      {mismatch && <p className="text-sm text-red-600">{t('auth.passwordsDiffer')}</p>}
      <Button variant="primary" className="w-full" disabled={busy || mismatch || pw.length < 8}>
        {submitLabel}
      </Button>
    </form>
  )
}

/** Shown instead of the app until an admin-set password has been replaced. */
export function ForceChangePassword({ me }: { me: User }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  return (
    <AuthCard title={t('auth.chooseNewPassword')} subtitle={t('auth.forcedHint', { name: me.display_name })}>
      <NewPasswordFields
        busy={busy}
        submitLabel={t('auth.savePassword')}
        onSubmit={async (pw) => {
          setBusy(true)
          setErr('')
          try {
            await api.post('/me/password', { new_password: pw })
            await qc.invalidateQueries({ queryKey: ['me'] })
            toastSuccess(t('profile.passwordChanged'))
          } catch (e) {
            setErr(errorText(e))
          } finally {
            setBusy(false)
          }
        }}
      />
      {err && <p className="text-sm text-red-600">{err}</p>}
      <button
        className="w-full text-center text-xs text-muted hover:underline cursor-pointer"
        onClick={async () => {
          await api.post('/auth/logout')
          qc.setQueryData(['me'], null)
        }}
      >
        {t('auth.signOut')}
      </button>
    </AuthCard>
  )
}

/** Shown instead of the app while an admin requires two-factor sign-in and this account hasn't set it up. */
export function ForceTwoFactor({ me }: { me: User }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  return (
    <AuthCard title={t('twofa.requiredTitle')} subtitle={t('twofa.requiredHint', { name: me.display_name })}>
      <Button variant="primary" className="w-full" onClick={() => setOpen(true)}>
        <ShieldCheck size={15} /> {t('twofa.setUpNow')}
      </Button>
      {open && (
        <SetupDialog
          me={me}
          holdMe
          // after the recovery codes have been shown: reload /me, which lets the app in
          onClose={() => (setOpen(false), qc.invalidateQueries({ queryKey: ['me'] }))}
        />
      )}
      <button
        className="w-full text-center text-xs text-muted hover:underline cursor-pointer"
        onClick={async () => {
          await api.post('/auth/logout')
          qc.setQueryData(['me'], null)
        }}
      >
        {t('auth.signOut')}
      </button>
    </AuthCard>
  )
}

export function ForgotPassword() {
  const { t } = useTranslation()
  const [login, setLogin] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  return (
    <AuthCard title={t('auth.forgotTitle')} subtitle={sent ? undefined : t('auth.forgotHint')}>
      {sent ? (
        <div className="space-y-3 text-sm">
          <p className="flex gap-2">
            <MailCheck size={18} className="shrink-0 text-green-600" />
            {t('auth.forgotSent')}
          </p>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            setErr('')
            try {
              await api.post('/auth/forgot', { login })
              setSent(true)
            } catch (e) {
              setErr(errorText(e))
            } finally {
              setBusy(false)
            }
          }}
        >
          <Field label={t('auth.usernameOrEmail')}>
            <Input value={login} onChange={(e) => setLogin(e.target.value)} required autoFocus autoComplete="username" />
          </Field>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <Button variant="primary" className="w-full" disabled={busy}>
            {t('auth.sendLink')}
          </Button>
        </form>
      )}
      <Link to="/login" className="block text-center text-xs text-muted hover:underline">
        ← {t('auth.backToSignIn')}
      </Link>
    </AuthCard>
  )
}

/** Opened from the welcome ("set your password") or forgot-password email. */
export function ResetPassword() {
  const { t } = useTranslation()
  const nav = useNavigate()
  const [sp] = useSearchParams()
  const token = sp.get('token') ?? ''
  const [info, setInfo] = useState<{ valid: boolean; username?: string; purpose?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => {
    api
      .post<{ valid: boolean; username?: string; purpose?: string }>('/auth/reset/check', { token })
      .then(setInfo, () => setInfo({ valid: false }))
  }, [token])

  if (!info)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  if (!info.valid)
    return (
      <AuthCard title={t('auth.linkInvalidTitle')}>
        <p className="text-sm text-muted">{t('auth.linkInvalid')}</p>
        <Link to="/forgot-password" className="block text-center text-sm text-accent hover:underline">
          {t('auth.requestNewLink')}
        </Link>
      </AuthCard>
    )
  return (
    <AuthCard
      title={info.purpose === 'invite' ? t('auth.welcomeSetPassword') : t('auth.chooseNewPassword')}
      subtitle={t('auth.forAccount', { username: info.username })}
    >
      <NewPasswordFields
        busy={busy}
        submitLabel={t('auth.savePassword')}
        onSubmit={async (password) => {
          setBusy(true)
          setErr('')
          try {
            await api.post('/auth/reset', { token, password })
            toastSuccess(t('auth.passwordSet'))
            nav('/login', { replace: true })
          } catch (e) {
            setErr(errorText(e))
          } finally {
            setBusy(false)
          }
        }}
      />
      {err && (
        <p className="flex items-center gap-1.5 text-sm text-red-600">
          <KeyRound size={14} /> {err}
        </p>
      )}
    </AuthCard>
  )
}
