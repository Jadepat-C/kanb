/** Single sign-on (OpenID Connect): the "Sign in with …" button, Admin → Single sign-on, and Profile → Security. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Copy, KeyRound, Link2, Unlink } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { ask } from '../components/dialogs'
import { toastError, toastSuccess } from '../components/toast'
import { Button, Field, Input, Spinner, Toggle } from '../components/ui'
import { api } from '../lib/api'
import { copyText } from '../lib/clipboard'
import { fmtDate } from '../lib/prefs'

/** `/auth/options` → sso: the button, or null when single sign-on is off. */
export type SsoInfo = { label: string; required: boolean } | null

/** A full-page navigation (not fetch): the browser goes to the provider and comes back signed in. */
export function SsoButton({ info, signUp }: { info: NonNullable<SsoInfo>; signUp?: boolean }) {
  const { t } = useTranslation()
  return (
    <a
      href="/api/auth/sso/start"
      className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-line bg-surface text-sm font-medium hover:bg-[var(--surface-2)]"
    >
      <KeyRound size={16} />
      {t(signUp ? 'sso.signUp' : 'sso.signIn', { label: info.label })}
    </a>
  )
}

/** The reason in `?sso_error=` after the provider sent the browser back, in words. */
export function useSsoError(label?: string): string {
  const { t } = useTranslation()
  const [sp] = useSearchParams()
  const code = sp.get('sso_error')
  if (!code) return ''
  const key = `sso.err.${code}`
  return t(key, { label: label ?? 'SSO', defaultValue: t('sso.err.sso_failed') })
}

// ---------- Admin → Single sign-on ----------

type AdminView = {
  enabled: boolean
  issuer: string
  client_id: string
  label: string
  allowed_domains: string[]
  trust_email: boolean
  require_sso: boolean
  has_secret: boolean
  redirect_uri: string
  signup: boolean
  connected: number
  stranded: number
}

export function SsoAdminTab() {
  const q = useQuery({ queryKey: ['admin-sso'], queryFn: () => api.get<AdminView>('/admin/sso') })
  if (!q.data) return <Spinner />
  return <SsoAdminForm initial={q.data} />
}

function SsoAdminForm({ initial }: { initial: AdminView }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [f, setF] = useState(initial)
  const [secret, setSecret] = useState('')
  const [domains, setDomains] = useState(initial.allowed_domains.join(', '))
  const [check, setCheck] = useState<{ ok: boolean; error?: string; issuer?: string } | null>(null)
  useEffect(() => setF(initial), [initial])
  const set = (p: Partial<AdminView>) => setF({ ...f, ...p })
  const body = () => ({
    enabled: f.enabled,
    issuer: f.issuer,
    client_id: f.client_id,
    client_secret: secret || undefined, // left empty = keep the stored secret
    label: f.label,
    allowed_domains: domains.split(/[,\s]+/).filter(Boolean),
    trust_email: f.trust_email,
    require_sso: f.require_sso,
  })
  const save = useMutation({
    mutationFn: () => api.put<AdminView>('/admin/sso', body()),
    onSuccess: (v) => {
      setSecret('')
      qc.setQueryData(['admin-sso'], v)
      qc.invalidateQueries({ queryKey: ['auth-options'] })
      toastSuccess(t('common.saved'))
    },
    onError: toastError,
  })
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; error?: string; issuer?: string }>('/admin/sso/test', body()),
    onSuccess: setCheck,
    onError: toastError,
  })
  const submit = async () => {
    // a site-wide sign-in rule that signs people out: confirm when it's being turned on
    if (f.enabled && f.require_sso && !(initial.enabled && initial.require_sso)) {
      const stranded = initial.stranded > 0 ? ' ' + t('sso.stranded', { count: initial.stranded }) : ''
      const ok = await ask({ title: t('sso.requireConfirmTitle'), message: t('sso.requireConfirm') + stranded, confirmLabel: t('sso.require'), danger: true })
      if (!ok) return
    }
    save.mutate()
  }
  return (
    <div className="max-w-2xl space-y-6">
      <p className="text-sm text-muted">{t('sso.adminHint')}</p>
      <form
        className="space-y-4 rounded-xl border border-line bg-surface p-5"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <label className="flex items-center gap-2 text-sm font-medium">
          <Toggle checked={f.enabled} onChange={(v) => set({ enabled: v })} />
          {t('sso.enabled')}
        </label>
        <Field label={t('sso.redirect')} hint={t('sso.redirectHint')}>
          <div className="flex gap-2">
            <Input value={f.redirect_uri} readOnly className="font-mono text-xs" onFocus={(e) => e.target.select()} />
            <Button
              type="button"
              className="shrink-0"
              onClick={async () => {
                if (await copyText(f.redirect_uri)) toastSuccess(t('common.copied'))
              }}
            >
              <Copy size={14} /> {t('common.copy')}
            </Button>
          </div>
        </Field>
        <Field label={t('sso.issuer')} hint={t('sso.issuerHint')}>
          <Input value={f.issuer} onChange={(e) => set({ issuer: e.target.value })} placeholder="https://accounts.google.com" spellCheck={false} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('sso.clientId')}>
            <Input value={f.client_id} onChange={(e) => set({ client_id: e.target.value })} autoComplete="off" spellCheck={false} />
          </Field>
          <Field label={t('sso.clientSecret')} hint={f.has_secret ? t('sso.secretKept') : undefined}>
            <Input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              autoComplete="new-password"
              placeholder={f.has_secret ? '••••••••' : ''}
            />
          </Field>
        </div>
        <Field label={t('sso.label')} hint={t('sso.labelHint')}>
          <Input value={f.label} onChange={(e) => set({ label: e.target.value })} placeholder="Google" maxLength={40} />
        </Field>

        <div className="space-y-1 rounded-md bg-[var(--surface-2)] p-3 text-sm">
          <p className="font-medium">{t('sso.who')}</p>
          <p className="text-muted">{t(f.signup ? 'sso.whoSignup' : 'sso.whoNoSignup')}</p>
        </div>
        {f.signup && (
          <Field label={t('sso.domains')} hint={t('sso.domainsHint')}>
            <Input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="example.com" spellCheck={false} />
          </Field>
        )}
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={f.trust_email} onChange={(e) => set({ trust_email: e.target.checked })} />
          <span>
            {t('sso.trustEmail')}
            <span className="block text-xs text-muted">{t('sso.trustEmailHint')}</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={f.require_sso} disabled={!f.enabled} onChange={(e) => set({ require_sso: e.target.checked })} />
          <span>
            {t('sso.require')}
            <span className="block text-xs text-muted">{t('sso.requireHint')}</span>
          </span>
        </label>

        {check && (
          <p
            className={clsx(
              'rounded-md p-2.5 text-sm [overflow-wrap:anywhere]',
              check.ok ? 'bg-green-500/10 text-green-700 dark:text-green-400' : 'bg-red-500/10 text-red-700 dark:text-red-400',
            )}
          >
            {check.ok ? t('sso.checkOk', { issuer: check.issuer }) : check.error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={save.isPending}>
            {t('common.save')}
          </Button>
          <Button type="button" disabled={test.isPending || !f.issuer.trim()} onClick={() => (setCheck(null), test.mutate())}>
            {t('sso.check')}
          </Button>
          {initial.connected > 0 && <span className="text-xs text-muted">{t('sso.connectedCount', { count: initial.connected })}</span>}
        </div>
      </form>
    </div>
  )
}

// ---------- Profile → Security ----------

type Mine = {
  available: boolean
  label: string | null
  required: boolean
  identities: { id: string; email: string | null; created_at: string; last_used_at: string | null }[]
}

export function useMySso() {
  return useQuery({ queryKey: ['my-sso'], queryFn: () => api.get<Mine>('/me/sso') })
}

export function SsoProfileSection({ hasPassword }: { hasPassword: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [sp, setSp] = useSearchParams()
  const { data } = useMySso()
  const label = data?.label ?? 'SSO'
  // back from the provider: say how it went once, then tidy the address bar
  useEffect(() => {
    if (sp.get('sso') === 'linked') toastSuccess(t('sso.linked', { label }))
    else if (sp.get('sso_error')) toastError(new Error(t(`sso.err.${sp.get('sso_error')}`, { label, defaultValue: t('sso.err.sso_failed') })))
    else return
    const next = new URLSearchParams(sp)
    next.delete('sso')
    next.delete('sso_error')
    setSp(next, { replace: true })
  }, [sp, setSp, t, label])
  const connect = useMutation({
    mutationFn: () => api.post<{ url: string }>('/me/sso/link'),
    onSuccess: (r) => {
      window.location.href = r.url
    },
    onError: toastError,
  })
  const disconnect = useMutation({
    mutationFn: (id: string) => api.del(`/me/sso/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-sso'] }),
    onError: toastError,
  })
  if (!data || (!data.available && data.identities.length === 0)) return null
  return (
    <section className="space-y-3 rounded-lg border border-line bg-surface p-4">
      <h2 className="font-semibold">{t('sso.profileTitle')}</h2>
      {data.identities.length === 0 ? (
        <p className="text-sm text-muted">{t('sso.notConnected', { label })}</p>
      ) : (
        <ul className="space-y-2">
          {data.identities.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                <Link2 size={14} className="mr-1.5 inline text-accent" />
                {t('sso.connected', { label })}
                {i.email && <span className="text-muted"> · {i.email}</span>}
                <span className="block text-xs text-muted">{t('sso.since', { date: fmtDate(i.created_at) })}</span>
              </span>
              {!data.required && (
                <Button
                  size="sm"
                  disabled={disconnect.isPending}
                  onClick={async () => {
                    const ok = await ask({
                      title: t('sso.disconnectTitle', { label }),
                      message: hasPassword ? t('sso.disconnectMsg', { label }) : t('sso.disconnectNoPassword', { label }),
                      confirmLabel: t('sso.disconnect'),
                      danger: true,
                    })
                    if (ok) disconnect.mutate(i.id)
                  }}
                >
                  <Unlink size={14} /> {t('sso.disconnect')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {data.available && data.identities.length === 0 && (
        <Button disabled={connect.isPending} onClick={() => connect.mutate()}>
          <KeyRound size={14} /> {t('sso.connect', { label })}
        </Button>
      )}
    </section>
  )
}
