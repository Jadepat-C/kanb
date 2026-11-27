/** Single sign-on (OpenID Connect): the "Sign in with …" buttons, Admin → Single sign-on (several providers), and
 * Profile → Security. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { ChevronDown, ChevronRight, Copy, KeyRound, Link2, Plus, Trash2, Unlink } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { ask } from '../components/dialogs'
import { toastError, toastSuccess } from '../components/toast'
import { Button, Field, Input, Menu, MenuContent, MenuItem, MenuTrigger, Spinner, Toggle } from '../components/ui'
import { api } from '../lib/api'
import { copyText } from '../lib/clipboard'
import { fmtDate } from '../lib/prefs'

/** `/auth/options` → sso: the buttons, or null when single sign-on is off. */
export type SsoInfo = { providers: { id: string; label: string }[]; required: boolean } | null

/** One button per provider. A full-page navigation (not fetch): the browser goes to the provider and comes back. */
export function SsoButtons({ info, signUp }: { info: NonNullable<SsoInfo>; signUp?: boolean }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-2">
      {info.providers.map((p) => (
        <a
          key={p.id}
          href={`/api/auth/sso/start?provider=${encodeURIComponent(p.id)}`}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-line bg-surface text-sm font-medium hover:bg-[var(--surface-2)]"
        >
          <KeyRound size={16} />
          {t(signUp ? 'sso.signUp' : 'sso.signIn', { label: p.label })}
        </a>
      ))}
    </div>
  )
}

/** "Google" or "Google / Microsoft", for sentences about every provider. */
export const ssoLabels = (info: NonNullable<SsoInfo>) => info.providers.map((p) => p.label).join(' / ')

/** The reason in `?sso_error=` after a provider sent the browser back, in words (naming that provider). */
export function useSsoError(info: SsoInfo | undefined): string {
  const { t } = useTranslation()
  const [sp] = useSearchParams()
  const code = sp.get('sso_error')
  if (!code) return ''
  const label = info?.providers.find((p) => p.id === sp.get('provider'))?.label ?? 'SSO'
  return t(`sso.err.${code}`, { label, defaultValue: t('sso.err.sso_failed', { label }) })
}

// ---------- Admin → Single sign-on ----------

interface Provider {
  id: string
  enabled: boolean
  issuer: string
  client_id: string
  label: string
  allowed_domains: string[]
  trust_email: boolean
  has_secret: boolean
  connected: number
  /** the server's last look at it: one issuer for every organisation (Microsoft "common") */
  multi_tenant?: boolean
}
type AdminView = {
  providers: Provider[]
  require_sso: boolean
  redirect_uri: string
  signup: boolean
  connected: number
  stranded: number
}

/** Starting points for "Add provider". */
const PRESETS = {
  google: { label: 'Google', issuer: 'https://accounts.google.com' },
  microsoftPersonal: { label: 'Microsoft', issuer: 'https://login.microsoftonline.com/consumers/v2.0' },
  microsoftOrg: { label: 'Microsoft', issuer: 'https://login.microsoftonline.com/<tenant-id>/v2.0' },
  microsoftAny: { label: 'Microsoft', issuer: 'https://login.microsoftonline.com/common/v2.0' },
  other: { label: '', issuer: '' },
} as const
type Preset = keyof typeof PRESETS

const blank = (p: Preset): Provider => ({ id: '', enabled: true, client_id: '', allowed_domains: [], trust_email: false, has_secret: false, connected: 0, ...PRESETS[p] })
const isMicrosoft = (issuer: string) => issuer.includes('login.microsoftonline.com')
const isMultiTenant = (issuer: string) => /login\.microsoftonline\.com\/(common|organizations)\b/.test(issuer)

export function SsoAdminTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['admin-sso'], queryFn: () => api.get<AdminView>('/admin/sso') })
  const [adding, setAdding] = useState<Preset | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const done = (v: AdminView) => {
    qc.setQueryData(['admin-sso'], v)
    qc.invalidateQueries({ queryKey: ['auth-options'] })
  }
  const require = useMutation({
    mutationFn: (require_sso: boolean) => api.put<AdminView>('/admin/sso', { require_sso }),
    onSuccess: (v) => (done(v), toastSuccess(t('common.saved'))),
    onError: toastError,
  })
  if (!q.data) return <Spinner />
  const v = q.data
  const anyReady = v.providers.some((p) => p.enabled && p.has_secret)
  return (
    <div className="max-w-2xl space-y-5">
      <p className="text-sm text-muted">{t('sso.adminHint')}</p>

      <section className="space-y-4 rounded-xl border border-line bg-surface p-5">
        <Field label={t('sso.redirect')} hint={t('sso.redirectHint')}>
          <div className="flex gap-2">
            <Input value={v.redirect_uri} readOnly className="font-mono text-xs" onFocus={(e) => e.target.select()} />
            <Button type="button" className="shrink-0" onClick={async () => (await copyText(v.redirect_uri)) && toastSuccess(t('common.copied'))}>
              <Copy size={14} /> {t('common.copy')}
            </Button>
          </div>
        </Field>
        <div className="space-y-1 rounded-md bg-[var(--surface-2)] p-3 text-sm">
          <p className="font-medium">{t('sso.who')}</p>
          <p className="text-muted">{t(v.signup ? 'sso.whoSignup' : 'sso.whoNoSignup')}</p>
        </div>
        <label className={clsx('flex items-start gap-2 text-sm', !anyReady && 'opacity-60')}>
          <input
            type="checkbox"
            className="mt-0.5"
            checked={v.require_sso}
            disabled={!anyReady || require.isPending}
            onChange={async (e) => {
              const on = e.target.checked
              if (on) {
                const stranded = v.stranded > 0 ? ' ' + t('sso.stranded', { count: v.stranded }) : ''
                if (!(await ask({ title: t('sso.requireConfirmTitle'), message: t('sso.requireConfirm') + stranded, confirmLabel: t('sso.require'), danger: true }))) return
              }
              require.mutate(on)
            }}
          />
          <span>
            {t('sso.require')}
            <span className="block text-xs text-muted">{t('sso.requireHint')}</span>
          </span>
        </label>
        {v.connected > 0 && <p className="text-xs text-muted">{t('sso.connectedCount', { count: v.connected })}</p>}
      </section>

      <div className="space-y-3">
        {v.providers.length === 0 && !adding && <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-muted">{t('sso.noProviders')}</p>}
        {v.providers.map((p) => (
          <ProviderCard key={p.id} p={p} signup={v.signup} open={open === p.id} onToggle={() => setOpen(open === p.id ? null : p.id)} onSaved={done} />
        ))}
        {adding && <ProviderCard p={blank(adding)} signup={v.signup} open onToggle={() => setAdding(null)} onSaved={(nv) => (done(nv), setAdding(null))} />}
      </div>
      {!adding && (
        <Menu>
          <MenuTrigger asChild>
            <Button variant="primary">
              <Plus size={15} /> {t('sso.addProvider')}
            </Button>
          </MenuTrigger>
          <MenuContent align="start">
            {(Object.keys(PRESETS) as Preset[]).map((k) => (
              <MenuItem key={k} onSelect={() => setAdding(k)}>
                <span>
                  {t(`sso.preset.${k}`)}
                  <span className="block text-xs text-muted">{t(`sso.preset.${k}Hint`)}</span>
                </span>
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      )}
    </div>
  )
}

function ProviderCard({ p, signup, open, onToggle, onSaved }: { p: Provider; signup: boolean; open: boolean; onToggle: () => void; onSaved: (v: AdminView) => void }) {
  const { t } = useTranslation()
  const isNew = !p.id
  const [f, setF] = useState(p)
  const [secret, setSecret] = useState('')
  const [domains, setDomains] = useState(p.allowed_domains.join(', '))
  const [check, setCheck] = useState<{ ok: boolean; error?: string; issuer?: string; multi_tenant?: boolean } | null>(null)
  useEffect(() => setF(p), [p])
  const set = (x: Partial<Provider>) => setF({ ...f, ...x })
  const body = () => ({
    enabled: f.enabled,
    issuer: f.issuer,
    client_id: f.client_id,
    client_secret: secret || undefined, // left empty = keep the stored secret
    label: f.label,
    allowed_domains: domains.split(/[,\s]+/).filter(Boolean),
    trust_email: f.trust_email && !isMultiTenant(f.issuer) && !(f.issuer === p.issuer && p.multi_tenant),
  })
  const save = useMutation({
    mutationFn: () => (isNew ? api.post<AdminView>('/admin/sso/providers', body()) : api.put<AdminView>(`/admin/sso/providers/${p.id}`, body())),
    onSuccess: (v) => (setSecret(''), onSaved(v), toastSuccess(t('common.saved'))),
    onError: toastError,
  })
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; error?: string; issuer?: string; multi_tenant?: boolean }>('/admin/sso/test', body()),
    onSuccess: setCheck,
    onError: toastError,
  })
  const remove = useMutation({
    mutationFn: () => api.del<AdminView>(`/admin/sso/providers/${p.id}`),
    onSuccess: (v) => (onSaved(v), toastSuccess(t('sso.removed', { label: p.label || 'SSO' }))),
    onError: toastError,
  })
  const ms = isMicrosoft(f.issuer)
  const multi = isMultiTenant(f.issuer) || (f.issuer === p.issuer && !!p.multi_tenant) || (!!check?.ok && !!check.multi_tenant)
  return (
    <section className="rounded-xl border border-line bg-surface">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 p-4 text-left cursor-pointer" aria-expanded={open}>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <KeyRound size={16} className="text-accent" />
        <span className="font-semibold">{f.label || t('sso.preset.other')}</span>
        {!isNew && (
          <span className={clsx('rounded px-1.5 py-px text-[11px]', p.enabled && p.has_secret ? 'bg-green-500/15 text-green-700 dark:text-green-400' : 'bg-black/5 text-muted dark:bg-white/10')}>
            {p.enabled && p.has_secret ? t('sso.on') : t('sso.off')}
          </span>
        )}
        {!isNew && p.connected > 0 && <span className="text-xs text-muted">{t('sso.connectedCount', { count: p.connected })}</span>}
        {isNew && <span className="text-xs text-muted">{t('sso.new')}</span>}
      </button>
      {open && (
        <form
          className="space-y-4 border-t border-line p-5"
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
        >
          <label className="flex items-center gap-2 text-sm font-medium">
            <Toggle checked={f.enabled} onChange={(x) => set({ enabled: x })} />
            {t('sso.enabled')}
          </label>
          <Field label={t('sso.label')} hint={t('sso.labelHint')}>
            <Input value={f.label} onChange={(e) => set({ label: e.target.value })} placeholder="Google" maxLength={40} />
          </Field>
          <Field label={t('sso.issuer')} hint={ms ? t('sso.msIssuerHint') : t('sso.issuerHint')}>
            <Input value={f.issuer} onChange={(e) => set({ issuer: e.target.value })} placeholder="https://accounts.google.com" spellCheck={false} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('sso.clientId')} hint={ms ? t('sso.msClientIdHint') : undefined}>
              <Input value={f.client_id} onChange={(e) => set({ client_id: e.target.value })} autoComplete="off" spellCheck={false} />
            </Field>
            <Field label={t('sso.clientSecret')} hint={ms ? t('sso.msSecretHint') : p.has_secret ? t('sso.secretKept') : undefined}>
              <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" placeholder={p.has_secret ? '••••••••' : ''} />
            </Field>
          </div>
          {signup && (
            <Field label={t('sso.domains')} hint={t('sso.domainsHint')}>
              <Input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="example.com" spellCheck={false} />
            </Field>
          )}
          {ms && <p className="rounded-md bg-[var(--surface-2)] p-3 text-xs text-muted">{t('sso.msEmailNote')}</p>}
          <label className={clsx('flex items-start gap-2 text-sm', multi && 'opacity-60')}>
            <input type="checkbox" className="mt-0.5" checked={f.trust_email && !multi} disabled={multi} onChange={(e) => set({ trust_email: e.target.checked })} />
            <span>
              {t('sso.trustEmail')}
              <span className="block text-xs text-muted">{multi ? t('sso.trustMultiTenant') : t('sso.trustEmailHint')}</span>
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
              {isNew ? t('sso.addIt') : t('common.save')}
            </Button>
            <Button type="button" disabled={test.isPending || !f.issuer.trim()} onClick={() => (setCheck(null), test.mutate())}>
              {t('sso.check')}
            </Button>
            {isNew ? (
              <Button type="button" variant="ghost" onClick={onToggle}>
                {t('common.cancel')}
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                className="ml-auto text-red-600"
                onClick={async () => {
                  const ok = await ask({ title: t('sso.removeTitle', { label: p.label || 'SSO' }), message: t('sso.removeMsg'), confirmLabel: t('common.delete'), danger: true })
                  if (ok) remove.mutate()
                }}
              >
                <Trash2 size={14} /> {t('common.delete')}
              </Button>
            )}
          </div>
        </form>
      )}
    </section>
  )
}

// ---------- Profile → Security ----------

type Mine = {
  available: boolean
  required: boolean
  providers: { id: string; label: string; connected: boolean }[]
  identities: { id: string; email: string | null; provider: string | null; label: string; created_at: string; last_used_at: string | null }[]
}

export function useMySso() {
  return useQuery({ queryKey: ['my-sso'], queryFn: () => api.get<Mine>('/me/sso') })
}

export function SsoProfileSection({ hasPassword }: { hasPassword: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [sp, setSp] = useSearchParams()
  const { data } = useMySso()
  // back from a provider: say how it went once, then tidy the address bar
  useEffect(() => {
    if (!data) return
    const label = data.providers.find((p) => p.id === sp.get('provider'))?.label ?? 'SSO'
    if (sp.get('sso') === 'linked') toastSuccess(t('sso.linked', { label }))
    else if (sp.get('sso_error')) toastError(new Error(t(`sso.err.${sp.get('sso_error')}`, { label, defaultValue: t('sso.err.sso_failed', { label }) })))
    else return
    const next = new URLSearchParams(sp)
    for (const k of ['sso', 'sso_error', 'provider']) next.delete(k)
    setSp(next, { replace: true })
  }, [sp, setSp, t, data])
  const connect = useMutation({
    mutationFn: (provider: string) => api.post<{ url: string }>('/me/sso/link', { provider }),
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
  const unconnected = data.providers.filter((p) => !p.connected)
  return (
    <section className="space-y-3 rounded-lg border border-line bg-surface p-4">
      <h2 className="font-semibold">{t('sso.profileTitle')}</h2>
      {data.identities.length === 0 && <p className="text-sm text-muted">{t('sso.notConnectedAny')}</p>}
      {data.identities.length > 0 && (
        <ul className="space-y-2">
          {data.identities.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                <Link2 size={14} className="mr-1.5 inline text-accent" />
                {t('sso.connected', { label: i.label })}
                {i.email && <span className="text-muted"> · {i.email}</span>}
                <span className="block text-xs text-muted">{t('sso.since', { date: fmtDate(i.created_at) })}</span>
              </span>
              {!data.required && (
                <Button
                  size="sm"
                  disabled={disconnect.isPending}
                  onClick={async () => {
                    const ok = await ask({
                      title: t('sso.disconnectTitle', { label: i.label }),
                      message: hasPassword ? t('sso.disconnectMsg', { label: i.label }) : t('sso.disconnectNoPassword', { label: i.label }),
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
      {unconnected.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {unconnected.map((p) => (
            <Button key={p.id} disabled={connect.isPending} onClick={() => connect.mutate(p.id)}>
              <KeyRound size={14} /> {t('sso.connect', { label: p.label })}
            </Button>
          ))}
        </div>
      )}
    </section>
  )
}
