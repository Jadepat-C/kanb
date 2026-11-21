import { useQueryClient } from '@tanstack/react-query'
import { Languages, Moon, Sun } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { Button, Field, Input } from '../components/ui'
import { api } from '../lib/api'
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

  if (me) return <Navigate to="/" replace />
  const from = (loc.state as { from?: string } | null)?.from ?? '/'

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const u = await api.post<User>('/auth/login', { username, password })
      qc.setQueryData(['me'], u)
      nav(from, { replace: true })
    } catch (e) {
      setErr(errorText(e))
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
        <p className="text-center text-xs text-muted">{t('auth.noSignup')}</p>
      </form>
    </div>
  )
}
