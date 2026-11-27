/**
 * Admin pages beyond users and settings: activity log, all boards, system status and the site announcement, plus the
 * Users tab's helpers (signed-in devices, inviting several people, inactive accounts).
 */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { AlertTriangle, CheckCircle2, ExternalLink, Info, Megaphone, UserPlus, XCircle } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Link } from 'react-router'
import { ask } from '../components/dialogs'
import { SessionList } from '../components/Sessions'
import { toastError, toastSuccess } from '../components/toast'
import { Button, Dialog, Field, Input, Spinner } from '../components/ui'
import { DateInput, TimeInput } from '../components/DateInput'
import { api } from '../lib/api'
import { generatePassword } from '../lib/password'
import { fmtDate, fmtRelative } from '../lib/prefs'
import type { User } from '../lib/types'

/** Decimal units, like disks are sold: 50 GB = 50 000 000 000 bytes. */
export const fmtBytes = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(0, Math.round(n / 1e3))} KB`

const card = 'rounded-lg border border-line bg-surface p-4'
const select = 'h-9 rounded-md border border-line bg-surface px-2 text-sm'

// ---------------------------------------------------------------- activity

interface AuditEntry {
  id: number
  at: string
  kind: string
  actor_id: string | null
  actor_name: string | null
  target_id: string | null
  target_name: string | null
  ip: string | null
  data: Record<string, unknown>
}

const KIND_TONE: Record<string, string> = {
  sign_in_failed: 'text-red-600',
  totp_failed: 'text-red-600',
  user_deleted: 'text-red-600',
  board_deleted: 'text-red-600',
  sessions_revoked: 'text-amber-700 dark:text-amber-400',
  user_twofa_reset: 'text-amber-700 dark:text-amber-400',
}

export function ActivityTab({ users }: { users: User[] }) {
  const { t } = useTranslation()
  const [topic, setTopic] = useState('')
  const [user, setUser] = useState('')
  const q = useInfiniteQuery({
    queryKey: ['admin-audit', topic, user],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams()
      if (topic) p.set('topic', topic)
      if (user) p.set('user', user)
      if (pageParam) p.set('before', String(pageParam))
      return api.get<{ entries: AuditEntry[]; more: boolean; topics: string[] }>(`/admin/audit?${p}`)
    },
    getNextPageParam: (last) => (last.more ? last.entries[last.entries.length - 1]?.id : undefined),
  })
  const entries = q.data?.pages.flatMap((p) => p.entries) ?? []
  const topics = q.data?.pages[0]?.topics ?? ['signin', 'failed', 'account', 'users', 'settings', 'boards']
  const names = useMemo(() => new Map(users.map((u) => [u.id, u.display_name])), [users])
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{t('audit.hint')}</p>
      <div className="flex flex-wrap gap-2">
        <select value={topic} onChange={(e) => setTopic(e.target.value)} className={select} aria-label={t('audit.topic')}>
          <option value="">{t('audit.allTopics')}</option>
          {topics.map((k) => (
            <option key={k} value={k}>
              {t(`audit.topics.${k}`)}
            </option>
          ))}
        </select>
        <select value={user} onChange={(e) => setUser(e.target.value)} className={clsx(select, 'max-w-[16rem]')} aria-label={t('audit.person')}>
          <option value="">{t('audit.everyone')}</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.display_name} · @{u.username}
            </option>
          ))}
        </select>
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted">{t('audit.none')}</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-lg border border-line bg-surface">
          {entries.map((e) => (
            <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm">
              <span className="w-36 shrink-0 text-xs tabular-nums text-muted" title={e.at}>
                {fmtDate(e.at, true)}
              </span>
              <span className={clsx('min-w-0 flex-1', KIND_TONE[e.kind])}>{describe(t, e, names)}</span>
              {e.ip && <span className="font-mono text-xs text-muted">{e.ip}</span>}
            </li>
          ))}
        </ul>
      )}
      {q.hasNextPage && (
        <Button onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
          {t('audit.more')}
        </Button>
      )}
    </div>
  )
}

/** One readable line per entry, e.g. "Admin reset two-factor sign-in for Tess". */
function describe(t: TFunction, e: AuditEntry, names: Map<string, string>) {
  const who = e.actor_name ?? t('audit.someone')
  const target = e.target_name ?? t('audit.unknown')
  const d = e.data
  const base = t(`audit.kinds.${e.kind}`, { who, target, defaultValue: e.kind })
  const extra: string[] = []
  if (e.kind === 'sign_in') {
    if (d.method && d.method !== 'password') extra.push(t(`audit.method.${d.method}`))
    if (d.device) extra.push(String(d.device))
  }
  if (e.kind === 'sign_in_failed' && d.typed) extra.push(t('audit.typed', { name: String(d.typed) }))
  if (e.kind === 'user_updated') {
    extra.push(
      Object.entries(d)
        .map(([k, v]) => (v && typeof v === 'object' && 'to' in v ? t(`audit.field.${k}_${(v as { to: boolean }).to ? 'on' : 'off'}`) : t(`audit.field.${k}`)))
        .join(', '),
    )
  }
  if (e.kind === 'settings_changed') {
    extra.push(t(`audit.area.${d.area}`))
    if (d.area === 'security' && typeof d.require_2fa === 'boolean') extra.push(t(d.require_2fa ? 'audit.require2faOn' : 'audit.require2faOff'))
    if (d.area === 'security' && typeof d.public_links === 'boolean') extra.push(t(d.public_links ? 'audit.publicLinksOn' : 'audit.publicLinksOff'))
    if (Array.isArray(d.fields) && d.fields.length) extra.push(d.fields.join(', '))
    if (d.area === 'announcement') extra.push(d.removed ? t('audit.removed') : `“${String(d.text ?? '')}”`)
    if (d.area === 'signup' && (d.approval === 'review' || d.approval === 'auto')) extra.push(`${t('signup.approval')} ${t(`signup.${d.approval}`)}`)
  }
  if ((e.kind === 'signup_rejected' || e.kind === 'signed_up') && d.username) extra.push(`@${d.username}`)
  if (e.kind === 'board_owner_added' && typeof d.user_id === 'string') extra.push(t('audit.newOwner', { name: names.get(d.user_id) ?? '?' }))
  if (e.kind === 'user_deleted' && d.username) extra.push(`@${d.username}`)
  if (e.kind === 'sessions_revoked' && typeof d.count === 'number') extra.push(t('audit.devices', { count: d.count }))
  if (e.kind.startsWith('department_') && d.name) extra.push(`“${String(d.name)}”`)
  if (e.kind === 'department_renamed' && d.from) extra.push(`“${String(d.from)}” → “${String(d.to)}”`)
  if ((e.kind === 'sso_linked' || e.kind === 'sso_unlinked') && d.email) extra.push(String(d.email))
  if ((e.kind === 'token_created' || e.kind === 'token_revoked') && d.name) extra.push(`“${String(d.name)}”` + (d.scope ? ` (${String(d.scope)})` : ''))
  if (e.kind === 'sessions_revoked' && typeof d.tokens === 'number' && d.tokens > 0) extra.push(t('audit.tokensRevoked', { count: d.tokens }))
  if (e.kind === 'sso_failed' && d.reason) extra.push(String(d.reason) + (d.email ? ` (${String(d.email)})` : ''))
  return extra.length ? `${base} — ${extra.join(' · ')}` : base
}

// ---------------------------------------------------------------- devices

export function DevicesDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const { t } = useTranslation()
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('devices.title', { name: user.display_name })}>
      <div className="space-y-3 p-5">
        <p className="text-sm text-muted">{t('devices.hint')}</p>
        <SessionList userId={user.id} name={user.display_name} />
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------- inactive accounts

export type ActiveFilter = '' | 'inactive30' | 'inactive90' | 'inactive180' | 'unrecorded' | 'deactivated'

const DAY = 86_400_000
export function matchesActivity(u: User, f: ActiveFilter, now = Date.now()) {
  if (!f) return true
  if (f === 'deactivated') return !u.is_active
  if (!u.is_active) return false
  // no time recorded yet ≠ never signed in (older accounts may simply have no session left from before it was tracked)
  if (f === 'unrecorded') return !u.last_seen_at
  const days = { inactive30: 30, inactive90: 90, inactive180: 180 }[f]
  return !!u.last_seen_at && now - new Date(u.last_seen_at).getTime() > days * DAY
}

interface AdminBoard {
  id: string
  name: string
  color: string
  is_tutorial: boolean
  archived_at: string | null
  last_activity: string
  members: number
  cards: number
  bytes: number
  owners: { id: string; name: string; active: boolean }[]
}

/** Deactivates every listed account except yourself and super admins, after naming the boards that would lose their last active owner. */
export function useBulkDeactivate(me: User) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  return async (users: User[]) => {
    const picked = users.filter((u) => u.is_active && u.id !== me.id && !u.is_super_admin)
    const skipped = users.filter((u) => u.is_active && (u.id === me.id || u.is_super_admin)).length
    if (!picked.length) return toastError(new Error(t('inactive.nothing')))
    const boards = await api.get<AdminBoard[]>('/admin/boards')
    const gone = new Set(picked.map((u) => u.id))
    const orphaned = boards.filter((b) => !b.archived_at && !b.is_tutorial && b.owners.some((o) => o.active) && b.owners.filter((o) => o.active).every((o) => gone.has(o.id)))
    const msg = [
      t('inactive.confirm', { count: picked.length }),
      skipped ? t('inactive.skipped', { count: skipped }) : '',
      orphaned.length ? t('inactive.orphaned', { names: orphaned.map((b) => b.name).join(', ') }) : '',
    ]
      .filter(Boolean)
      .join('\n\n')
    if (!(await ask({ title: t('inactive.deactivate', { count: picked.length }), message: msg, confirmLabel: t('inactive.deactivateBtn'), danger: true }))) return
    let n = 0
    for (const u of picked) {
      try {
        await api.patch(`/admin/users/${u.id}`, { is_active: false })
        n++
      } catch (e) {
        toastError(e)
      }
    }
    qc.invalidateQueries({ queryKey: ['admin-users'] })
    qc.invalidateQueries({ queryKey: ['admin-audit'] })
    toastSuccess(t('inactive.done', { count: n }))
  }
}

// ---------------------------------------------------------------- invite several

interface Row {
  name: string
  email: string
  username: string
  status?: 'ok' | 'error'
  note?: string
}

/** "Name <email>", "Name, email" or just "email", one person per line. */
function parse(text: string, taken: Set<string>): Row[] {
  const used = new Set(taken)
  const seen = new Set<string>()
  const rows: Row[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const m = line.match(/^(.*?)[\s,;]*<?([^\s<>,;]+@[^\s<>,;]+)>?\s*$/)
    if (!m) {
      rows.push({ name: line, email: '', username: '', status: 'error', note: 'noEmail' })
      continue
    }
    const email = m[2].trim()
    if (seen.has(email.toLowerCase())) {
      rows.push({ name: line, email, username: '', status: 'error', note: 'duplicate' })
      continue
    }
    seen.add(email.toLowerCase())
    const name = m[1].replace(/^["']|["']$/g, '').trim() || email.split('@')[0]
    let base = email.split('@')[0].toLowerCase().replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 36)
    if (base.length < 2) base = `${base}user`
    let username = base
    for (let i = 2; used.has(username.toLowerCase()); i++) username = `${base}${i}`
    used.add(username.toLowerCase())
    rows.push({ name, email, username })
  }
  return rows
}

export function BulkInvite({ users, onClose }: { users: User[]; onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [canCreate, setCanCreate] = useState(true)
  const [locale, setLocale] = useState(i18n.language === 'th' ? 'th' : 'en')
  const [rows, setRows] = useState<Row[] | null>(null)
  const [busy, setBusy] = useState(false)
  const taken = useMemo(() => new Set(users.map((u) => u.username.toLowerCase())), [users])
  const emails = useMemo(() => new Set(users.map((u) => (u.email ?? '').toLowerCase()).filter(Boolean)), [users])
  const preview = useMemo(
    () => parse(text, taken).map((r) => (r.email && emails.has(r.email.toLowerCase()) ? { ...r, status: 'error' as const, note: 'emailTaken' } : r)),
    [text, taken, emails],
  )
  const ready = preview.filter((r) => !r.status)

  const run = async () => {
    setBusy(true)
    const out: Row[] = preview.map((r) => ({ ...r }))
    setRows(out)
    for (const r of out) {
      if (r.status) continue
      try {
        const res = await api.post<{ invite: { sent: boolean; error?: string } | null }>('/admin/users', {
          username: r.username,
          display_name: r.name,
          email: r.email,
          password: generatePassword(),
          is_super_admin: false,
          can_create_boards: canCreate,
          locale,
          send_invite: true,
        })
        r.status = res.invite?.sent ? 'ok' : 'error'
        r.note = res.invite?.sent ? 'handedOver' : 'createdNoMail'
      } catch (e) {
        r.status = 'error'
        r.note = (e as { code?: string }).code ?? 'failed'
      }
      setRows([...out])
      // one at a time, about a second apart: mail services in trial mode (e.g. Amazon SES sandbox) allow ~1 per second
      await new Promise((ok) => setTimeout(ok, 1100))
    }
    setBusy(false)
    qc.invalidateQueries({ queryKey: ['admin-users'] })
    qc.invalidateQueries({ queryKey: ['admin-audit'] })
  }

  const list = rows ?? preview
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()} title={t('invite.title')}>
      <div className="space-y-3 p-5">
        {!rows && (
          <>
            <p className="text-sm text-muted">{t('invite.hint')}</p>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={6}
              autoFocus
              placeholder={'Somchai Jaidee <somchai@example.com>\nAnna Lee, anna@example.com\nbob@example.com'}
              className="w-full rounded-md border border-line bg-surface p-2 font-mono text-sm"
            />
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={canCreate} onChange={(e) => setCanCreate(e.target.checked)} className="accent-[var(--color-accent)]" />
                {t('admin.canCreateBoards')}
              </label>
              <label className="flex items-center gap-2">
                {t('invite.language')}
                <select value={locale} onChange={(e) => setLocale(e.target.value)} className={clsx(select, 'h-8')}>
                  <option value="en">English</option>
                  <option value="th">ไทย</option>
                </select>
              </label>
            </div>
          </>
        )}
        {list.length > 0 && (
          <div className="max-h-72 overflow-y-auto rounded-lg border border-line">
            <table className="w-full table-fixed text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="p-2 font-medium">{t('admin.displayName')}</th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {list.map((r, i) => (
                  <tr key={i} className="border-b border-line last:border-0">
                    <td className="min-w-0 p-2">
                      <div className="truncate">{r.name}</div>
                      <div className="truncate text-xs text-muted">
                        {r.username && `@${r.username} · `}
                        {r.email || '—'}
                      </div>
                    </td>
                    <td className="w-44 p-2 text-xs">
                      {r.status === 'ok' ? (
                        <span className="flex items-center gap-1 text-green-700 dark:text-green-400">
                          <CheckCircle2 size={13} /> {t(`invite.note.${r.note}`)}
                        </span>
                      ) : r.status === 'error' ? (
                        <span className="flex items-center gap-1 text-red-600">
                          <XCircle size={13} /> {t(`invite.note.${r.note}`, { defaultValue: t(`errors.${r.note}`, { defaultValue: r.note }) })}
                        </span>
                      ) : rows && busy ? (
                        <span className="text-muted">…</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows && !busy && <p className="text-xs text-muted">{t('invite.deliveryNote')}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {rows ? t('common.close') : t('common.cancel')}
          </Button>
          {!rows && (
            <Button variant="primary" disabled={!ready.length} onClick={run}>
              <UserPlus size={14} /> {t('invite.send', { count: ready.length })}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------- all boards

export function BoardsTab({ users }: { users: User[] }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['admin-boards'], queryFn: () => api.get<AdminBoard[]>('/admin/boards') })
  const [filter, setFilter] = useState('')
  const [orphansOnly, setOrphansOnly] = useState(false)
  // everyone's own "Getting started" board: hidden unless asked for
  const [tutorials, setTutorials] = useState(false)
  const [adding, setAdding] = useState<AdminBoard | null>(null)
  const orphan = (b: AdminBoard) => !b.owners.some((o) => o.active)
  const f = filter.trim().toLowerCase()
  const boards = (q.data ?? []).filter(
    (b) => (tutorials || !b.is_tutorial) && (!f || b.name.toLowerCase().includes(f)) && (!orphansOnly || orphan(b)),
  )
  const orphans = (q.data ?? []).filter((b) => !b.archived_at && !b.is_tutorial && orphan(b)).length
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('adminBoards.search')} className="max-w-xs" />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={orphansOnly} onChange={(e) => setOrphansOnly(e.target.checked)} className="accent-[var(--color-accent)]" />
          {t('adminBoards.orphansOnly')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={tutorials} onChange={(e) => setTutorials(e.target.checked)} className="accent-[var(--color-accent)]" />
          {t('adminBoards.showTutorials')}
        </label>
        {orphans > 0 && (
          <span className="flex items-center gap-1 text-sm text-amber-700 dark:text-amber-400">
            <AlertTriangle size={14} /> {t('adminBoards.orphans', { count: orphans })}
          </span>
        )}
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="p-3 font-medium">{t('adminBoards.board')}</th>
                <th className="p-3 font-medium">{t('adminBoards.owners')}</th>
                <th className="p-3 text-right font-medium">{t('adminBoards.members')}</th>
                <th className="p-3 text-right font-medium">{t('adminBoards.cards')}</th>
                <th className="p-3 text-right font-medium">{t('adminBoards.files')}</th>
                <th className="p-3 font-medium">{t('adminBoards.lastActivity')}</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {boards.map((b) => (
                <tr key={b.id} className="border-b border-line last:border-0">
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: b.color }} />
                      {b.archived_at ? <span className="font-medium">{b.name}</span> : <Link to={`/b/${b.id}`} className="font-medium hover:underline">{b.name}</Link>}
                      {b.archived_at && <Badge>{t('adminBoards.archived')}</Badge>}
                      {b.is_tutorial && <Badge>{t('adminBoards.tutorial')}</Badge>}
                    </div>
                  </td>
                  <td className="p-3">
                    {orphan(b) ? (
                      <span className="flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400">
                        <AlertTriangle size={12} /> {t('adminBoards.noActiveOwner')}
                      </span>
                    ) : null}
                    <div className="text-xs">
                      {b.owners.map((o, i) => (
                        <span key={o.id} className={clsx(!o.active && 'text-muted line-through')}>
                          {i > 0 && ', '}
                          {o.name}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="p-3 text-right tabular-nums">{b.members}</td>
                  <td className="p-3 text-right tabular-nums">{b.cards}</td>
                  <td className="p-3 text-right tabular-nums">{b.bytes ? fmtBytes(b.bytes) : '—'}</td>
                  <td className="p-3 text-xs text-muted" title={b.last_activity}>
                    {fmtRelative(b.last_activity)}
                  </td>
                  <td className="p-3 text-right">
                    <Button size="sm" onClick={() => setAdding(b)}>
                      <UserPlus size={13} /> {t('adminBoards.addOwner')}
                    </Button>
                  </td>
                </tr>
              ))}
              {boards.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-muted">
                    {t('search.noResults')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {adding && (
        <AddOwner
          board={adding}
          users={users.filter((u) => u.is_active && !adding.owners.some((o) => o.id === u.id && o.active))}
          onClose={() => setAdding(null)}
          onDone={() => (qc.invalidateQueries({ queryKey: ['admin-boards'] }), qc.invalidateQueries({ queryKey: ['admin-audit'] }))}
        />
      )}
    </div>
  )
}

const Badge = ({ children }: { children: ReactNode }) => (
  <span className="rounded bg-black/5 px-1.5 py-px text-[10px] font-medium text-muted dark:bg-white/10">{children}</span>
)

function AddOwner({ board, users, onClose, onDone }: { board: AdminBoard; users: User[]; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const [userId, setUserId] = useState(users[0]?.id ?? '')
  const m = useMutation({
    mutationFn: () => api.post(`/admin/boards/${board.id}/owners`, { user_id: userId }),
    onSuccess: () => {
      onDone()
      toastSuccess(t('adminBoards.ownerAdded', { name: users.find((u) => u.id === userId)?.display_name, board: board.name }))
      onClose()
    },
    onError: toastError,
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('adminBoards.addOwnerTo', { board: board.name })}>
      <form
        className="space-y-3 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          m.mutate()
        }}
      >
        <p className="text-sm text-muted">{t('adminBoards.addOwnerHint')}</p>
        <Field label={t('adminBoards.person')}>
          <select value={userId} onChange={(e) => setUserId(e.target.value)} className={clsx(select, 'w-full')} required>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.display_name} · @{u.username}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!userId || m.isPending}>
            {t('adminBoards.makeOwner')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

// ---------------------------------------------------------------- system

interface SystemInfo {
  version: string
  latest: { version: string; url: string; published_at: string | null } | null
  started_at: string | null
  database: { bytes: number; postgres: string; migrations: number; last_migration: string | null }
  files_bytes: number
  files_limit_bytes: number | null
  counts: { users: number; active_30d: number; boards: number; cards: number }
  email: { enabled: boolean; ready: boolean; last: { at: string; ok: boolean; error: string | null } | null }
}

/** v0.1.10 > v0.1.9: compare the numbers, not the text. */
function newer(latest: string, current: string) {
  const n = (v: string) => v.replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  const [a, b] = [n(latest), n(current)]
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return false
}

export function SystemTab() {
  const { t } = useTranslation()
  const q = useQuery({ queryKey: ['admin-system'], queryFn: () => api.get<SystemInfo>('/admin/system') })
  const d = q.data
  return (
    <div className="grid max-w-4xl gap-4 md:grid-cols-2">
      <AnnouncementCard />
      {!d ? (
        <Spinner />
      ) : (
        <>
          <section className={card}>
            <h2 className="mb-2 font-semibold">{t('system.version')}</h2>
            <div className="text-2xl font-semibold tabular-nums">{d.version}</div>
            <p className="mt-2 text-sm">
              {!d.latest ? (
                <span className="text-muted">{t('system.latestUnknown')}</span>
              ) : d.version === 'dev' || d.version === 'edge' ? (
                <span className="text-muted">{t('system.latestIs', { version: d.latest.version })}</span>
              ) : newer(d.latest.version, d.version) ? (
                <a href={d.latest.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-amber-700 hover:underline dark:text-amber-400">
                  {t('system.updateAvailable', { version: d.latest.version })} <ExternalLink size={12} />
                </a>
              ) : (
                <span className="inline-flex items-center gap-1 text-green-700 dark:text-green-400">
                  <CheckCircle2 size={14} /> {t('system.upToDate')}
                </span>
              )}
            </p>
            {d.started_at && <p className="mt-1 text-xs text-muted">{t('system.upSince', { when: fmtRelative(d.started_at) })}</p>}
          </section>
          <section className={card}>
            <h2 className="mb-2 font-semibold">{t('system.email')}</h2>
            <p className="text-sm">
              {!d.email.enabled ? (
                <span className="text-muted">{t('system.emailOff')}</span>
              ) : !d.email.ready ? (
                <span className="text-amber-700 dark:text-amber-400">{t('system.emailIncomplete')}</span>
              ) : !d.email.last ? (
                <span className="text-muted">{t('system.emailNoneYet')}</span>
              ) : d.email.last.ok ? (
                <span className="inline-flex items-center gap-1 text-green-700 dark:text-green-400">
                  <CheckCircle2 size={14} /> {t('system.emailOk', { when: fmtRelative(d.email.last.at) })}
                </span>
              ) : (
                <span className="text-red-600">
                  <span className="inline-flex items-center gap-1">
                    <XCircle size={14} /> {t('system.emailFailed', { when: fmtRelative(d.email.last.at) })}
                  </span>
                  <span className="mt-1 block break-words font-mono text-xs">{d.email.last.error}</span>
                </span>
              )}
            </p>
            <p className="mt-2 text-xs text-muted">{t('system.emailSinceRestart')}</p>
            <Link to="/admin?tab=email" className="mt-1 inline-block text-xs text-accent hover:underline">
              {t('email.title')} →
            </Link>
          </section>
          <section className={card}>
            <h2 className="mb-2 font-semibold">{t('system.usage')}</h2>
            <Stat label={t('system.users')} value={`${d.counts.users}`} sub={t('system.active30', { count: d.counts.active_30d })} />
            <Stat label={t('system.boards')} value={`${d.counts.boards}`} />
            <Stat label={t('system.cards')} value={`${d.counts.cards}`} />
          </section>
          <section className={card}>
            <h2 className="mb-2 font-semibold">{t('system.storage')}</h2>
            <Stat label={t('system.database')} value={fmtBytes(d.database.bytes)} sub={`PostgreSQL ${d.database.postgres}`} />
            <Stat
              label={t('system.files')}
              value={fmtBytes(d.files_bytes)}
              sub={d.files_limit_bytes ? t('system.ofLimit', { limit: fmtBytes(d.files_limit_bytes) }) : t('system.noLimit')}
            />
            <Stat label={t('system.migrations')} value={`${d.database.migrations}`} sub={d.database.last_migration ?? ''} />
          </section>
        </>
      )}
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line py-1.5 text-sm last:border-0">
      <span className="text-muted">{label}</span>
      <span className="text-right">
        <span className="font-medium tabular-nums">{value}</span>
        {sub && <span className="block text-xs text-muted">{sub}</span>}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------- announcement

export interface Announcement {
  id: string
  text: string
  level: 'info' | 'warning'
  until: string | null
}
const MAX = 500
const pad = (n: number) => String(n).padStart(2, '0')

function AnnouncementCard() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['admin-announcement'], queryFn: () => api.get<Announcement | null>('/admin/announcement') })
  const [draft, setDraft] = useState<{ text: string; level: 'info' | 'warning'; date: string; time: string } | null>(null)
  const cur = q.data
  const d = draft ?? {
    text: cur?.text ?? '',
    level: cur?.level ?? 'info',
    date: cur?.until ? `${new Date(cur.until).getFullYear()}-${pad(new Date(cur.until).getMonth() + 1)}-${pad(new Date(cur.until).getDate())}` : '',
    time: cur?.until ? `${pad(new Date(cur.until).getHours())}:${pad(new Date(cur.until).getMinutes())}` : '23:59',
  }
  const expired = !!cur?.until && new Date(cur.until).getTime() < Date.now()
  const save = useMutation({
    mutationFn: (body: { text: string; level: string; until: string | null }) => api.put<Announcement | null>('/admin/announcement', body),
    onSuccess: (a) => {
      qc.setQueryData(['admin-announcement'], a)
      qc.invalidateQueries({ queryKey: ['announcement'] })
      qc.invalidateQueries({ queryKey: ['admin-audit'] })
      setDraft(null)
      toastSuccess(a ? t('announce.published') : t('announce.removed'))
    },
    onError: toastError,
  })
  return (
    <section className={clsx(card, 'md:col-span-2')}>
      <h2 className="mb-1 flex items-center gap-2 font-semibold">
        <Megaphone size={16} /> {t('announce.title')}
      </h2>
      <p className="mb-3 text-sm text-muted">{t('announce.hint')}</p>
      {cur && (
        <p className={clsx('mb-3 text-xs', expired ? 'text-muted' : 'text-green-700 dark:text-green-400')}>
          {expired ? t('announce.expired') : cur.until ? t('announce.liveUntil', { when: fmtDate(cur.until, true) }) : t('announce.live')}
        </p>
      )}
      <textarea
        value={d.text}
        maxLength={MAX}
        rows={3}
        onChange={(e) => setDraft({ ...d, text: e.target.value })}
        placeholder={t('announce.placeholder')}
        className="w-full rounded-md border border-line bg-surface p-2 text-sm"
      />
      <div className="mt-1 text-right text-xs text-muted">
        {d.text.length}/{MAX}
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <Field label={t('announce.style')}>
          <div>
            <select value={d.level} onChange={(e) => setDraft({ ...d, level: e.target.value as 'info' | 'warning' })} className={select}>
              <option value="info">{t('announce.info')}</option>
              <option value="warning">{t('announce.warning')}</option>
            </select>
          </div>
        </Field>
        <Field label={t('announce.until')}>
          <div className="flex gap-2">
            <DateInput value={d.date} onChange={(v) => setDraft({ ...d, date: v })} />
            <TimeInput value={d.time} onChange={(v) => setDraft({ ...d, time: v })} disabled={!d.date} />
          </div>
        </Field>
      </div>
      {d.text.trim() && (
        <div className="mt-3">
          <div className="mb-1 text-xs text-muted">{t('announce.preview')}</div>
          <BannerBody level={d.level} text={d.text.trim()} />
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={!d.text.trim() || save.isPending}
          onClick={() => save.mutate({ text: d.text, level: d.level, until: d.date ? new Date(`${d.date}T${d.time || '23:59'}`).toISOString() : null })}
        >
          {cur ? t('announce.update') : t('announce.publish')}
        </Button>
        {cur && (
          <Button
            variant="danger"
            disabled={save.isPending}
            onClick={async () => {
              if (await ask({ title: t('announce.remove'), message: t('announce.removeMsg'), confirmLabel: t('announce.remove'), danger: true }))
                save.mutate({ text: '', level: 'info', until: null })
            }}
          >
            {t('announce.remove')}
          </Button>
        )}
      </div>
    </section>
  )
}

/** The banner itself (also the preview). Plain text only: line breaks kept, nothing rendered as HTML or Markdown. */
export function BannerBody({ level, text, onDismiss }: { level: 'info' | 'warning'; text: string; onDismiss?: () => void }) {
  const { t } = useTranslation()
  return (
    <div
      role={level === 'warning' ? 'alert' : 'status'}
      className={clsx(
        'flex items-start gap-2 px-4 py-2 text-sm',
        level === 'warning' ? 'bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-100' : 'bg-accent/10 text-[var(--text)]',
        !onDismiss && 'rounded-md',
      )}
    >
      {level === 'warning' ? <AlertTriangle size={16} className="mt-0.5 shrink-0" /> : <Info size={16} className="mt-0.5 shrink-0 text-accent" />}
      <p className="min-w-0 flex-1 whitespace-pre-line break-words">{text}</p>
      {onDismiss && (
        <button onClick={onDismiss} className="shrink-0 rounded px-1.5 text-xs font-medium opacity-70 hover:opacity-100 cursor-pointer" aria-label={t('announce.dismiss')}>
          {t('announce.dismiss')}
        </button>
      )}
    </div>
  )
}

const DISMISSED = 'kanb.dismissedAnnouncement'

/** Shown at the top of every page while an announcement is live; "Dismiss" hides that message in this browser. */
export function AnnouncementBanner() {
  const q = useQuery({
    queryKey: ['announcement'],
    queryFn: () => api.get<Announcement | null>('/announcement'),
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  })
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED)
    } catch {
      return null
    }
  })
  const a = q.data
  if (!a || a.id === dismissed) return null
  return (
    <BannerBody
      level={a.level}
      text={a.text}
      onDismiss={() => {
        setDismissed(a.id)
        try {
          localStorage.setItem(DISMISSED, a.id)
        } catch {
          /* private mode: hidden until reload */
        }
      }}
    />
  )
}

// ---------------------------------------------------------------- self sign-up (ALLOW_SIGNUP)

interface SignupState {
  /** ALLOW_SIGNUP in the server's configuration */
  enabled: boolean
  approval: 'review' | 'auto'
  can_create_boards: boolean
  can_email: boolean
  waiting: { id: string; username: string; display_name: string; email: string | null; signed_up_at: string | null }[]
  unconfirmed: number
}

export function useSignups(enabled = true) {
  return useQuery({ queryKey: ['admin-signups'], queryFn: () => api.get<SignupState>('/admin/signups'), enabled })
}

/** Admin → Users, on top: sign-up settings and the people waiting for approval. */
export function SignupPanel() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: s } = useSignups()
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin-signups'] })
    qc.invalidateQueries({ queryKey: ['admin-users'] })
    qc.invalidateQueries({ queryKey: ['notifications'] })
  }
  const save = useMutation({
    mutationFn: (change: Partial<Pick<SignupState, 'approval' | 'can_create_boards'>>) =>
      api.put<SignupState>('/admin/signups', { approval: s!.approval, can_create_boards: s!.can_create_boards, ...change }),
    onSuccess: (r) => (qc.setQueryData(['admin-signups'], r), toastSuccess(t('common.saved'))),
    onError: toastError,
  })
  const decide = useMutation({
    mutationFn: ({ ids, approve }: { ids: string[]; approve: boolean }) =>
      api.post<{ approved?: number; rejected?: number }>(`/admin/signups/${approve ? 'approve' : 'reject'}`, { ids }),
    onSuccess: (r) => {
      refresh()
      toastSuccess(r.approved !== undefined ? t('signup.approved', { count: r.approved }) : t('signup.rejected', { count: r.rejected ?? 0 }))
    },
    onError: toastError,
  })
  if (!s) return null
  if (!s.enabled) return null
  const all = s.waiting.map((w) => w.id)
  const reject = async (ids: string[], name?: string) => {
    const ok = await ask({
      title: name ? t('signup.rejectOneTitle', { name }) : t('signup.rejectAllTitle', { count: ids.length }),
      message: t('signup.rejectMsg'),
      confirmLabel: t('signup.reject'),
      danger: true,
    })
    if (ok) decide.mutate({ ids, approve: false })
  }
  return (
    <section className="mb-5 space-y-3 rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="flex items-center gap-1.5 font-semibold">
          <UserPlus size={16} /> {t('signup.adminTitle')}
        </h2>
        <label className="flex items-center gap-2 text-sm">
          {t('signup.approval')}
          <select
            value={s.approval}
            disabled={save.isPending}
            onChange={(e) => save.mutate({ approval: e.target.value as SignupState['approval'] })}
            className="h-8 rounded-md border border-line bg-surface px-2 text-sm"
          >
            <option value="review">{t('signup.review')}</option>
            <option value="auto">{t('signup.auto')}</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={s.can_create_boards}
            disabled={save.isPending}
            onChange={(e) => save.mutate({ can_create_boards: e.target.checked })}
            className="accent-[var(--color-accent)]"
          />
          {t('signup.canCreateBoards')}
        </label>
      </div>
      <p className="text-xs text-muted">
        {s.can_email ? t('signup.emailOn') : t('signup.emailOff')}
        {s.unconfirmed > 0 && ` ${t('signup.unconfirmed', { count: s.unconfirmed })}`}
        {s.approval === 'auto' && s.waiting.length > 0 && ` ${t('signup.autoKeepsWaiting')}`}
      </p>
      {s.waiting.length === 0 ? (
        s.approval === 'review' && <p className="text-sm text-muted">{t('signup.noneWaiting')}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{t('signup.waitingCount', { count: s.waiting.length })}</span>
            {s.waiting.length > 1 && (
              <>
                <Button size="sm" variant="primary" disabled={decide.isPending} onClick={() => decide.mutate({ ids: all, approve: true })}>
                  <CheckCircle2 size={13} /> {t('signup.approveAll')}
                </Button>
                <Button size="sm" disabled={decide.isPending} onClick={() => reject(all)}>
                  <XCircle size={13} /> {t('signup.rejectAll')}
                </Button>
              </>
            )}
          </div>
          <ul className="max-h-80 divide-y divide-[var(--border)] overflow-y-auto rounded-lg border border-line">
            {s.waiting.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">
                    {w.display_name} <span className="font-normal text-muted">@{w.username}</span>
                  </div>
                  <div className="truncate text-xs text-muted">
                    {w.email} {w.signed_up_at && `· ${fmtRelative(w.signed_up_at)}`}
                  </div>
                </div>
                <Button size="sm" variant="primary" disabled={decide.isPending} onClick={() => decide.mutate({ ids: [w.id], approve: true })}>
                  {t('signup.approve')}
                </Button>
                <Button size="sm" disabled={decide.isPending} onClick={() => reject([w.id], w.display_name)}>
                  {t('signup.reject')}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
