import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Languages, Moon, Sun } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useLocation, useNavigate } from 'react-router'
import { Button, Field, Input, PasswordInput } from '../components/ui'
import { ApiError, api } from '../lib/api'
import { useMe } from '../lib/auth'
import { errorText, setLocale } from '../lib/i18n'
import { isDark, setTheme } from '../lib/prefs'
import type { User } from '../lib/types'
import { SsoButton, useSsoError, type SsoInfo } from './Sso'

export function Login() {
  const { t, i18n } = useTranslation()
  const { data: me } = useMe()
  const qc = useQueryClient()
  const nav = useNavigate()
  const loc = useLocation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [, force] = useState(0)
  // step 2 when the account uses an authenticator app
  const [ticket, setTicket] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [useRecovery, setUseRecovery] = useState(false)
  const options = useQuery({
    queryKey: ['auth-options'],
    queryFn: () => api.get<{ email_enabled: boolean; needs_setup?: boolean; signup?: boolean; sso?: SsoInfo }>('/auth/options'),
  })
  const sso = options.data?.sso ?? null
  const ssoErr = useSsoError(sso?.label)
  // single sign-on required: the password form is only for super admins, behind a link
  const [passwordOpen, setPasswordOpen] = useState(false)
  const showPassword = !sso?.required || passwordOpen

  if (me) return <Navigate to="/" replace />
  const from = (loc.state as { from?: string } | null)?.from ?? '/'

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const r = ticket
        ? await api.post<User>('/auth/login/code', { ticket, code })
        : await api.post<User | { totp_required: true; ticket: string }>('/auth/login', { username, password })
      if ('totp_required' in r) {
        setTicket(r.ticket)
        setCode('')
        return
      }
      qc.setQueryData(['me'], r)
      nav(from, { replace: true })
    } catch (e) {
      setErr(errorText(e))
      // the code step expired (5 minutes / 5 tries): back to the password
      if (ticket && e instanceof ApiError && e.code === 'totp_expired') {
        setTicket(null)
        setPassword('')
      }
    } finally {
      setBusy(false)
    }
  }

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
      {options.data?.needs_setup ? (
        <FirstRun />
      ) : (
        <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border border-line bg-surface p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <img src="/favicon.svg" alt="" className="h-9 w-9" />
            <div>
              <h1 className="text-lg font-semibold">{t('app.name')}</h1>
              <p className="text-sm text-muted">{t('auth.welcome')}</p>
            </div>
          </div>
          {ticket ? (
            <>
              <p className="text-sm">{useRecovery ? t('twofa.loginRecoveryHint') : t('twofa.loginHint')}</p>
              <Field label={useRecovery ? t('twofa.recoveryCode') : t('twofa.code')}>
                {useRecovery ? (
                  <Input
                    key="rc"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    autoFocus
                    autoComplete="off"
                    placeholder="xxxx-xxxx"
                    className="font-mono"
                    required
                  />
                ) : (
                  <Input
                    key="otp"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    placeholder="123456"
                    className="text-center font-mono text-lg tracking-[0.4em]"
                    required
                  />
                )}
              </Field>
              {err && <p className="text-sm text-red-600">{err}</p>}
              <Button variant="primary" className="w-full" disabled={busy || (!useRecovery && code.length !== 6)}>
                {t('twofa.verify')}
              </Button>
              <div className="flex justify-between text-sm">
                <button
                  type="button"
                  className="text-accent hover:underline cursor-pointer"
                  onClick={() => (setUseRecovery(!useRecovery), setCode(''), setErr(''))}
                >
                  {useRecovery ? t('twofa.useApp') : t('twofa.useRecovery')}
                </button>
                <button
                  type="button"
                  className="text-muted hover:underline cursor-pointer"
                  onClick={() => (setTicket(null), setPassword(''), setErr(''), setUseRecovery(false))}
                >
                  {t('common.back')}
                </button>
              </div>
              <p className="text-xs text-muted">{t('twofa.lostPhone')}</p>
            </>
          ) : (
            <>
              {ssoErr && <p className="rounded-md bg-red-500/10 p-2.5 text-sm text-red-700 dark:text-red-400">{ssoErr}</p>}
              {sso && (
                <>
                  <SsoButton info={sso} />
                  {sso.required ? (
                    <>
                      <p className="text-center text-xs text-muted">{t('sso.requiredHint')}</p>
                      {!passwordOpen && (
                        <button type="button" className="block w-full text-center text-xs text-muted hover:underline cursor-pointer" onClick={() => setPasswordOpen(true)}>
                          {t('sso.passwordToggle')}
                        </button>
                      )}
                    </>
                  ) : (
                    <div className="flex items-center gap-3 text-xs text-muted">
                      <span className="h-px flex-1 bg-[var(--border)]" />
                      {t('sso.or')}
                      <span className="h-px flex-1 bg-[var(--border)]" />
                    </div>
                  )}
                </>
              )}
              {showPassword && (
                <>
                  <Field label={t('auth.usernameOrEmail')}>
                    <Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus={!sso || passwordOpen} autoComplete="username" required />
                  </Field>
                  <Field label={t('auth.password')}>
                    <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
                  </Field>
                  {err && <p className="text-sm text-red-600">{err}</p>}
                  <Button variant="primary" className="w-full" disabled={busy}>
                    {t('auth.signIn')}
                  </Button>
                </>
              )}
            </>
          )}
          {!ticket && showPassword && options.data?.email_enabled && (
            <Link to="/forgot-password" className="block text-center text-sm text-accent hover:underline">
              {t('auth.forgot')}
            </Link>
          )}
          {options.data?.signup && sso?.required ? (
            <p className="text-center text-xs text-muted">{t('sso.signupHint', { label: sso.label })}</p>
          ) : options.data?.signup ? (
            <p className="text-center text-sm text-muted">
              {t('signup.noAccount')}{' '}
              <Link to="/register" className="text-accent hover:underline">
                {t('signup.create')}
              </Link>
            </p>
          ) : (
            <p className="text-center text-xs text-muted">{t('auth.noSignup')}</p>
          )}
        </form>
      )}
    </div>
  )
}

/** A brand-new server: create the first admin here instead of on the command line. */
function FirstRun() {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const nav = useNavigate()
  const [f, setF] = useState({ code: '', username: '', display_name: '', password: '', confirm: '' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value })
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (f.password !== f.confirm) return setErr(t('setup.mismatch'))
    setBusy(true)
    setErr('')
    try {
      const { confirm: _, ...body } = f
      const user = await api.post<User>('/auth/setup', { ...body, locale: i18n.language === 'th' ? 'th' : 'en' })
      qc.setQueryData(['me'], user)
      qc.invalidateQueries({ queryKey: ['auth-options'] })
      nav('/', { replace: true })
    } catch (e) {
      setErr(errorText(e))
      if (e instanceof ApiError && e.code === 'already_set_up') qc.invalidateQueries({ queryKey: ['auth-options'] })
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border border-line bg-surface p-6 shadow-sm">
      <div className="flex items-center gap-3">
        <img src="/favicon.svg" alt="" className="h-9 w-9" />
        <div>
          <h1 className="text-lg font-semibold">{t('setup.title')}</h1>
          <p className="text-sm text-muted">{t('setup.hint')}</p>
        </div>
      </div>
      <Field label={t('setup.code')} hint={t('setup.codeHint')}>
        <Input value={f.code} onChange={set('code')} autoFocus autoComplete="off" spellCheck={false} placeholder="XXXX-XXXX" className="font-mono" required />
      </Field>
      <Field label={t('auth.username')}>
        <Input value={f.username} onChange={set('username')} autoComplete="username" required />
      </Field>
      <Field label={t('admin.displayName')}>
        <Input value={f.display_name} onChange={set('display_name')} autoComplete="name" />
      </Field>
      <Field label={t('auth.password')} hint={t('errors.password_too_short')}>
        <PasswordInput value={f.password} onChange={set('password')} autoComplete="new-password" minLength={8} required />
      </Field>
      <Field label={t('setup.confirm')}>
        <PasswordInput value={f.confirm} onChange={set('confirm')} autoComplete="new-password" minLength={8} required />
      </Field>
      {err && <p className="text-sm text-red-600">{err}</p>}
      <Button variant="primary" className="w-full" disabled={busy}>
        {t('setup.create')}
      </Button>
    </form>
  )
}
