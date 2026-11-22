import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { AlertTriangle, CheckCircle2, Info, Pencil, Plus, Send, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { api } from '../lib/api'
import i18n, { errorText } from '../lib/i18n'
import { fmtRelative } from '../lib/prefs'
import type { User } from '../lib/types'
import { ask } from './dialogs'
import { toastError, toastSuccess } from './toast'
import { Button, Dialog, Field, Input, Toggle } from './ui'

type Kind = 'discord' | 'slack' | 'teams' | 'googlechat' | 'telegram' | 'line' | 'ntfy' | 'gotify' | 'webhook'
const EVENTS = ['assigned', 'mentioned', 'commented', 'due_soon', 'overdue'] as const

const PERSONAL: ContactScope = {
  queryKey: ['contact-points'],
  list: '/me/contact-points',
  item: (id) => `/me/contact-points/${id}`,
  test: '/me/contact-points/test',
  events: EVENTS,
  defaultEvents: EVENTS,
  eventLabel: (e) => i18n.t(`contacts.ev.${e}`),
}

/** Board channels (Board settings → Notifications). */
export const BOARD_EVENTS = ['card_created', 'card_moved', 'status', 'assigned', 'commented', 'due', 'card_updated', 'attachments', 'archived'] as const
export function boardScope(boardId: string): ContactScope {
  return {
    queryKey: ['board-contact-points', boardId],
    list: `/boards/${boardId}/contact-points`,
    item: (id) => `/board-contact-points/${id}`,
    test: `/boards/${boardId}/contact-points/test`,
    events: BOARD_EVENTS,
    defaultEvents: ['card_created', 'card_moved', 'status', 'assigned', 'commented', 'due'],
    eventLabel: (e) => i18n.t(`boardChannels.ev.${e}`),
    withLocale: true,
  }
}

/** Fields per platform: [name, secret, required, placeholder] */
const KINDS: Record<Kind, { label: string; color: string; fields: [string, boolean, boolean, string][] }> = {
  discord: { label: 'Discord', color: '#5865F2', fields: [['url', true, true, 'https://discord.com/api/webhooks/…']] },
  slack: { label: 'Slack', color: '#4A154B', fields: [['url', true, true, 'https://hooks.slack.com/services/…']] },
  teams: { label: 'Microsoft Teams', color: '#5059C9', fields: [['url', true, true, 'https://….logic.azure.com/…']] },
  googlechat: { label: 'Google Chat', color: '#00897B', fields: [['url', true, true, 'https://chat.googleapis.com/v1/spaces/…']] },
  telegram: { label: 'Telegram', color: '#229ED9', fields: [['bot_token', true, true, '123456789:AA…'], ['chat_id', false, true, '123456789']] },
  line: { label: 'LINE', color: '#06C755', fields: [['token', true, true, ''], ['to', false, true, 'U0123…']] },
  ntfy: { label: 'ntfy', color: '#317F6F', fields: [['url', true, true, 'https://ntfy.sh/my-secret-topic'], ['token', true, false, 'tk_…']] },
  gotify: { label: 'Gotify', color: '#3F7FBF', fields: [['url', false, true, 'https://gotify.example.com'], ['token', true, true, '']] },
  webhook: { label: 'Webhook (JSON)', color: '#52525b', fields: [['url', true, true, 'https://example.com/hook'], ['secret', true, false, '']] },
}

/** Where a set of contact points lives: personal (Profile) or a board's channels (Board settings). */
export interface ContactScope {
  queryKey: unknown[]
  list: string // GET + POST
  item: (id: string) => string // PATCH + DELETE
  test: string
  events: readonly string[]
  defaultEvents: readonly string[]
  eventLabel: (e: string) => string
  withLocale?: boolean
}

interface ContactPoint {
  id: string
  kind: Kind
  name: string
  config: Record<string, string>
  secrets_set: string[]
  summary: string
  events: string[]
  enabled: boolean
  last_sent_at: string | null
  last_error: string | null
  locale?: 'en' | 'th'
}
interface ContactList {
  system: { email?: boolean; push: boolean }
  items: ContactPoint[]
}

function KindChip({ kind }: { kind: Kind }) {
  const k = KINDS[kind]
  return (
    <span className="shrink-0 rounded px-1.5 py-px text-[11px] font-semibold text-white" style={{ background: k?.color ?? '#52525b' }}>
      {k?.label ?? kind}
    </span>
  )
}

function Remark({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-2 text-xs text-amber-800 dark:text-amber-300">
      <Info size={14} className="mt-px shrink-0" /> <span>{children}</span>
    </p>
  )
}

/** Profile: how I get my notifications (email + my own contact points). */
export function NotificationPrefs({ me }: { me: User }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['contact-points'], queryFn: () => api.get<ContactList>('/me/contact-points') })
  const sys = q.data?.system
  return (
    <section className="space-y-4 rounded-xl border border-line bg-surface p-5">
      <h2 className="font-semibold">{t('notifications.title')}</h2>
      {/* email */}
      <div className="space-y-2">
        <label className={clsx('flex items-start gap-2 text-sm', sys && !sys.email && 'opacity-60')}>
          <input
            type="checkbox"
            checked={me.notify_email}
            onChange={(e) =>
              api.patch<User>('/me', { notify_email: e.target.checked }).then((u) => {
                qc.setQueryData(['me'], u)
                toastSuccess(t('common.saved'))
              }, toastError)
            }
            className="mt-1 accent-[var(--color-accent)]"
          />
          <span>
            {t('notifications.emailMe')}
            <span className="block text-xs text-muted">{me.email ? t('notifications.emailMeHint') : t('notifications.emailMeNoAddress')}</span>
          </span>
        </label>
        {sys && !sys.email && <Remark>{t('contacts.emailSystemOff')}</Remark>}
      </div>
      <BrowserPush />
      <div className="space-y-2 border-t border-line pt-4">
        <h3 className="text-sm font-semibold">{t('contacts.title')}</h3>
        <p className="text-xs text-muted">{t('contacts.hint')}</p>
        <ContactPointList scope={PERSONAL} />
      </div>
    </section>
  )
}

/** List + add/edit/test/delete of contact points, personal or for a board. */
export function ContactPointList({ scope, canEdit = true }: { scope: ContactScope; canEdit?: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: scope.queryKey, queryFn: () => api.get<ContactList>(scope.list) })
  const [editing, setEditing] = useState<ContactPoint | 'new' | null>(null)
  const sys = q.data?.system
  const items = q.data?.items ?? []
  const refresh = () => qc.invalidateQueries({ queryKey: scope.queryKey })
  const patch = (c: ContactPoint, body: Partial<ContactPoint>) => api.patch(scope.item(c.id), body).then(refresh, toastError)
  const test = (c: ContactPoint) =>
    api.post<{ ok: boolean; error?: string }>(scope.test, { id: c.id }).then((r) => {
      refresh()
      if (r.ok) toastSuccess(t('contacts.testSent', { name: c.name }))
      else toastError(new Error(r.error))
    }, toastError)
  return (
    <div className="space-y-2">
      {sys && !sys.push && <Remark>{t('contacts.pushSystemOff')}</Remark>}
      {sys?.push && canEdit && (
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus size={14} /> {t('contacts.add')}
        </Button>
      )}
        {items.length > 0 && (
        <div className="divide-y divide-[var(--border)] rounded-lg border border-line">
          {items.map((c) => (
            <div key={c.id} className={clsx('flex items-center gap-3 px-3 py-2.5', !c.enabled && 'opacity-60')}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <KindChip kind={c.kind} />
                  <span className="truncate text-sm font-medium">{c.name}</span>
                </div>
                <div className="mt-0.5 truncate text-xs text-muted">
                  {c.summary}{c.locale ? ` · ${c.locale.toUpperCase()}` : ''} · {c.events.length ? c.events.map(scope.eventLabel).join(', ') : t('contacts.allEvents')}
                </div>
                {c.last_error ? (
                  <div className="mt-0.5 flex items-start gap-1 text-xs text-red-600 [overflow-wrap:anywhere]">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {c.last_error}
                  </div>
                ) : (
                  c.last_sent_at && (
                    <div className="mt-0.5 flex items-center gap-1 text-xs text-green-700 dark:text-green-400">
                      <CheckCircle2 size={12} /> {t('contacts.lastSent', { when: fmtRelative(c.last_sent_at) })}
                    </div>
                  )
                )}
              </div>
              <Toggle checked={c.enabled} disabled={!canEdit} onChange={(v) => patch(c, { enabled: v })} />
              <div className="flex gap-0.5">
                <IconBtn title={t('contacts.test')} disabled={!sys?.push || !canEdit} onClick={() => test(c)}>
                  <Send size={15} />
                </IconBtn>
                {canEdit && (
                <>
                <IconBtn title={t('common.edit')} onClick={() => setEditing(c)}>
                  <Pencil size={15} />
                </IconBtn>
                <IconBtn
                  title={t('common.delete')}
                  danger
                  onClick={async () =>
                    (await ask({ title: t('common.delete'), message: t('contacts.deleteMsg', { name: c.name }), confirmLabel: t('common.delete'), danger: true })) &&
                    api.del(scope.item(c.id)).then(refresh, toastError)
                  }
                >
                  <Trash2 size={15} />
                </IconBtn>
                </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && <ContactDialog scope={scope} contact={editing === 'new' ? null : editing} canTest={!!sys?.push} onClose={() => setEditing(null)} />}
    </div>
  )
}

function IconBtn({ title, onClick, children, danger, disabled }: { title: string; onClick: () => void; children: React.ReactNode; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={clsx('rounded p-1.5 text-muted hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10 cursor-pointer', danger ? 'hover:text-red-600' : 'hover:text-[var(--text)]')}
    >
      {children}
    </button>
  )
}

function ContactDialog({ scope, contact, canTest, onClose }: { scope: ContactScope; contact: ContactPoint | null; canTest: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [kind, setKind] = useState<Kind>(contact?.kind ?? 'discord')
  const [name, setName] = useState(contact?.name ?? '')
  const [config, setConfig] = useState<Record<string, string>>(contact?.config ?? {})
  const { i18n } = useTranslation()
  const [events, setEvents] = useState<string[]>(contact ? (contact.events.length ? contact.events : [...scope.events]) : [...scope.defaultEvents])
  const [locale, setLocale] = useState<'en' | 'th'>(contact?.locale ?? (i18n.language === 'th' ? 'th' : 'en'))
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null)
  const spec = KINDS[kind]
  const kept = (f: string) => contact?.kind === kind && contact.secrets_set.includes(f)
  const body = () => ({ kind, name: name.trim() || spec.label, config, events, ...(scope.withLocale ? { locale } : {}) })
  const save = useMutation({
    mutationFn: () => (contact ? api.patch(scope.item(contact.id), body()) : api.post(scope.list, body())),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: scope.queryKey })
      toastSuccess(t('common.saved'))
      onClose()
    },
    onError: toastError,
  })
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; error?: string }>(scope.test, { ...body(), id: contact?.id }),
    onMutate: () => setTestResult(null),
    onSuccess: (r) => (setTestResult(r), qc.invalidateQueries({ queryKey: scope.queryKey })),
    onError: (e) => setTestResult({ ok: false, error: errorText(e) }),
  })
  const missing = spec.fields.some(([f, , req]) => req && !config[f]?.trim() && !kept(f))
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={contact ? t('contacts.edit') : t('contacts.add')} wide>
      <form
        className="space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (!missing) save.mutate()
        }}
      >
        <div>
          <div className="mb-1.5 text-xs font-medium text-muted">{t('contacts.type')}</div>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(KINDS) as Kind[]).map((k) => (
              <button
                type="button"
                key={k}
                onClick={() => (setKind(k), setConfig(k === contact?.kind ? contact.config : {}), setTestResult(null))}
                className={clsx(
                  'flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm cursor-pointer',
                  k === kind ? 'border-accent bg-accent/10 font-medium' : 'border-line hover:bg-black/5 dark:hover:bg-white/5',
                )}
              >
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: KINDS[k].color }} />
                {KINDS[k].label}
              </button>
            ))}
          </div>
        </div>
        <p className="rounded-md bg-black/[0.03] px-3 py-2 text-xs leading-relaxed text-muted dark:bg-white/5">{t(`contacts.help.${kind}`)}</p>
        <Field label={t('common.name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={spec.label} maxLength={80} />
        </Field>
        {spec.fields.map(([f, secret, required, placeholder]) => (
          <Field key={`${kind}-${f}`} label={t(`contacts.field.${kind}_${f}`, { defaultValue: t(`contacts.field.${f}`) }) + (required ? '' : ` (${t('contacts.optional')})`)}>
            <Input
              type={secret ? 'password' : 'text'}
              autoComplete="off"
              value={config[f] ?? ''}
              onChange={(e) => (setConfig({ ...config, [f]: e.target.value }), setTestResult(null))}
              placeholder={kept(f) ? t('contacts.keepSecret') : placeholder}
            />
          </Field>
        ))}
        {scope.withLocale && (
          <Field label={t('contacts.language')}>
            <select value={locale} onChange={(e) => setLocale(e.target.value as 'en' | 'th')} className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm">
              <option value="en">English</option>
              <option value="th">ไทย</option>
            </select>
          </Field>
        )}
        <div>
          <div className="mb-1.5 text-xs font-medium text-muted">{t('contacts.events')}</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {scope.events.map((e) => (
              <label key={e} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={events.includes(e)}
                  onChange={(ev) => setEvents(ev.target.checked ? [...events, e] : events.filter((x) => x !== e))}
                  className="accent-[var(--color-accent)]"
                />
                {scope.eventLabel(e)}
              </label>
            ))}
          </div>
        </div>
        {testResult && (
          <p className={clsx('flex items-start gap-1.5 text-sm [overflow-wrap:anywhere]', testResult.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600')}>
            {testResult.ok ? <CheckCircle2 size={15} className="mt-0.5 shrink-0" /> : <AlertTriangle size={15} className="mt-0.5 shrink-0" />}
            {testResult.ok ? t('contacts.testOk') : testResult.error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button type="button" onClick={() => test.mutate()} disabled={!canTest || missing || test.isPending}>
            <Send size={14} /> {test.isPending ? t('contacts.testing') : t('contacts.test')}
          </Button>
          <div className="ml-auto flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" disabled={missing || events.length === 0 || save.isPending}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  )
}

/** Admin → Notifications: the system switches. */
export function NotificationsAdminTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  type S = { email: boolean; push: boolean; allow_private: boolean; browser: boolean }
  const q = useQuery({ queryKey: ['admin-notifications'], queryFn: () => api.get<{ settings: S; smtp_ready: boolean }>('/admin/notifications') })
  const save = useMutation({
    mutationFn: (s: S) => api.put<{ settings: S }>('/admin/notifications', s),
    onSuccess: (r) => {
      qc.setQueryData(['admin-notifications'], { ...q.data, settings: r.settings })
      qc.invalidateQueries({ queryKey: ['contact-points'] })
      toastSuccess(t('common.saved'))
    },
    onError: toastError,
  })
  if (!q.data) return null
  const s = q.data.settings
  const row = (key: keyof S, title: string, hint: string, extra?: React.ReactNode, indent = false, disabled = false) => (
    <div className={clsx('flex items-start gap-3 py-3', indent && 'pl-6')}>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        <p className="text-xs text-muted">{hint}</p>
        {extra}
      </div>
      <Toggle checked={s[key]} disabled={disabled || save.isPending} onChange={(v) => save.mutate({ ...s, [key]: v })} />
    </div>
  )
  return (
    <div className="max-w-2xl space-y-1 rounded-xl border border-line bg-surface px-5 py-2">
      {row(
        'email',
        t('contacts.adminEmail'),
        t('contacts.adminEmailHint'),
        !q.data.smtp_ready && (
          <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-400">
            {t('contacts.adminNoSmtp')}{' '}
            <Link to="/admin?tab=email" className="text-accent hover:underline">
              {t('email.title')}
            </Link>
          </p>
        ),
      )}
      <div className="border-t border-line" />
      {row('browser', t('push.adminTitle'), t('push.adminHint'))}
      <div className="border-t border-line" />
      {row('push', t('contacts.adminPush'), t('contacts.adminPushHint'))}
      {row('allow_private', t('contacts.adminPrivate'), t('contacts.adminPrivateHint'), undefined, true, !s.push)}
    </div>
  )
}

function urlB64ToBytes(b64: string) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4)
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

/** Profile: notifications from this browser (Web Push), even when Kanb isn't open. */
function BrowserPush() {
  const { t } = useTranslation()
  const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  const info = useQuery({ queryKey: ['push-info'], queryFn: () => api.get<{ public_key: string; enabled: boolean }>('/push'), enabled: supported })
  const [sub, setSub] = useState<PushSubscription | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!supported) return
    navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).then(setSub, () => setSub(null))
  }, [supported])
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) && !('standalone' in navigator && (navigator as { standalone?: boolean }).standalone)
  const denied = supported && Notification.permission === 'denied'
  const turnOn = async () => {
    setBusy(true)
    try {
      if ((await Notification.requestPermission()) !== 'granted') return toastError(new Error(t('push.denied')))
      const reg = await navigator.serviceWorker.ready
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(info.data!.public_key) })
      await api.post('/me/push', s.toJSON())
      setSub(s)
      toastSuccess(t('push.on'))
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }
  const turnOff = async () => {
    if (!sub) return
    setBusy(true)
    try {
      await api.del('/me/push', { endpoint: sub.endpoint })
      await sub.unsubscribe()
      setSub(null)
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }
  const test = () =>
    api.post<{ sent: number; failed: number }>('/me/push/test').then(
      (r) => (r.sent ? toastSuccess(t('push.testSent')) : toastError(new Error(t('push.testFailed')))),
      toastError,
    )
  return (
    <div className="space-y-2 border-t border-line pt-4">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{t('push.title')}</div>
          <p className="text-xs text-muted">{t('push.hint')}</p>
        </div>
        {supported && info.data?.enabled && sub !== undefined && (
          <Toggle checked={!!sub} disabled={busy || denied} onChange={(v) => (v ? turnOn() : turnOff())} />
        )}
      </div>
      {!supported && <Remark>{ios ? t('push.ios') : t('push.unsupported')}</Remark>}
      {supported && info.data && !info.data.enabled && <Remark>{t('push.systemOff')}</Remark>}
      {denied && <Remark>{t('push.blocked')}</Remark>}
      {sub && (
        <Button size="sm" onClick={test}>
          <Send size={13} /> {t('contacts.test')}
        </Button>
      )}
    </div>
  )
}
