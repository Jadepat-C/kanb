import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, ChevronDown, ChevronRight, ShieldCheck, Download, Columns3, LayoutTemplate, MessageSquare, Paperclip, Pencil, Plus, Search, Settings2, SquareStack, Trash2, Users } from 'lucide-react'
import { Stars } from './CardTile'
import { boardScope, ContactPointList } from './ContactPoints'
import { SaveBoardTemplate } from './SaveBoardTemplate'
import { RecurringCards } from './Recurring'
import { LiveEditor } from './editor/LiveEditor'
import { ConfirmDialog } from './ConfirmDialog'
import { ask, askText } from './dialogs'
import { fmtRelative } from '../lib/prefs'
import { avatarUrl, label } from '../lib/user'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { api } from '../lib/api'
import { useMe } from '../lib/auth'
import type { BoardHelpers } from '../lib/board'
import type { CardTemplate, List, Role, UserBrief } from '../lib/types'
import { toast, toastError } from './toast'
import { DROP, MItem, MSep } from './menu'
import { Avatar, Button, ColorPicker, Dialog, Field, Input, Menu, MenuContent, MenuTrigger } from './ui'

type Tab = 'general' | 'members' | 'roles' | 'statuses' | 'labels' | 'templates' | 'notifications' | 'archive'

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
        {/* phones: the tabs wrap onto a few lines so every one stays visible */}
        <nav className="flex flex-wrap gap-1 border-b border-line p-2 sm:w-48 sm:flex-col sm:flex-nowrap sm:border-b-0 sm:border-r">
          {(['general', 'members', 'roles', 'statuses', 'labels', 'templates', 'notifications', 'archive'] as Tab[])
            .filter((k) => k !== 'notifications' || b.can('notifications.manage'))
            .map((k) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={clsx(
                'shrink-0 rounded-md px-3 py-1.5 text-left text-sm cursor-pointer',
                tab === k ? 'bg-black/5 font-medium dark:bg-white/10' : 'text-muted hover:bg-black/5 dark:hover:bg-white/5',
              )}
            >
              {t(`settings.${k}`)}
            </button>
          ))}
        </nav>
        <div className="min-h-[420px] min-w-0 flex-1 p-4 sm:p-5">
          {tab === 'general' && <General b={b} boardId={boardId} onClose={() => onOpenChange(false)} />}
          {tab === 'members' && <Members b={b} boardId={boardId} />}
          {tab === 'roles' && <Roles b={b} boardId={boardId} />}
          {tab === 'statuses' && <Statuses b={b} boardId={boardId} />}
          {tab === 'labels' && <Labels b={b} boardId={boardId} />}
          {tab === 'templates' && <Templates b={b} boardId={boardId} />}
          {tab === 'notifications' && b.can('notifications.manage') && <BoardChannels boardId={boardId} />}
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
  const { data: me } = useMe()
  const [savingTpl, setSavingTpl] = useState(false)
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
      <div className="space-y-2 border-t border-line pt-4">
        <div className="text-sm font-medium">{t('export.title')}</div>
        <div className="flex flex-wrap gap-2">
          {(['csv', 'json', 'zip'] as const).map((f) => (
            <a
              key={f}
              href={`/api/boards/${boardId}/export?format=${f}`}
              download
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-sm hover:bg-black/5 dark:hover:bg-white/5"
            >
              <Download size={14} /> {t(`export.${f}`)}
            </a>
          ))}
        </div>
        <p className="text-xs text-muted">{t('export.hint')}</p>
      </div>
      {(me?.can_create_boards || me?.is_super_admin) && (
        <div className="space-y-2 border-t border-line pt-4">
          <Button onClick={() => setSavingTpl(true)}>
            <LayoutTemplate size={14} /> {t('boardTemplates.saveBoard')}
          </Button>
          <p className="text-xs text-muted">{t('boardTemplates.saveBoardHint')}</p>
          {savingTpl && <SaveBoardTemplate boardId={boardId} boardName={board.name} onClose={() => setSavingTpl(false)} />}
        </div>
      )}
      {(b.can('board.archive') || b.can('board.delete')) && (
        <div className="space-y-2 border-t border-line pt-4">
          <div className="flex flex-wrap gap-2">
            {b.can('board.archive') && (
              <Button onClick={() => setConfirm('archive')}>
                <Archive size={14} /> {t('archive.archiveBoard')}
              </Button>
            )}
            {b.can('board.delete') && (
              <Button variant="danger" onClick={() => setConfirm('purge')}>
                <Trash2 size={14} /> {t('archive.deleteForever')}
              </Button>
            )}
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

const GROUP_ICON: Record<string, React.ReactNode> = {
  board: <Settings2 size={14} />,
  members: <Users size={14} />,
  lists: <Columns3 size={14} />,
  cards: <SquareStack size={14} />,
  comments: <MessageSquare size={14} />,
  attachments: <Paperclip size={14} />,
}

/** Roles × permissions, grouped by topic. A group's row toggles every permission in it for that role. */
function Roles({ b, boardId }: { b: BoardHelpers; boardId: string }) {
  const { t } = useTranslation()
  const refresh = useRefresh(boardId)
  const data = b.data!
  const can = b.can('roles.manage')
  const [newName, setNewName] = useState('')
  const [copyFrom, setCopyFrom] = useState('')
  const [closed, setClosed] = useState<string[]>([])
  const create = useMutation({
    mutationFn: () =>
      api.post(`/boards/${boardId}/roles`, {
        name: newName.trim(),
        permissions: copyFrom ? (copyFrom === 'all' ? data.all_permissions : data.roles.find((r) => r.id === copyFrom)?.permissions ?? []) : ['comments.create'],
        // a copy keeps the original's limits too
        own_cards_only: data.roles.find((r) => r.id === copyFrom)?.own_cards_only ?? false,
        card_list_ids: data.roles.find((r) => r.id === copyFrom)?.card_list_ids ?? null,
      }),
    onSuccess: () => (setNewName(''), setCopyFrom(''), refresh()),
    onError: toastError,
  })
  const update = useMutation({
    mutationFn: ({ id, ...body }: Partial<Role> & { id: string }) => api.patch(`/roles/${id}`, body),
    onSuccess: refresh,
    onError: toastError,
  })
  const del = useMutation({ mutationFn: (id: string) => api.del(`/roles/${id}`), onSuccess: refresh, onError: toastError })
  const has = (r: Role, p: string) => r.is_owner || r.permissions.includes(p)
  const setPerms = (r: Role, perms: string[], on: boolean) =>
    update.mutate({ id: r.id, name: r.name, permissions: on ? [...new Set([...r.permissions, ...perms])] : r.permissions.filter((x) => !perms.includes(x)) })
  const memberCount = (r: Role) => data.members.filter((m) => m.role_id === r.id).length
  const groups = data.permission_groups ?? [['all', data.all_permissions] as [string, string[]]]

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">{t('roles.hint')}</p>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-surface">
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="min-w-[230px] p-2 font-medium" />
              {data.roles.map((r) => (
                <th key={r.id} className="min-w-[88px] p-2 text-center align-bottom font-medium">
                  <div className="text-[13px] font-semibold text-[var(--text)]">{r.name}</div>
                  <div className="text-[10px] font-normal">{t('roles.members', { count: memberCount(r) })}</div>
                  {can && !r.is_owner && (
                    <div className="mt-1 flex items-center justify-center gap-0.5">
                      <button
                        title={t('common.rename')}
                        className="rounded p-0.5 hover:bg-black/5 hover:text-[var(--text)] dark:hover:bg-white/10 cursor-pointer"
                        onClick={async () => {
                          const name = await askText({ title: t('common.rename'), label: t('common.name'), defaultValue: r.name, confirmLabel: t('common.save') })
                          if (name?.trim() && name.trim() !== r.name) update.mutate({ id: r.id, name: name.trim(), permissions: r.permissions })
                        }}
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        title={t('common.delete')}
                        className="rounded p-0.5 hover:bg-black/5 hover:text-red-600 dark:hover:bg-white/10 cursor-pointer"
                        onClick={async () => (await ask({ title: t('common.delete'), message: t('settings.deleteRoleMsg', { name: r.name }), confirmLabel: t('common.delete'), danger: true })) && del.mutate(r.id)}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          {groups.map(([g, perms]) => {
            const open = !closed.includes(g)
            return (
              <tbody key={g}>
                <tr className="border-b border-line bg-black/[0.03] dark:bg-white/[0.04]">
                  <td className="p-2">
                    <button
                      onClick={() => setClosed(open ? [...closed, g] : closed.filter((x) => x !== g))}
                      className="flex items-center gap-1.5 whitespace-nowrap text-left font-semibold cursor-pointer"
                      aria-expanded={open}
                    >
                      <ChevronRight size={14} className={clsx('transition-transform', open && 'rotate-90')} />
                      {GROUP_ICON[g]}
                      {t(`permGroup.${g}`)}
                      <span className="text-xs font-normal text-muted">({perms.length})</span>
                    </button>
                  </td>
                  {data.roles.map((r) => {
                    const n = perms.filter((p) => has(r, p)).length
                    return (
                      <td key={r.id} className="p-2 text-center">
                        <input
                          type="checkbox"
                          title={t('roles.toggleGroup')}
                          checked={n === perms.length}
                          ref={(el) => {
                            if (el) el.indeterminate = n > 0 && n < perms.length
                          }}
                          disabled={!can || r.is_owner}
                          onChange={() => setPerms(r, perms, n < perms.length)}
                          className="h-4 w-4 accent-[var(--color-accent)]"
                        />
                      </td>
                    )
                  })}
                </tr>
                {open &&
                  perms.map((p) => (
                    <tr key={p} className="border-b border-line last:border-0">
                      <td className="py-1.5 pl-8 pr-2">
                        <div>{t(`perm.${p}`)}</div>
                        <div className="text-[11px] text-muted">{t(`permDesc.${p}`)}</div>
                      </td>
                      {data.roles.map((r) => (
                        <td key={r.id} className="p-2 text-center">
                          <input
                            type="checkbox"
                            checked={has(r, p)}
                            disabled={!can || r.is_owner}
                            onChange={(e) => setPerms(r, [p], e.target.checked)}
                            className="h-4 w-4 accent-[var(--color-accent)]"
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
              </tbody>
            )
          })}
          <tbody>
            <tr className="border-b border-line bg-black/[0.03] dark:bg-white/[0.04]">
              <td className="p-2" colSpan={data.roles.length + 1}>
                <span className="flex items-center gap-1.5 whitespace-nowrap pl-5 font-semibold">
                  <ShieldCheck size={14} /> {t('permGroup.limits')}
                </span>
              </td>
            </tr>
            <tr className="border-b border-line">
              <td className="py-1.5 pl-8 pr-2">
                <div>{t('roles.ownCards')}</div>
                <div className="text-[11px] text-muted">{t('roles.ownCardsDesc')}</div>
              </td>
              {data.roles.map((r) => (
                <td key={r.id} className="p-2 text-center">
                  <input
                    type="checkbox"
                    checked={!r.is_owner && r.own_cards_only}
                    disabled={!can || r.is_owner}
                    onChange={(e) => update.mutate({ id: r.id, own_cards_only: e.target.checked })}
                    className="h-4 w-4 accent-[var(--color-accent)]"
                  />
                </td>
              ))}
            </tr>
            <tr>
              <td className="py-1.5 pl-8 pr-2">
                <div>{t('roles.cardColumns')}</div>
                <div className="text-[11px] text-muted">{t('roles.cardColumnsDesc')}</div>
              </td>
              {data.roles.map((r) => (
                <td key={r.id} className="p-2 text-center">
                  <ColumnLimit role={r} lists={data.lists} disabled={!can || r.is_owner} onChange={(ids) => update.mutate({ id: r.id, card_list_ids: ids })} />
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">{t('settings.owner')}</p>
      {can && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (newName.trim()) create.mutate()
          }}
        >
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('settings.newRole')} className="max-w-xs" />
          <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)} className="h-9 rounded-md border border-line bg-surface px-2 text-sm" title={t('roles.startFrom')}>
            <option value="">{t('roles.startEmpty')}</option>
            {data.roles
              .filter((r) => !r.is_owner)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {t('roles.copyOf', { name: r.name })}
                </option>
              ))}
            <option value="all">{t('roles.startAll')}</option>
          </select>
          <Button variant="primary" disabled={!newName.trim()}>
            <Plus size={14} /> {t('common.create')}
          </Button>
        </form>
      )}
    </div>
  )
}

/** Which columns a role may add cards to: any (null), or a chosen few. At least one stays ticked; "Any column" undoes the limit. */
function ColumnLimit({ role, lists, disabled, onChange }: { role: Role; lists: List[]; disabled: boolean; onChange: (ids: string[] | null) => void }) {
  const { t } = useTranslation()
  const ids = role.is_owner ? null : role.card_list_ids
  // columns deleted since are simply ignored
  const picked = ids ? lists.filter((l) => ids.includes(l.id)) : null
  const text = !picked ? t('roles.anyColumn') : picked.length === 1 ? picked[0].name : t('roles.nColumns', { count: picked.length })
  const toggle = (id: string) => {
    if (!picked) return onChange([id])
    const next = picked.some((l) => l.id === id) ? picked.filter((l) => l.id !== id) : [...picked, { id }]
    if (next.length) onChange(next.map((l) => l.id))
  }
  return (
    <Menu modal={false}>
      <MenuTrigger asChild disabled={disabled}>
        <button
          className={clsx(
            'inline-flex max-w-[140px] items-center gap-1 rounded-md border border-line px-2 py-0.5 text-xs',
            disabled ? 'opacity-60' : 'cursor-pointer hover:bg-black/5 dark:hover:bg-white/10',
            picked && 'border-accent text-accent',
          )}
        >
          <span className="truncate">{text}</span>
          {!disabled && <ChevronDown size={12} className="shrink-0" />}
        </button>
      </MenuTrigger>
      <MenuContent>
        <MItem M={DROP} keepOpen checked={!picked} onSelect={() => picked && onChange(null)}>
          {t('roles.anyColumn')}
        </MItem>
        <MSep M={DROP} />
        {lists.map((l) => {
          const on = !!picked?.some((x) => x.id === l.id)
          return (
            <MItem key={l.id} M={DROP} keepOpen checked={on} disabled={on && picked!.length === 1} onSelect={() => toggle(l.id)}>
              <span className="truncate">{l.name}</span>
            </MItem>
          )
        })}
      </MenuContent>
    </Menu>
  )
}

function Labels({ b, boardId }: { b: BoardHelpers; boardId: string }) {
  const { t } = useTranslation()
  const refresh = useRefresh(boardId)
  const can = b.can('labels.manage')
  const [name, setName] = useState('')
  const [color, setColor] = useState<string | null>('#2f5bd3')
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
                  {['#64748b', '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#0ea5e9', '#2f5bd3', '#a855f7', '#ec4899'].map((c) => (
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

const COLORS = ['#a1a1aa', '#64748b', '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#0ea5e9', '#2f5bd3', '#a855f7', '#ec4899']

function Statuses({ b, boardId }: { b: BoardHelpers; boardId: string }) {
  const { t } = useTranslation()
  const refresh = useRefresh(boardId)
  const can = b.can('statuses.manage')
  const list = b.data!.statuses
  const [name, setName] = useState('')
  const [color, setColor] = useState<string | null>('#0ea5e9')
  const create = useMutation({
    mutationFn: () => api.post(`/boards/${boardId}/statuses`, { name, color }),
    onSuccess: () => (setName(''), refresh()),
    onError: toastError,
  })
  const update = useMutation({
    mutationFn: (p: { id: string; name?: string; color?: string; index?: number; is_done?: boolean }) => api.patch(`/statuses/${p.id}`, p),
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
            <label className="flex shrink-0 items-center gap-1 text-xs text-muted" title={t('settings.doneHint')}>
              <input type="checkbox" checked={st.is_done} disabled={!can} onChange={(e) => update.mutate({ id: st.id, is_done: e.target.checked })} className="accent-[var(--color-accent)]" />
              {t('settings.done')}
            </label>
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
  created_by: string | null
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
            {b.canCard('cards.archive', c) && (
              <Button size="sm" onClick={() => restore.mutate(c.id)}>
                <ArchiveRestore size={13} /> {t('archive.restore')}
              </Button>
            )}
            {b.canCard('cards.delete', c) && (
              <Button size="sm" variant="danger" onClick={() => setPurging(c)} title={t('archive.deleteForever')}>
                <Trash2 size={13} />
              </Button>
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
  const can = b.can('lists.archive')
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
              {(can || b.can('lists.delete')) && (
                <>
                  {can && (
                    <Button size="sm" onClick={() => run.mutate({ f: () => api.post(`/lists/${l.id}/restore`), msg: t('toast.restored') })}>
                      <ArchiveRestore size={13} /> {t('archive.restore')}
                    </Button>
                  )}
                  {b.can('lists.delete') && (l.card_count === 0 || b.canAll('cards.delete')) && (
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

function Templates({ b, boardId }: { b: BoardHelpers; boardId: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [editing, setEditing] = useState<CardTemplate | 'new' | null>(null)
  const can = b.can('templates.manage')
  const list = b.data!.templates
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/templates/${id}`),
    onSuccess: () => (qc.invalidateQueries({ queryKey: ['board', boardId] }), toast(t('toast.deleted'), 'success')),
    onError: toastError,
  })
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">{t('templates.hint')}</p>
      {list.length === 0 && <p className="text-sm text-muted">{t('templates.empty')}</p>}
      <div className="divide-y divide-[var(--border)] rounded-lg border border-line empty:hidden">
        {list.map((tp) => (
          <div key={tp.id} className="flex items-center gap-3 px-3 py-2">
            <LayoutTemplate size={16} className="shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{tp.name}</div>
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                <span className="truncate">{tp.title}</span>
                {tp.priority > 0 && <span className="text-amber-500">{'★'.repeat(tp.priority)}</span>}
                {tp.label_ids.map((id) => b.labels.get(id)).filter(Boolean).map((l) => (
                  <span key={l!.id} className="rounded px-1 text-[10px] text-white" style={{ background: l!.color }}>
                    {l!.name}
                  </span>
                ))}
                {tp.due_in_days != null && <span>· {t('templates.dueIn', { count: tp.due_in_days })}</span>}
              </div>
            </div>
            {can && (
              <>
                <Button size="sm" variant="ghost" onClick={() => setEditing(tp)}>
                  {t('common.edit')}
                </Button>
                <button
                  onClick={async () => (await ask({ title: t('common.delete'), message: t('templates.deleteMsg', { name: tp.name }), confirmLabel: t('common.delete'), danger: true })) && del.mutate(tp.id)}
                  className="rounded p-1.5 text-muted hover:text-red-600 cursor-pointer"
                  aria-label={t('common.delete')}
                >
                  <Trash2 size={15} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
      {can && (
        <Button variant="primary" onClick={() => setEditing('new')}>
          <Plus size={14} /> {t('templates.new')}
        </Button>
      )}
      {editing && <TemplateEditor b={b} boardId={boardId} template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <RecurringCards b={b} boardId={boardId} />
    </div>
  )
}

export function TemplateEditor({ b, boardId, template, onClose }: { b: BoardHelpers; boardId: string; template: CardTemplate | null; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const data = b.data!
  const [f, setF] = useState(() => ({
    name: template?.name ?? '',
    title: template?.title ?? '',
    description: template?.description ?? '',
    priority: template?.priority ?? 0,
    status_id: template?.status_id ?? null,
    label_ids: template?.label_ids ?? [],
    due: template?.due_in_days?.toString() ?? '',
  }))
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name.trim() || f.title.trim(),
        title: f.title,
        description: f.description,
        priority: f.priority,
        status_id: f.status_id,
        label_ids: f.label_ids,
        due_in_days: f.due.trim() === '' ? null : Math.max(0, parseInt(f.due, 10) || 0),
      }
      return template ? api.patch(`/templates/${template.id}`, body) : api.post(`/boards/${boardId}/templates`, body)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['board', boardId] })
      toast(t('common.saved'), 'success')
      onClose()
    },
    onError: toastError,
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={template ? t('templates.edit') : t('templates.new')} wide>
      <form
        className="grid gap-5 p-5 md:grid-cols-[1fr_220px]"
        onSubmit={(e) => {
          e.preventDefault()
          if (f.title.trim()) save.mutate()
        }}
      >
        <div className="min-w-0 space-y-3">
          <Field label={t('templates.name')} hint={t('templates.nameHint')}>
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={f.title} autoFocus />
          </Field>
          <Field label={t('templates.cardTitle')}>
            <Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required />
          </Field>
          <div>
            <div className="mb-1 text-xs font-medium text-muted">{t('card.description')}</div>
            <LiveEditor value={f.description} onChange={(description) => setF((x) => ({ ...x, description }))} toolbar minHeight={160} placeholder={t('editor.placeholder')} />
          </div>
        </div>
        <div className="space-y-4 text-sm">
          <div>
            <div className="mb-1 text-xs font-medium text-muted">{t('card.priority')}</div>
            <Stars value={f.priority} size={18} onChange={(priority) => setF({ ...f, priority })} />
          </div>
          <Field label={t('card.status')}>
            <select value={f.status_id ?? ''} onChange={(e) => setF({ ...f, status_id: e.target.value || null })} className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm">
              <option value="">{t('templates.defaultStatus')}</option>
              {data.statuses.map((st) => (
                <option key={st.id} value={st.id}>
                  {st.name}
                </option>
              ))}
            </select>
          </Field>
          {data.labels.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-medium text-muted">{t('card.labels')}</div>
              <div className="flex flex-wrap gap-1">
                {data.labels.map((l) => {
                  const on = f.label_ids.includes(l.id)
                  return (
                    <button
                      type="button"
                      key={l.id}
                      onClick={() => setF({ ...f, label_ids: on ? f.label_ids.filter((x) => x !== l.id) : [...f.label_ids, l.id] })}
                      className={'rounded px-2 py-0.5 text-xs cursor-pointer ' + (on ? 'text-white' : 'border border-line text-muted')}
                      style={on ? { background: l.color } : undefined}
                    >
                      {l.name}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          <Field label={t('templates.dueDays')} hint={t('templates.dueDaysHint')}>
            <Input type="number" min={0} max={3650} value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} placeholder="—" />
          </Field>
          <div className="flex gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" disabled={save.isPending || !f.title.trim()}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  )
}

/** Board channels: this board's activity posted to a shared Discord / Slack / Teams / … channel. */
function BoardChannels({ boardId }: { boardId: string }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">{t('boardChannels.hint')}</p>
      <ContactPointList scope={boardScope(boardId)} />
    </div>
  )
}
