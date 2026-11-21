import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Bell, Copy, Dices, Eye, EyeOff, KeyRound, Mail, Pencil, Plus, Search, Send, ShieldCheck, ShieldOff, Trash2, Users } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useSearchParams } from 'react-router'
import { NotificationsAdminTab } from '../components/ContactPoints'
import { ask } from '../components/dialogs'
import { toast, toastError, toastSuccess } from '../components/toast'
import { Avatar, Button, Dialog, Field, Input, Spinner, Toggle } from '../components/ui'
import { api } from '../lib/api'
import { useMe } from '../lib/auth'
import { generatePassword } from '../lib/password'
import { fmtDate } from '../lib/prefs'
import type { User } from '../lib/types'
import { avatarUrl, label } from '../lib/user'

const useEmailEnabled = () =>
  useQuery({ queryKey: ['auth-options'], queryFn: () => api.get<{ email_enabled: boolean }>('/auth/options') }).data?.email_enabled ?? false

/** Super-admin area: users (the only way accounts are created; there is no sign-up) and email setup. */
export function Admin() {
  const { t } = useTranslation()
  const { data: me } = useMe()
  const [sp, setSp] = useSearchParams()
  const tab = sp.get('tab') === 'email' ? 'email' : sp.get('tab') === 'notifications' ? 'notifications' : 'users'
  if (!me?.is_super_admin) return <Navigate to="/" replace />
  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="mb-5 flex items-center gap-1 border-b border-line">
        {(['users', 'email', 'notifications'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setSp(k === 'users' ? {} : { tab: k })}
            className={clsx(
              '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium cursor-pointer',
              tab === k ? 'border-accent text-[var(--text)]' : 'border-transparent text-muted hover:text-[var(--text)]',
            )}
          >
            {k === 'users' ? <Users size={15} /> : k === 'email' ? <Mail size={15} /> : <Bell size={15} />}
            {t(k === 'users' ? 'admin.title' : k === 'email' ? 'email.title' : 'notifications.title')}
          </button>
        ))}
      </div>
      {tab === 'users' ? <UsersTab me={me} /> : tab === 'email' ? <EmailTab me={me} /> : <NotificationsAdminTab />}
    </div>
  )
}

function UsersTab({ me }: { me: User }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const [resetting, setResetting] = useState<User | null>(null)
  const [editing, setEditing] = useState<User | null>(null)
  const [deleting, setDeleting] = useState<User | null>(null)
  const list = useQuery({ queryKey: ['admin-users'], queryFn: () => api.get<User[]>('/admin/users') })
  const update = useMutation({
    mutationFn: (p: Partial<User> & { id: string }) => api.patch(`/admin/users/${p.id}`, p),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
    onError: toastError,
  })
  // substring match on name / username / email (works for Thai)
  const f = q.trim().toLowerCase().replace(/^@/, '')
  const users = (list.data ?? []).filter((u) => !f || `${u.display_name} ${u.username} ${u.email ?? ''}`.toLowerCase().includes(f))

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search size={15} className="absolute left-2.5 top-2.5 text-muted" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('admin.search')} className="pl-8" />
        </div>
        <span className="text-sm text-muted">{t('admin.count', { count: users.length })}</span>
        <Button variant="primary" className="ml-auto" onClick={() => setCreating(true)}>
          <Plus size={16} /> {t('admin.newUser')}
        </Button>
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="p-3 font-medium">{t('admin.displayName')}</th>
                <th className="p-3 font-medium">{t('admin.superAdmin')}</th>
                <th className="p-3 font-medium">{t('admin.canCreateBoards')}</th>
                <th className="p-3 font-medium">{t('admin.active')}</th>
                <th className="p-3 font-medium">{t('card.created')}</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-line last:border-0">
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <Avatar name={label(u)} color={u.avatar_color} src={avatarUrl(u.avatar_id)} size={28} />
                      <div className="min-w-0">
                        <div className="font-medium">
                          {u.display_name}
                          {u.id === me.id && <span className="ml-1 text-xs text-muted">({t('admin.you')})</span>}
                          {u.must_change_password && (
                            <span className="ml-1.5 rounded bg-amber-500/15 px-1.5 py-px text-[10px] font-medium text-amber-700 dark:text-amber-400">
                              {t('admin.mustChange')}
                            </span>
                          )}
                          {u.totp_enabled && (
                            <span title={t('twofa.on')} className="ml-1.5 inline-flex items-center gap-0.5 rounded bg-green-500/15 px-1.5 py-px align-middle text-[10px] font-medium text-green-700 dark:text-green-400">
                              <ShieldCheck size={10} /> 2FA
                            </span>
                          )}
                        </div>
                        <div className="truncate text-xs text-muted">
                          @{u.username}
                          {u.email && ` · ${u.email}`}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="p-3">
                    <Toggle checked={u.is_super_admin} disabled={u.id === me.id} onChange={(v) => update.mutate({ id: u.id, is_super_admin: v })} />
                  </td>
                  <td className="p-3">
                    <Toggle checked={u.can_create_boards} onChange={(v) => update.mutate({ id: u.id, can_create_boards: v })} />
                  </td>
                  <td className="p-3">
                    <Toggle checked={u.is_active} disabled={u.id === me.id} onChange={(v) => update.mutate({ id: u.id, is_active: v })} />
                  </td>
                  <td className="p-3 text-xs text-muted">{fmtDate(u.created_at)}</td>
                  <td className="p-3">
                    <div className="flex justify-end gap-0.5">
                      <IconBtn title={t('common.edit')} onClick={() => setEditing(u)}>
                        <Pencil size={15} />
                      </IconBtn>
                      <IconBtn title={t('admin.resetPassword')} onClick={() => setResetting(u)}>
                        <KeyRound size={15} />
                      </IconBtn>
                      {u.totp_enabled && (
                        <IconBtn
                          title={t('twofa.adminReset')}
                          onClick={async () => {
                            if (!(await ask({ title: t('twofa.adminReset'), message: t('twofa.adminResetMsg', { name: label(u) }), confirmLabel: t('twofa.adminResetBtn'), danger: true }))) return
                            api.del(`/admin/users/${u.id}/2fa`).then(() => {
                              qc.invalidateQueries({ queryKey: ['admin-users'] })
                              toastSuccess(t('twofa.adminResetDone', { name: label(u) }))
                            }, toastError)
                          }}
                        >
                          <ShieldOff size={15} />
                        </IconBtn>
                      )}
                      {u.id !== me.id && (
                        <IconBtn title={t('admin.deleteUser')} danger onClick={() => setDeleting(u)}>
                          <Trash2 size={15} />
                        </IconBtn>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-6 text-center text-muted">
                    {t('search.noResults')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {creating && <CreateUser onClose={() => setCreating(false)} />}
      {resetting && <ResetPassword user={resetting} onClose={() => setResetting(null)} />}
      {editing && <EditUser user={editing} onClose={() => setEditing(null)} />}
      {deleting && <DeleteUser user={deleting} onClose={() => setDeleting(null)} />}
    </>
  )
}

function IconBtn({ title, onClick, danger, children }: { title: string; onClick: () => void; danger?: boolean; children: ReactNode }) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className={clsx(
        'rounded-md p-1.5 text-muted cursor-pointer',
        danger ? 'hover:bg-red-500/10 hover:text-red-600' : 'hover:bg-black/5 hover:text-[var(--text)] dark:hover:bg-white/10',
      )}
    >
      {children}
    </button>
  )
}

function copy(text: string, done: string) {
  navigator.clipboard?.writeText(text).then(() => toast(done), () => toast(text))
}

/** Password input with show/hide, generate and copy. */
function PasswordField({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const { t } = useTranslation()
  const [show, setShow] = useState(false)
  return (
    <div className="flex gap-1">
      <div className="relative flex-1">
        <Input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
          minLength={8}
          autoFocus={autoFocus}
          autoComplete="new-password"
          className="pr-8 font-mono"
        />
        <button type="button" onClick={() => setShow(!show)} className="absolute right-2 top-2.5 text-muted cursor-pointer" aria-label={t('admin.showPassword')}>
          {show ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
      <Button
        type="button"
        title={t('admin.generate')}
        onClick={() => {
          onChange(generatePassword())
          setShow(true)
        }}
      >
        <Dices size={15} /> <span className="hidden sm:inline">{t('admin.generate')}</span>
      </Button>
      <Button type="button" title={t('admin.copy')} disabled={!value} onClick={() => copy(value, t('menu.copied'))}>
        <Copy size={15} />
      </Button>
    </div>
  )
}

type CreateResult = { user: User; invite: { sent: boolean; error?: string } | null }

function CreateUser({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const emailEnabled = useEmailEnabled()
  const [f, setF] = useState(() => ({
    username: '',
    display_name: '',
    email: '',
    password: generatePassword(),
    is_super_admin: false,
    can_create_boards: true,
    locale: i18n.language === 'th' ? 'th' : 'en',
    send_invite: true,
  }))
  const [result, setResult] = useState<CreateResult | null>(null)
  const canInvite = emailEnabled && !!f.email.trim()
  const m = useMutation({
    mutationFn: () => api.post<CreateResult>('/admin/users', { ...f, send_invite: f.send_invite && canInvite }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['admin-users'] })
      qc.invalidateQueries({ queryKey: ['users'] })
      setResult(r)
    },
    onError: toastError,
  })
  if (result) return <Created result={result} password={f.password} onClose={onClose} />
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('admin.newUser')}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault()
          m.mutate()
        }}
        className="space-y-3 p-5"
      >
        <Field label={t('auth.username')}>
          <Input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} required autoFocus autoComplete="off" />
        </Field>
        <Field label={t('admin.displayName')}>
          <Input value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} />
        </Field>
        <Field label={t('admin.email')} hint={t('admin.emailHint')}>
          <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="off" />
        </Field>
        <Field label={t('auth.password')} hint={t('admin.passwordHint')}>
          <PasswordField value={f.password} onChange={(password) => setF({ ...f, password })} />
        </Field>
        <label className={clsx('flex items-start gap-2 text-sm', !canInvite && 'opacity-60')}>
          <input
            type="checkbox"
            checked={f.send_invite && canInvite}
            disabled={!canInvite}
            onChange={(e) => setF({ ...f, send_invite: e.target.checked })}
            className="mt-1 accent-[var(--color-accent)]"
          />
          <span>
            {t('admin.sendInvite')}
            <span className="block text-xs text-muted">{emailEnabled ? t('admin.sendInviteHint') : t('admin.emailNotSetUp')}</span>
          </span>
        </label>
        <Field label={t('nav.language')} hint={t('admin.languageHint')}>
          <select value={f.locale} onChange={(e) => setF({ ...f, locale: e.target.value })} className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm">
            <option value="en">English</option>
            <option value="th">ไทย</option>
          </select>
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.can_create_boards} onChange={(e) => setF({ ...f, can_create_boards: e.target.checked })} className="accent-[var(--color-accent)]" />
          {t('admin.canCreateBoards')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.is_super_admin} onChange={(e) => setF({ ...f, is_super_admin: e.target.checked })} className="accent-[var(--color-accent)]" />
          {t('admin.superAdmin')}
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={m.isPending}>
            {t('common.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

/** After creating: the sign-in details to hand over (the password is only ever shown here). */
function Created({ result, password, onClose }: { result: CreateResult; password: string; onClose: () => void }) {
  const { t } = useTranslation()
  const u = result.user
  const details = `${t('admin.signInAt')}: ${location.origin}/login\n${t('auth.username')}: ${u.username}\n${t('auth.password')}: ${password}`
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('admin.userCreated', { name: label(u) })}>
      <div className="space-y-4 p-5 text-sm">
        {result.invite?.sent && (
          <p className="flex gap-2 rounded-md bg-green-500/10 p-2.5 text-green-700 dark:text-green-400">
            <Send size={16} className="mt-0.5 shrink-0" /> {t('admin.inviteSent', { email: u.email })}
          </p>
        )}
        {result.invite && !result.invite.sent && (
          <p className="rounded-md bg-red-500/10 p-2.5 text-red-700 dark:text-red-400">
            {t('admin.inviteFailed')}: {result.invite.error}
          </p>
        )}
        <p className="text-muted">{t('admin.handOver')}</p>
        <pre className="whitespace-pre-wrap rounded-md border border-line bg-surface-2 p-3 font-mono text-xs">{details}</pre>
        <p className="text-xs text-muted">{t('admin.mustChangeHint')}</p>
        <div className="flex justify-end gap-2">
          <Button onClick={() => copy(details, t('menu.copied'))}>
            <Copy size={14} /> {t('admin.copyDetails')}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t('common.done')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function ResetPassword({ user, onClose }: { user: User; onClose: () => void }) {
  const { t } = useTranslation()
  const emailEnabled = useEmailEnabled()
  const qc = useQueryClient()
  const [pw, setPw] = useState(() => generatePassword())
  const m = useMutation({
    mutationFn: () => api.post(`/admin/users/${user.id}/password`, { password: pw }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] })
      copy(pw, t('admin.passwordCopied'))
      toastSuccess(t('admin.passwordReset', { name: label(user) }))
      onClose()
    },
    onError: toastError,
  })
  const sendLink = useMutation({
    mutationFn: () => api.post<{ sent: boolean; error?: string }>(`/admin/users/${user.id}/send-reset`),
    onSuccess: (r) => {
      if (r.sent) {
        toastSuccess(t('admin.resetLinkSent', { email: user.email }))
        onClose()
      } else toast(`${t('admin.inviteFailed')}: ${r.error}`, 'error')
    },
    onError: toastError,
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`${t('admin.resetPassword')}: ${label(user)}`}>
      <div className="space-y-4 p-5">
        {emailEnabled && user.email && (
          <div className="space-y-2 rounded-lg border border-line p-3">
            <p className="text-sm">{t('admin.emailLinkHint', { email: user.email })}</p>
            <Button onClick={() => sendLink.mutate()} disabled={sendLink.isPending}>
              <Send size={14} /> {t('admin.emailResetLink')}
            </Button>
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            m.mutate()
          }}
          className="space-y-3"
        >
          <Field label={t('admin.newPassword')} hint={t('admin.mustChangeHint')}>
            <PasswordField value={pw} onChange={setPw} autoFocus />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" disabled={m.isPending}>
              {t('admin.setPassword')}
            </Button>
          </div>
        </form>
      </div>
    </Dialog>
  )
}

function EditUser({ user, onClose }: { user: User; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [name, setName] = useState(user.display_name)
  const [email, setEmail] = useState(user.email ?? '')
  const m = useMutation({
    mutationFn: () => api.patch(`/admin/users/${user.id}`, { display_name: name, email }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] })
      qc.invalidateQueries({ queryKey: ['me'] })
      toastSuccess(t('common.saved'))
      onClose()
    },
    onError: toastError,
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`${t('common.edit')}: @${user.username}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          m.mutate()
        }}
        className="space-y-3 p-5"
      >
        <Field label={t('admin.displayName')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </Field>
        <Field label={t('admin.email')} hint={t('admin.emailHint')}>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={m.isPending}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

interface Impact {
  id: string
  name: string
  card_count: number
}

/** Shows exactly what deleting will do before it happens. */
function DeleteUser({ user, onClose }: { user: User; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [typed, setTyped] = useState('')
  const preview = useQuery({
    queryKey: ['delete-preview', user.id],
    queryFn: () => api.get<{ deleted: Impact[]; new_owner: Impact[]; removed_from: number }>(`/admin/users/${user.id}/delete-preview`),
  })
  const m = useMutation({
    mutationFn: () => api.del(`/admin/users/${user.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] })
      qc.invalidateQueries({ queryKey: ['boards'] })
      qc.invalidateQueries({ queryKey: ['users'] })
      toastSuccess(t('admin.userDeleted', { name: label(user) }))
      onClose()
    },
    onError: toastError,
  })
  const p = preview.data
  const ok = typed.trim().toLowerCase() === 'delete'
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`${t('admin.deleteUser')}: ${label(user)}`}>
      <form
        className="space-y-4 p-5 text-sm"
        onSubmit={(e) => {
          e.preventDefault()
          if (ok) m.mutate()
        }}
      >
        {!p ? (
          <Spinner />
        ) : (
          <>
            <div>
              <div className="mb-1 font-medium">{t('admin.delBoardsDeleted', { count: p.deleted.length })}</div>
              {p.deleted.length ? (
                <ul className="list-disc space-y-0.5 pl-5 text-muted">
                  {p.deleted.map((b) => (
                    <li key={b.id}>
                      {b.name} <span className="text-xs">· {t('boards.cards', { count: b.card_count })}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted">—</p>
              )}
            </div>
            {p.new_owner.length > 0 && (
              <div>
                <div className="mb-1 font-medium">{t('admin.delNewOwner', { count: p.new_owner.length })}</div>
                <ul className="list-disc space-y-0.5 pl-5 text-muted">
                  {p.new_owner.map((b) => (
                    <li key={b.id}>{b.name}</li>
                  ))}
                </ul>
              </div>
            )}
            {p.removed_from > 0 && <p className="text-muted">{t('admin.delRemovedFrom', { count: p.removed_from })}</p>}
            <p className="rounded-md bg-black/5 p-2.5 text-xs text-muted dark:bg-white/5">
              {t('admin.delHistory', { label: `[Deleted User] ${user.display_name} (${user.username})` })}
            </p>
          </>
        )}
        <label className="block space-y-1">
          <span className="text-muted">{t('confirm.typeToConfirm', { text: 'Delete' })}</span>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Delete" autoFocus />
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" disabled={!p || !ok || m.isPending}>
            <Trash2 size={14} /> {t('admin.deleteUser')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

interface EmailSettings {
  enabled: boolean
  host: string
  port: number
  security: 'starttls' | 'tls' | 'none'
  username: string
  from_email: string
  from_name: string
  public_url: string
  has_password: boolean
  default_public_url: string
}

/** SMTP setup for outgoing email (welcome links, password resets). */
function EmailTab({ me }: { me: User }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['email-settings'], queryFn: () => api.get<EmailSettings>('/admin/email') })
  if (!q.data) return <Spinner />
  return (
    <EmailForm
      initial={q.data}
      me={me}
      onSaved={() => {
        qc.invalidateQueries({ queryKey: ['email-settings'] })
        qc.invalidateQueries({ queryKey: ['auth-options'] })
      }}
    />
  )
}

function EmailForm({ initial, me, onSaved }: { initial: EmailSettings; me: User; onSaved: () => void }) {
  const { t } = useTranslation()
  const [f, setF] = useState(initial)
  const [password, setPassword] = useState('')
  const [testTo, setTestTo] = useState(me.email ?? '')
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null)
  const set = (p: Partial<EmailSettings>) => setF({ ...f, ...p })
  const save = useMutation({
    mutationFn: () =>
      api.put('/admin/email', {
        enabled: f.enabled,
        host: f.host,
        port: Number(f.port) || 587,
        security: f.security,
        username: f.username,
        password: password ? password : undefined, // left empty = keep the stored password
        from_email: f.from_email,
        from_name: f.from_name,
        public_url: f.public_url,
      }),
    onSuccess: () => {
      setPassword('')
      toastSuccess(t('common.saved'))
      onSaved()
    },
    onError: toastError,
  })
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; error?: string }>('/admin/email/test', { to: testTo }),
    onSuccess: setTestResult,
    onError: toastError,
  })
  return (
    <div className="max-w-xl space-y-6">
      <p className="text-sm text-muted">{t('email.intro')}</p>
      <form
        className="space-y-4 rounded-xl border border-line bg-surface p-5"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        <label className="flex items-center gap-2 text-sm font-medium">
          <Toggle checked={f.enabled} onChange={(v) => set({ enabled: v })} />
          {t('email.enabled')}
        </label>
        <div className="grid grid-cols-[1fr_100px] gap-3">
          <Field label={t('email.host')}>
            <Input value={f.host} onChange={(e) => set({ host: e.target.value })} placeholder="smtp.gmail.com" />
          </Field>
          <Field label={t('email.port')}>
            <Input type="number" value={f.port} onChange={(e) => set({ port: Number(e.target.value) })} />
          </Field>
        </div>
        <Field label={t('email.security')}>
          <select
            value={f.security}
            onChange={(e) => {
              const security = e.target.value as EmailSettings['security']
              set({ security, port: security === 'tls' ? 465 : security === 'starttls' ? 587 : f.port })
            }}
            className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm"
          >
            <option value="starttls">STARTTLS (587)</option>
            <option value="tls">SSL/TLS (465)</option>
            <option value="none">{t('email.noEncryption')}</option>
          </select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('email.username')}>
            <Input value={f.username} onChange={(e) => set({ username: e.target.value })} autoComplete="off" />
          </Field>
          <Field label={t('auth.password')} hint={f.has_password ? t('email.passwordKept') : undefined}>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              placeholder={f.has_password ? '••••••••' : ''}
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('email.fromEmail')}>
            <Input type="email" value={f.from_email} onChange={(e) => set({ from_email: e.target.value })} placeholder="kanban@example.com" />
          </Field>
          <Field label={t('email.fromName')}>
            <Input value={f.from_name} onChange={(e) => set({ from_name: e.target.value })} placeholder="Kanban" />
          </Field>
        </div>
        <Field label={t('email.publicUrl')} hint={t('email.publicUrlHint')}>
          <Input value={f.public_url} onChange={(e) => set({ public_url: e.target.value })} placeholder={f.default_public_url} />
        </Field>
        <p className="text-xs text-muted">{t('email.gmailHint')}</p>
        <Button variant="primary" disabled={save.isPending}>
          {t('common.save')}
        </Button>
      </form>
      <form
        className="space-y-3 rounded-xl border border-line bg-surface p-5"
        onSubmit={(e) => {
          e.preventDefault()
          setTestResult(null)
          test.mutate()
        }}
      >
        <h3 className="text-sm font-semibold">{t('email.test')}</h3>
        <p className="text-xs text-muted">{t('email.testHint')}</p>
        <div className="flex gap-2">
          <Input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} required placeholder="you@example.com" />
          <Button disabled={test.isPending} className="shrink-0 whitespace-nowrap">
            <Send size={14} /> {test.isPending ? t('email.sending') : t('email.sendTest')}
          </Button>
        </div>
        {testResult && (
          <p
            className={clsx(
              'rounded-md p-2.5 text-sm [overflow-wrap:anywhere]',
              testResult.ok ? 'bg-green-500/10 text-green-700 dark:text-green-400' : 'bg-red-500/10 text-red-700 dark:text-red-400',
            )}
          >
            {testResult.ok ? t('email.testOk', { to: testTo }) : `${t('email.testFailed')}: ${testResult.error}`}
          </p>
        )}
      </form>
    </div>
  )
}
