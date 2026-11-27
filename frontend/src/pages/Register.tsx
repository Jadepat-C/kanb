/** Self sign-up (only when the server runs with ALLOW_SIGNUP=true), and the email confirmation link. */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Clock, MailCheck } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router'
import { Button, Field, Input, PasswordInput, Spinner } from '../components/ui'
import { api } from '../lib/api'
import { useMe } from '../lib/auth'
import { errorText } from '../lib/i18n'
import { AuthCard } from './AuthPages'
import { SsoButtons, type SsoInfo } from './Sso'

type Outcome = 'confirm_email' | 'review' | 'active'

/** What happens next after signing up or confirming the email. */
function Next({ outcome }: { outcome: 'confirm_email' | 'review' }) {
  const { t } = useTranslation()
  const Icon = outcome === 'confirm_email' ? MailCheck : Clock
  return (
    <div className="space-y-3 text-center">
      <Icon size={30} className="mx-auto text-accent" />
      <p className="text-sm">{t(outcome === 'confirm_email' ? 'signup.checkEmail' : 'signup.waiting')}</p>
      <Link to="/login" className="block text-sm text-accent hover:underline">
        {t('auth.backToSignIn')}
      </Link>
    </div>
  )
}

export function Register() {
  const { t, i18n } = useTranslation()
  const { data: me } = useMe()
  const qc = useQueryClient()
  const nav = useNavigate()
  const options = useQuery({ queryKey: ['auth-options'], queryFn: () => api.get<{ signup?: boolean; sso?: SsoInfo }>('/auth/options') })
  const [f, setF] = useState({ username: '', display_name: '', email: '', password: '', confirm: '', website: '' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<Outcome | null>(null)
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value })
  const mismatch = f.confirm.length > 0 && f.password !== f.confirm
  const sso = options.data?.sso ?? null

  if (me) return <Navigate to="/" replace />
  if (options.isLoading)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  if (!options.data?.signup)
    return (
      <AuthCard title={t('signup.title')}>
        <p className="text-sm text-muted">{t('signup.closed')}</p>
        <Link to="/login" className="block text-center text-sm text-accent hover:underline">
          {t('auth.backToSignIn')}
        </Link>
      </AuthCard>
    )
  if (done === 'confirm_email' || done === 'review')
    return (
      <AuthCard title={t('signup.title')}>
        <Next outcome={done} />
      </AuthCard>
    )

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (f.password !== f.confirm) return
    setBusy(true)
    setErr('')
    try {
      const { confirm: _, ...body } = f
      const r = await api.post<{ status: Outcome }>('/auth/register', { ...body, locale: i18n.language === 'th' ? 'th' : 'en' })
      if (r.status === 'active') {
        await qc.invalidateQueries({ queryKey: ['me'] })
        nav('/', { replace: true })
      } else setDone(r.status)
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <AuthCard title={t('signup.title')} subtitle={t('signup.subtitle')}>
      {sso && (
        <div className="mb-4 space-y-4">
          <SsoButtons info={sso} signUp />
          {!sso.required && (
            <div className="flex items-center gap-3 text-xs text-muted">
              <span className="h-px flex-1 bg-[var(--border)]" />
              {t('sso.or')}
              <span className="h-px flex-1 bg-[var(--border)]" />
            </div>
          )}
        </div>
      )}
      {sso?.required ? (
        <p className="text-center text-sm text-muted">
          {t('signup.haveAccount')}{' '}
          <Link to="/login" className="text-accent hover:underline">
            {t('auth.signIn')}
          </Link>
        </p>
      ) : (
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('auth.username')} hint={t('errors.invalid_username')}>
          <Input value={f.username} onChange={set('username')} autoComplete="username" autoFocus required minLength={2} maxLength={40} />
        </Field>
        <Field label={t('admin.displayName')}>
          <Input value={f.display_name} onChange={set('display_name')} autoComplete="name" />
        </Field>
        <Field label={t('admin.email')}>
          <Input type="email" value={f.email} onChange={set('email')} autoComplete="email" required />
        </Field>
        <Field label={t('auth.password')} hint={t('errors.password_too_short')}>
          <PasswordInput value={f.password} onChange={set('password')} autoComplete="new-password" minLength={8} required />
        </Field>
        <Field label={t('auth.confirmPassword')}>
          <PasswordInput value={f.confirm} onChange={set('confirm')} autoComplete="new-password" minLength={8} required />
        </Field>
        {/* left empty by people; bots that fill every field are ignored */}
        <input
          type="text"
          name="website"
          value={f.website}
          onChange={set('website')}
          tabIndex={-1}
          autoComplete="off"
          aria-hidden
          className="absolute -left-[9999px] h-px w-px opacity-0"
        />
        {mismatch && <p className="text-sm text-red-600">{t('auth.passwordsDiffer')}</p>}
        {err && <p className="text-sm text-red-600">{err}</p>}
        <Button variant="primary" className="w-full" disabled={busy || mismatch}>
          {t('signup.create')}
        </Button>
        <p className="text-center text-sm text-muted">
          {t('signup.haveAccount')}{' '}
          <Link to="/login" className="text-accent hover:underline">
            {t('auth.signIn')}
          </Link>
        </p>
      </form>
      )}
    </AuthCard>
  )
}

/** /confirm-email?token=… from the confirmation email. */
export function ConfirmEmail() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const nav = useNavigate()
  const [sp] = useSearchParams()
  const token = sp.get('token') ?? ''
  const [state, setState] = useState<'busy' | 'review' | 'bad'>('busy')
  const [err, setErr] = useState('')
  const sent = useRef(false)
  useEffect(() => {
    // once only (React's development double-run would use the one-time link twice)
    if (sent.current) return
    sent.current = true
    api.post<{ status: Outcome }>('/auth/confirm', { token }).then(
      async (r) => {
        if (r.status === 'active') {
          await qc.invalidateQueries({ queryKey: ['me'] })
          nav('/', { replace: true })
        } else setState('review')
      },
      (e) => {
        setErr(errorText(e))
        setState('bad')
      },
    )
  }, [token, qc, nav])
  return (
    <AuthCard title={t('signup.confirmTitle')}>
      {state === 'busy' && (
        <div className="flex justify-center py-4">
          <Spinner />
        </div>
      )}
      {state === 'review' && <Next outcome="review" />}
      {state === 'bad' && (
        <div className="space-y-3">
          <p className="text-sm text-red-600">{err}</p>
          <p className="text-sm text-muted">{t('signup.linkBad')}</p>
          <Link to="/register" className="block text-center text-sm text-accent hover:underline">
            {t('signup.again')}
          </Link>
        </div>
      )}
    </AuthCard>
  )
}
