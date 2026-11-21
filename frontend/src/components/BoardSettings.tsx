import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Plus, Search, Trash2 } from 'lucide-react'
import { ConfirmDialog } from './ConfirmDialog'
import { ask } from './dialogs'
import { fmtRelative } from '../lib/prefs'
import { avatarUrl, label } from '../lib/user'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { api } from '../lib/api'
import { useMe } from '../lib/auth'
import type { BoardHelpers } from '../lib/board'
import type { Role, UserBrief } from '../lib/types'
import { toast, toastError } from './toast'
import { Avatar, Button, ColorPicker, Dialog, Field, Input } from './ui'

type Tab = 'general' | 'members' | 'roles' | 'statuses' | 'labels' | 'archive'

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
          {(['general', 'members', 'roles', 'statuses', 'labels', 'archive'] as Tab[]).map((k) => (
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
          {tab === 'statuses' && <Statuses b={b} boardId={boardId} />}
          {tab === 'labels' && <Labels b={b} boardId={boardId} />}
          {tab === 'archive' && <ArchivedCards b={b} boardId={boardId} />}
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
  const [confirm, setConfirm] = useState<'archive' | 'purge' | null>(null)
  const archive = () => api.del(`/boards/${boardId}`).then(() => (refresh(), onClose(), nav('/')), toastError)
  const purge = () => api.del(`/boards/${boardId}/permanent`).then(() => (refresh(), onClose(), nav('/')), toastError)
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
        <div className="space-y-2 border-t border-line pt-4">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setConfirm('archive')}>
              <Archive size={14} /> {t('archive.archiveBoard')}
            </Button>
            <Button variant="danger" onClick={() => setConfirm('purge')}>
              <Trash2 size={14} /> {t('archive.deleteForever')}
            </Button>
          </div>
          <p className="text-xs text-muted">{t('archive.archiveVsDelete')}</p>
        </div>
      )}
      {confirm === 'archive' && (
        <ConfirmDialog
          title={t('archive.archiveBoard')}
          message={t('archive.archiveBoardMsg', { name: board.name })}
          confirmLabel={t('archive.archiveBoard')}
          danger={false}
          onConfirm={archive}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === 'purge' && (
        <ConfirmDialog
          title={t('archive.deleteForever')}
          message={t('archive.purgeBoardMsg', { name: board.name, cards: b.data!.cards.length })}
          confirmLabel={t('archive.deleteForever')}
          typeToConfirm="Delete"
          onConfirm={purge}
          onClose={() => setConfirm(null)}
        />
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
            <Avatar name={label(m)} color={m.avatar_color} src={avatarUrl(m.avatar_id)} size={28} />
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
                onClick={async () => (await ask({ title: m.user_id === me?.id ? t('settings.leave') : t('common.remove'), message: t('settings.removeMemberMsg', { name: label(m) }), confirmLabel: m.user_id === me?.id ? t('settings.leave') : t('common.remove'), danger: true })) && remove.mutate(m.user_id)}
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
                  {label(u)}
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
                      <button onClick={async () => (await ask({ title: t('common.delete'), message: t('settings.deleteRoleMsg', { name: r.name }), confirmLabel: t('common.delete'), danger: true })) && del.mutate(r.id)} className="text-muted hover:text-red-600 cursor-pointer">
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
                <button onClick={async () => (await ask({ title: t('common.delete'), message: t('settings.deleteLabelMsg', { name: l.name }), confirmLabel: t('common.delete'), danger: true })) && del.mutate(l.id)} className="rounded p-1.5 text-muted hover:text-red-600 cursor-pointer">
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

const COLORS = ['#a1a1aa', '#64748b', '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#0ea5e9', '#6366f1', '#a855f7', '#ec4899']

function Statuses({ b, boardId }: { b: BoardHelpers; boardId: string }) {
  const { t } = useTranslation()
  const refresh = useRefresh(boardId)
  const can = b.can('board.manage')
  const list = b.data!.statuses
  const [name, setName] = useState('')
  const [color, setColor] = useState<string | null>('#0ea5e9')
  const create = useMutation({
    mutationFn: () => api.post(`/boards/${boardId}/statuses`, { name, color }),
    onSuccess: () => (setName(''), refresh()),
    onError: toastError,
  })
  const update = useMutation({
    mutationFn: (p: { id: string; name?: string; color?: string; index?: number }) => api.patch(`/statuses/${p.id}`, p),
    onSuccess: refresh,
    onError: toastError,
  })
  const del = useMutation({ mutationFn: (id: string) => api.del(`/statuses/${id}`), onSuccess: refresh, onError: toastError })
  return (
    <div className="max-w-lg space-y-4">
      <p className="text-xs text-muted">{t('settings.statusHint')}</p>
      <div className="space-y-2">
        {list.map((st, i) => (
          <div key={st.id} className="flex items-center gap-2">
            <select
              value={st.color}
              disabled={!can}
              onChange={(e) => update.mutate({ id: st.id, color: e.target.value })}
              className="h-8 w-12 rounded-md border border-line bg-surface text-center text-lg"
              style={{ color: st.color }}
            >
              {[...new Set([st.color, ...COLORS])].map((c) => (
                <option key={c} value={c} style={{ color: c }}>
                  ●
                </option>
              ))}
            </select>
            <Input
              key={st.name}
              defaultValue={st.name}
              disabled={!can}
              onBlur={(e) => e.currentTarget.value.trim() && e.currentTarget.value !== st.name && update.mutate({ id: st.id, name: e.currentTarget.value })}
              className="h-8"
            />
            {can && (
              <>
                <button disabled={i === 0} onClick={() => update.mutate({ id: st.id, index: i - 1 })} className="rounded p-1.5 text-muted enabled:hover:bg-black/5 disabled:opacity-30 enabled:cursor-pointer dark:enabled:hover:bg-white/10">
                  <ArrowUp size={15} />
                </button>
                <button disabled={i === list.length - 1} onClick={() => update.mutate({ id: st.id, index: i + 1 })} className="rounded p-1.5 text-muted enabled:hover:bg-black/5 disabled:opacity-30 enabled:cursor-pointer dark:enabled:hover:bg-white/10">
                  <ArrowDown size={15} />
                </button>
                <button onClick={async () => (await ask({ title: t('common.delete'), message: t('settings.deleteStatusMsg', { name: st.name }), confirmLabel: t('common.delete'), danger: true })) && del.mutate(st.id)} className="rounded p-1.5 text-muted hover:text-red-600 cursor-pointer">
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
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('settings.newStatus')} />
          <ColorPicker value={color} onChange={setColor} />
          <Button variant="primary">
            <Plus size={14} /> {t('common.create')}
          </Button>
        </form>
      )}
    </div>
  )
}

interface ArchivedCard {
  id: string
  number: number
  title: string
  list_name: string
  archived_at: string
  archived_by: string | null
}

function ArchivedCards({ b, boardId }: { b: BoardHelpers; boardId: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [purging, setPurging] = useState<ArchivedCard | null>(null)
  const list = useQuery({ queryKey: ['archived-cards', boardId], queryFn: () => api.get<ArchivedCard[]>(`/boards/${boardId}/archived-cards`) })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['archived-cards', boardId] })
    qc.invalidateQueries({ queryKey: ['board', boardId] })
  }
  const restore = useMutation({ mutationFn: (id: string) => api.post(`/cards/${id}/restore`), onSuccess: () => (refresh(), toast(t('toast.restored'), 'success')), onError: toastError })
  const can = b.can('cards.delete')
  const f = q.trim().toLowerCase().replace(/^#/, '')
  const items = (list.data ?? []).filter((c) => !f || `${c.title} ${c.number} ${c.list_name}`.toLowerCase().includes(f))
  return (
    <div className="space-y-3">
      <ArchivedColumns b={b} boardId={boardId} />
      <h3 className="pt-2 text-sm font-semibold">{t('archive.cards')}</h3>
      <p className="text-xs text-muted">{t('archive.cardsHint')}</p>
      <div className="relative max-w-xs">
        <Search size={14} className="absolute left-2.5 top-2.5 text-muted" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search.filterCards')} className="h-8 pl-8" />
      </div>
      {list.data && items.length === 0 && <p className="text-sm text-muted">{t('archive.noCards')}</p>}
      <div className="divide-y divide-[var(--border)] rounded-lg border border-line">
        {items.map((c) => (
          <div key={c.id} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">
                <span className="text-muted">#{c.number}</span> {c.title}
              </div>
              <div className="text-xs text-muted">
                {c.list_name} · {t('archive.archivedAgo', { when: fmtRelative(c.archived_at) })}
                {c.archived_by && ` · ${c.archived_by}`}
              </div>
            </div>
            {can && (
              <>
                <Button size="sm" onClick={() => restore.mutate(c.id)}>
                  <ArchiveRestore size={13} /> {t('archive.restore')}
                </Button>
                <Button size="sm" variant="danger" onClick={() => setPurging(c)} title={t('archive.deleteForever')}>
                  <Trash2 size={13} />
                </Button>
              </>
            )}
          </div>
        ))}
      </div>
      {purging && (
        <ConfirmDialog
          title={t('archive.deleteForever')}
          message={t('archive.purgeCardMsg', { title: `#${purging.number} ${purging.title}` })}
          confirmLabel={t('archive.deleteForever')}
          onConfirm={() => api.del(`/cards/${purging.id}/permanent`).then(() => (refresh(), toast(t('toast.deleted'), 'success')), toastError)}
          onClose={() => setPurging(null)}
        />
      )}
    </div>
  )
}

interface ArchivedList {
  id: string
  name: string
  card_count: number
  archived_at: string
}

function ArchivedColumns({ b, boardId }: { b: BoardHelpers; boardId: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['archived-lists', boardId], queryFn: () => api.get<ArchivedList[]>(`/boards/${boardId}/archived-lists`) })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['archived-lists', boardId] })
    qc.invalidateQueries({ queryKey: ['board', boardId] })
  }
  const run = useMutation({
    mutationFn: (p: { f: () => Promise<unknown>; msg: string }) => p.f(),
    onSuccess: (_, p) => (refresh(), toast(p.msg, 'success')),
    onError: toastError,
  })
  const can = b.can('lists.manage')
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{t('archive.columns')}</h3>
      {list.data && list.data.length === 0 && <p className="text-sm text-muted">{t('archive.noColumns')}</p>}
      {!!list.data?.length && (
        <div className="divide-y divide-[var(--border)] rounded-lg border border-line">
          {list.data.map((l) => (
            <div key={l.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{l.name}</div>
                <div className="text-xs text-muted">
                  {t('boards.cards', { count: l.card_count })} · {t('archive.archivedAgo', { when: fmtRelative(l.archived_at) })}
                </div>
              </div>
              {can && (
                <>
                  <Button size="sm" onClick={() => run.mutate({ f: () => api.post(`/lists/${l.id}/restore`), msg: t('toast.restored') })}>
                    <ArchiveRestore size={13} /> {t('archive.restore')}
                  </Button>
                  {(l.card_count === 0 || b.can('cards.delete')) && (
                    <Button
                      size="sm"
                      variant="danger"
                      title={t('archive.deleteForever')}
                      onClick={async () => {
                        const ok = await ask({
                          title: t('board.deleteList'),
                          message: l.card_count ? t('column.deleteMsg', { name: l.name, count: l.card_count }) : t('column.deleteEmptyMsg', { name: l.name }),
                          confirmLabel: t('archive.deleteForever'),
                          danger: true,
                          typeToConfirm: l.card_count ? 'Delete' : undefined,
                        })
                        if (ok) run.mutate({ f: () => api.del(`/lists/${l.id}`), msg: t('toast.deleted') })
                      }}
                    >
                      <Trash2 size={13} />
                    </Button>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
