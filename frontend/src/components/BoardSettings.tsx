import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { api } from '../lib/api'
import { useMe } from '../lib/auth'
import type { BoardHelpers } from '../lib/board'
import type { Role, UserBrief } from '../lib/types'
import { toast, toastError } from './toast'
import { Avatar, Button, ColorPicker, Dialog, Field, Input } from './ui'

type Tab = 'general' | 'members' | 'roles' | 'labels'

export function BoardSettings({
  open,
  onOpenChange,
  b,
  boardId,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  b: BoardHelpers
  boardId: string
}) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('general')
  if (!b.data) return null
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('settings.title')} wide>
      <div className="flex flex-col sm:flex-row">
        <nav className="flex gap-1 border-b border-line p-2 sm:w-48 sm:flex-col sm:border-b-0 sm:border-r">
          {(['general', 'members', 'roles', 'labels'] as Tab[]).map((k) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={clsx(
                'rounded-md px-3 py-1.5 text-left text-sm cursor-pointer',
                tab === k ? 'bg-black/5 font-medium dark:bg-white/10' : 'text-muted hover:bg-black/5 dark:hover:bg-white/5',
              )}
            >
              {t(`settings.${k}`)}
            </button>
          ))}
        </nav>
        <div className="min-h-[420px] flex-1 p-5">
          {tab === 'general' && <General b={b} boardId={boardId} onClose={() => onOpenChange(false)} />}
          {tab === 'members' && <Members b={b} boardId={boardId} />}
          {tab === 'roles' && <Roles b={b} boardId={boardId} />}
          {tab === 'labels' && <Labels b={b} boardId={boardId} />}
        </div>
      </div>
    </Dialog>
  )
}

function useRefresh(boardId: string) {
  const qc = useQueryClient()
  return () => {
    qc.invalidateQueries({ queryKey: ['board', boardId] })
    qc.invalidateQueries({ queryKey: ['boards'] })
  }
}

function General({ b, boardId, onClose }: { b: BoardHelpers; boardId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const nav = useNavigate()
  const refresh = useRefresh(boardId)
  const board = b.data!.board
  const [name, setName] = useState(board.name)
  const [description, setDescription] = useState(board.description)
  const [color, setColor] = useState<string | null>(board.color)
  const can = b.can('board.manage')
  const save = useMutation({
    mutationFn: () => api.patch(`/boards/${boardId}`, { name, description, color }),
    onSuccess: () => (refresh(), toast(t('common.saved'))),
    onError: toastError,
  })
  const del = useMutation({
    mutationFn: () => api.del(`/boards/${boardId}`),
    onSuccess: () => (refresh(), onClose(), nav('/')),
    onError: toastError,
  })
  return (
    <div className="max-w-md space-y-4">
      <Field label={t('common.name')}>
        <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!can} />
      </Field>
      <Field label={t('common.description')}>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={!can}
          rows={3}
          className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-accent/60"
        />
      </Field>
      <Field label={t('common.color')}>
        <ColorPicker value={color} onChange={(c) => can && setColor(c)} />
      </Field>
      {can && (
        <Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>
          {t('common.save')}
        </Button>
      )}
      {b.can('board.delete') && (
        <div className="border-t border-line pt-4">
          <Button variant="danger" onClick={() => confirm(t('settings.deleteBoardConfirm')) && del.mutate()}>
            <Trash2 size={14} /> {t('settings.deleteBoard')}
          </Button>
        </div>
      )}
    </div>
  )
}

function Members({ b, boardId }: { b: BoardHelpers; boardId: string }) {
  const { t } = useTranslation()
  const { data: me } = useMe()
  const nav = useNavigate()
  const refresh = useRefresh(boardId)
  const data = b.data!
  const can = b.can('members.manage')
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<UserBrief[]>('/users'), enabled: can })
  const defaultRole = data.roles.find((r) => r.name === 'Editor') ?? data.roles.find((r) => !r.is_owner) ?? data.roles[0]
  const [newUser, setNewUser] = useState('')
  const [newRole, setNewRole] = useState(defaultRole?.id ?? '')
  const add = useMutation({
    mutationFn: () => api.post(`/boards/${boardId}/members`, { user_id: newUser, role_id: newRole }),
    onSuccess: () => (setNewUser(''), refresh()),
    onError: toastError,
  })
  const update = useMutation({
    mutationFn: (p: { user_id: string; role_id: string }) => api.patch(`/boards/${boardId}/members/${p.user_id}`, p),
    onSuccess: refresh,
    onError: toastError,
  })
  const remove = useMutation({
    mutationFn: (user_id: string) => api.del(`/boards/${boardId}/members/${user_id}`),
    onSuccess: (_, user_id) => (user_id === me?.id && !me?.is_super_admin ? nav('/') : refresh()),
    onError: toastError,
  })
  const memberIds = new Set(data.members.map((m) => m.user_id))
  const candidates = (users.data ?? []).filter((u) => !memberIds.has(u.id))

  return (
    <div className="space-y-4">
      <div className="divide-y divide-[var(--border)] rounded-lg border border-line">
        {data.members.map((m) => (
          <div key={m.user_id} className="flex items-center gap-3 px-3 py-2">
            <Avatar name={m.display_name} color={m.avatar_color} size={28} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{m.display_name}</div>
              <div className="text-xs text-muted">@{m.username}</div>
            </div>
            <select
              value={m.role_id}
              disabled={!can}
              onChange={(e) => update.mutate({ user_id: m.user_id, role_id: e.target.value })}
              className="h-8 rounded-md border border-line bg-surface px-2 text-sm"
            >
              {data.roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            {(can || m.user_id === me?.id) && (
              <button
                title={m.user_id === me?.id ? t('settings.leave') : t('common.remove')}
                onClick={() => confirm(t('common.confirmDelete')) && remove.mutate(m.user_id)}
                className="rounded p-1.5 text-muted hover:bg-red-500/10 hover:text-red-600 cursor-pointer"
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>
        ))}
      </div>
      {can && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t('settings.addMember')}>
            <select value={newUser} onChange={(e) => setNewUser(e.target.value)} className="h-9 min-w-48 rounded-md border border-line bg-surface px-2 text-sm">
              <option value="">—</option>
              {candidates.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.display_name} (@{u.username})
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('settings.role')}>
            <select value={newRole} onChange={(e) => setNewRole(e.target.value)} className="h-9 rounded-md border border-line bg-surface px-2 text-sm">
              {data.roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <Button variant="primary" disabled={!newUser || add.isPending} onClick={() => add.mutate()}>
            <Plus size={14} /> {t('common.add')}
          </Button>
        </div>
      )}
    </div>
  )
}

function Roles({ b, boardId }: { b: BoardHelpers; boardId: string }) {
  const { t } = useTranslation()
  const refresh = useRefresh(boardId)
  const data = b.data!
  const can = b.can('members.manage')
  const [newName, setNewName] = useState('')
  const create = useMutation({
    mutationFn: () => api.post(`/boards/${boardId}/roles`, { name: newName, permissions: ['comments.create'] }),
    onSuccess: () => (setNewName(''), refresh()),
    onError: toastError,
  })
  const update = useMutation({
    mutationFn: (r: Partial<Role> & { id: string }) => api.patch(`/roles/${r.id}`, { name: r.name, permissions: r.permissions }),
    onSuccess: refresh,
    onError: toastError,
  })
  const del = useMutation({ mutationFn: (id: string) => api.del(`/roles/${id}`), onSuccess: refresh, onError: toastError })

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="p-2 font-medium" />
              {data.roles.map((r) => (
                <th key={r.id} className="p-2 text-center font-medium">
                  <div className="flex items-center justify-center gap-1">
                    {r.name}
                    {can && !r.is_owner && (
                      <button onClick={() => confirm(t('common.confirmDelete')) && del.mutate(r.id)} className="text-muted hover:text-red-600 cursor-pointer">
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.all_permissions.map((p) => (
              <tr key={p} className="border-b border-line last:border-0">
                <td className="p-2">
                  {t(`perm.${p}`)}
                  <div className="text-[10px] text-muted">{p}</div>
                </td>
                {data.roles.map((r) => (
                  <td key={r.id} className="p-2 text-center">
                    <input
                      type="checkbox"
                      checked={r.is_owner || r.permissions.includes(p)}
                      disabled={!can || r.is_owner}
                      onChange={(e) =>
                        update.mutate({
                          id: r.id,
                          permissions: e.target.checked ? [...r.permissions, p] : r.permissions.filter((x) => x !== p),
                        })
                      }
                      className="h-4 w-4 accent-[var(--color-accent)]"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">{t('settings.owner')}</p>
      {can && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (newName.trim()) create.mutate()
          }}
        >
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('settings.newRole')} className="max-w-xs" />
          <Button variant="primary">
            <Plus size={14} /> {t('common.create')}
          </Button>
        </form>
      )}
    </div>
  )
}

function Labels({ b, boardId }: { b: BoardHelpers; boardId: string }) {
  const { t } = useTranslation()
  const refresh = useRefresh(boardId)
  const can = b.can('labels.manage')
  const [name, setName] = useState('')
  const [color, setColor] = useState<string | null>('#6366f1')
  const create = useMutation({
    mutationFn: () => api.post(`/boards/${boardId}/labels`, { name, color }),
    onSuccess: () => (setName(''), refresh()),
    onError: toastError,
  })
  const update = useMutation({
    mutationFn: (p: { id: string; name?: string; color?: string }) => api.patch(`/labels/${p.id}`, p),
    onSuccess: refresh,
    onError: toastError,
  })
  const del = useMutation({ mutationFn: (id: string) => api.del(`/labels/${id}`), onSuccess: refresh, onError: toastError })
  return (
    <div className="max-w-lg space-y-4">
      <div className="space-y-2">
        {b.data!.labels.map((l) => (
          <div key={l.id} className="flex items-center gap-2">
            <span className="h-6 w-6 shrink-0 rounded" style={{ background: l.color }} />
            <Input
              defaultValue={l.name}
              disabled={!can}
              onBlur={(e) => e.currentTarget.value.trim() && e.currentTarget.value !== l.name && update.mutate({ id: l.id, name: e.currentTarget.value })}
              className="h-8"
            />
            {can && (
              <>
                <select
                  value={l.color}
                  onChange={(e) => update.mutate({ id: l.id, color: e.target.value })}
                  className="h-8 rounded-md border border-line bg-surface px-1 text-xs"
                  style={{ color: l.color }}
                >
                  {['#64748b', '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#0ea5e9', '#6366f1', '#a855f7', '#ec4899'].map((c) => (
                    <option key={c} value={c} style={{ color: c }}>
                      ●
                    </option>
                  ))}
                </select>
                <button onClick={() => confirm(t('common.confirmDelete')) && del.mutate(l.id)} className="rounded p-1.5 text-muted hover:text-red-600 cursor-pointer">
                  <Trash2 size={15} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
      {can && (
        <form
          className="space-y-2 border-t border-line pt-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) create.mutate()
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('settings.newLabel')} />
          <ColorPicker value={color} onChange={setColor} />
          <Button variant="primary">
            <Plus size={14} /> {t('common.create')}
          </Button>
        </form>
      )}
    </div>
  )
}
