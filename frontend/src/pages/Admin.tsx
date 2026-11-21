import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Plus } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate } from 'react-router'
import { toast, toastError } from '../components/toast'
import { Avatar, Button, Dialog, Field, Input, Spinner } from '../components/ui'
import { api } from '../lib/api'
import { useMe } from '../lib/auth'
import { fmtDate } from '../lib/prefs'
import type { User } from '../lib/types'

/** Super-admin user management. This is the only way accounts are created (no sign-up). */
export function Admin() {
  const { t } = useTranslation()
  const { data: me } = useMe()
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [resetting, setResetting] = useState<User | null>(null)
  const q = useQuery({ queryKey: ['admin-users'], queryFn: () => api.get<User[]>('/admin/users'), enabled: !!me?.is_super_admin })
  const update = useMutation({
    mutationFn: (p: Partial<User> & { id: string }) => api.patch(`/admin/users/${p.id}`, p),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
    onError: toastError,
  })
  if (!me?.is_super_admin) return <Navigate to="/" replace />

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="mb-5 flex items-center">
        <h1 className="text-xl font-semibold">{t('admin.title')}</h1>
        <Button variant="primary" className="ml-auto" onClick={() => setCreating(true)}>
          <Plus size={16} /> {t('admin.newUser')}
        </Button>
      </div>
      {q.isLoading ? (
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
              {q.data?.map((u) => (
                <tr key={u.id} className="border-b border-line last:border-0">
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <Avatar name={u.display_name} color={u.avatar_color} size={28} />
                      <div>
                        <div className="font-medium">
                          {u.display_name}
                          {u.id === me.id && <span className="ml-1 text-xs text-muted">({t('admin.you')})</span>}
                        </div>
                        <div className="text-xs text-muted">
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
                  <td className="p-3 text-right">
                    <Button variant="ghost" size="sm" onClick={() => setResetting(u)}>
                      <KeyRound size={14} /> {t('admin.resetPassword')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <CreateUser open={creating} onOpenChange={setCreating} />
      {resetting && <ResetPassword user={resetting} onClose={() => setResetting(null)} />}
    </div>
  )
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-40 cursor-pointer ${checked ? 'bg-accent' : 'bg-zinc-300 dark:bg-zinc-600'}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${checked ? 'left-4.5' : 'left-0.5'}`} />
    </button>
  )
}

function CreateUser({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const empty = { username: '', display_name: '', email: '', password: '', is_super_admin: false, can_create_boards: true }
  const [f, setF] = useState(empty)
  const m = useMutation({
    mutationFn: () => api.post('/admin/users', f),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] })
      qc.invalidateQueries({ queryKey: ['users'] })
      setF(empty)
      onOpenChange(false)
    },
    onError: toastError,
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    m.mutate()
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('admin.newUser')}>
      <form onSubmit={submit} className="space-y-3 p-5">
        <Field label={t('auth.username')}>
          <Input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} required autoFocus autoComplete="off" />
        </Field>
        <Field label={t('admin.displayName')}>
          <Input value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} />
        </Field>
        <Field label={t('admin.email')}>
          <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
        <Field label={t('auth.password')} hint={t('errors.password_too_short')}>
          <Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={8} autoComplete="new-password" />
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
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
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

function ResetPassword({ user, onClose }: { user: User; onClose: () => void }) {
  const { t } = useTranslation()
  const [pw, setPw] = useState('')
  const m = useMutation({
    mutationFn: () => api.post(`/admin/users/${user.id}/password`, { password: pw }),
    onSuccess: () => (toast(t('common.saved')), onClose()),
    onError: toastError,
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`${t('admin.resetPassword')}: ${user.display_name}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          m.mutate()
        }}
        className="space-y-3 p-5"
      >
        <Field label={t('admin.newPassword')} hint={t('errors.password_too_short')}>
          <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={8} autoFocus autoComplete="new-password" />
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
