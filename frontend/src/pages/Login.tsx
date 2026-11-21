import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Languages, Moon, Sun } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useLocation, useNavigate } from 'react-router'
import { Button, Field, Input } from '../components/ui'
import { ApiError, api } from '../lib/api'
import { useMe } from '../lib/auth'
import { errorText, setLocale } from '../lib/i18n'
import { isDark, setTheme } from '../lib/prefs'
import type { User } from '../lib/types'

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
  const options = useQuery({ queryKey: ['auth-options'], queryFn: () => api.get<{ email_enabled: boolean }>('/auth/options') })

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
                <Input key="rc" value={code} onChange={(e) => setCode(e.target.value)} autoFocus autoComplete="off" placeholder="xxxx-xxxx" className="font-mono" required />
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
              <button type="button" className="text-accent hover:underline cursor-pointer" onClick={() => (setUseRecovery(!useRecovery), setCode(''), setErr(''))}>
                {useRecovery ? t('twofa.useApp') : t('twofa.useRecovery')}
              </button>
              <button type="button" className="text-muted hover:underline cursor-pointer" onClick={() => (setTicket(null), setPassword(''), setErr(''), setUseRecovery(false))}>
                {t('common.back')}
              </button>
            </div>
            <p className="text-xs text-muted">{t('twofa.lostPhone')}</p>
          </>
        ) : (
          <>
            <Field label={t('auth.usernameOrEmail')}>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" required />
            </Field>
            <Field label={t('auth.password')}>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            </Field>
            {err && <p className="text-sm text-red-600">{err}</p>}
            <Button variant="primary" className="w-full" disabled={busy}>
              {t('auth.signIn')}
            </Button>
          </>
        )}
        {!ticket && options.data?.email_enabled && (
          <Link to="/forgot-password" className="block text-center text-sm text-accent hover:underline">
            {t('auth.forgot')}
          </Link>
        )}
        <p className="text-center text-xs text-muted">{t('auth.noSignup')}</p>
      </form>
    </div>
  )
}
