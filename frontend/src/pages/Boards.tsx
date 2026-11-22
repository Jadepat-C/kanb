import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { closestCenter, DndContext, type DragEndEvent } from '@dnd-kit/core'
import { useDragSensors } from '../lib/dnd'
import { arrayMove, rectSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import clsx from 'clsx'
import {
  Archive,
  ArchiveRestore,
  BookOpen,
  ExternalLink,
  Eye,
  Link2,
  LogOut,
  Palette,
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2,
} from 'lucide-react'
import type React from 'react'
import { Fragment, useMemo, useRef, useState, type FormEvent, type ReactElement, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { RenameDialog } from '../components/CardMenu'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { ContextMenu, CTX, MItem, MLabel, MSep, MSub } from '../components/menu'
import { toast, toastError, toastSuccess } from '../components/toast'
import { Avatar, Button, ColorPicker, Dialog, Field, Input, PALETTE, Spinner } from '../components/ui'
import { api } from '../lib/api'
import { useMe } from '../lib/auth'
import { fmtRelative } from '../lib/prefs'
import type { Board, BoardListItem, BoardTemplate } from '../lib/types'
import { avatarUrl, label } from '../lib/user'

type Confirm = { kind: 'archive' | 'purge' | 'leave'; board: BoardListItem } | null

export function Boards() {
  const { t } = useTranslation()
  const { data: me } = useMe()
  const qc = useQueryClient()
  const nav = useNavigate()
  const [filter, setFilter] = useState('')
  const [owner, setOwner] = useState('')
  const [tab, setTab] = useState<'active' | 'archived'>('active')
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<BoardListItem | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const active = useQuery({ queryKey: ['boards'], queryFn: () => api.get<BoardListItem[]>('/boards') })
  const archived = useQuery({ queryKey: ['boards', 'archived'], queryFn: () => api.get<BoardListItem[]>('/boards?archived=true') })
  const data = tab === 'active' ? active.data : archived.data
  const isLoading = tab === 'active' ? active.isLoading : archived.isLoading

  const refresh = () => qc.invalidateQueries({ queryKey: ['boards'] })
  const run = useMutation({
    mutationFn: (p: { f: () => Promise<unknown>; msg?: string }) => p.f(),
    onSuccess: (_, p) => {
      refresh()
      if (p.msg) toastSuccess(p.msg)
    },
    onError: toastError,
  })
  const tutorial = useMutation({
    mutationFn: () => api.post<Board>('/me/tutorial'),
    onSuccess: (b) => {
      refresh()
      nav(`/b/${b.id}`)
    },
    onError: toastError,
  })
  const canCreate = !!(me?.can_create_boards || me?.is_super_admin)

  // drag & drop arrangement (per user). Only with no filter, so the saved order covers every board.
  const canArrange = tab === 'active' && !filter.trim() && !owner
  const justDragged = useRef(false)
  const sensors = useDragSensors(6)
  const saveOrder = useMutation({
    mutationFn: (ids: string[]) => api.put('/boards-order', { ids }),
    onError: (e) => (toastError(e), refresh()),
  })
  const onDragEnd = (e: DragEndEvent) => {
    setTimeout(() => (justDragged.current = false), 0) // swallow the click that ends a drag
    if (!e.over || e.active.id === e.over.id || !active.data) return
    const ids = active.data.map((b) => b.id)
    const next = arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)))
    qc.setQueryData<BoardListItem[]>(['boards'], (old) => (old ? next.map((id) => old.find((b) => b.id === id)!) : old))
    saveOrder.mutate(next)
  }

  // client-side substring filter (Thai-safe: no word splitting involved)
  const f = filter.trim().toLowerCase()
  const boards = (data ?? []).filter(
    (b) => (!f || `${b.name} ${b.description}`.toLowerCase().includes(f)) && (!owner || b.owners.some((o) => o.id === owner)),
  )
  const owners = useMemo(() => {
    const m = new Map<string, { id: string; display_name: string; username: string }>()
    for (const b of [...(active.data ?? []), ...(archived.data ?? [])]) for (const o of b.owners) m.set(o.id, o)
    return [...m.values()].sort((a, b) => a.display_name.localeCompare(b.display_name))
  }, [active.data, archived.data])

  const pageMenu = (trigger: ReactElement) => (
    <ContextMenu trigger={trigger}>
      {canCreate && (
        <MItem M={CTX} onSelect={() => setCreating(true)}>
          <Plus size={14} /> {t('boards.new')}
        </MItem>
      )}
      <MItem M={CTX} onSelect={() => tutorial.mutate()}>
        <BookOpen size={14} /> {t('boards.addTutorial')}
      </MItem>
      <MItem M={CTX} onSelect={() => setTab(tab === 'active' ? 'archived' : 'active')}>
        <Archive size={14} /> {tab === 'active' ? t('boards.showArchived') : t('boards.showActive')}
      </MItem>
    </ContextMenu>
  )

  const boardMenu = (b: BoardListItem, trigger: ReactElement) => {
    const link = `${location.origin}/b/${b.id}`
    const isArchived = !!b.archived_at
    return (
      <ContextMenu trigger={trigger}>
        <MLabel M={CTX}>{b.name}</MLabel>
        {!isArchived && (
          <>
            <MItem M={CTX} onSelect={() => nav(`/b/${b.id}`)}>
              <ExternalLink size={14} /> {t('menu.open')}
            </MItem>
            <MItem M={CTX} onSelect={() => window.open(link, '_blank', 'noopener')}>
              <ExternalLink size={14} /> {t('boards.openNewTab')}
            </MItem>
          </>
        )}
        <MItem M={CTX} onSelect={() => navigator.clipboard?.writeText(link).then(() => toast(t('menu.linkCopied')))}>
          <Link2 size={14} /> {t('menu.copyLink')}
        </MItem>
        {!isArchived && b.can_manage && (
          <>
            <MSep M={CTX} />
            <MItem M={CTX} onSelect={() => setRenaming(b)}>
              <Pencil size={14} /> {t('common.rename')}
            </MItem>
            <MSub M={CTX} icon={<Palette size={14} />} label={t('common.color')}>
              <div className="grid grid-cols-5 gap-1 p-1">
                {PALETTE.map((c) => (
                  <CTX.Item
                    key={c}
                    onSelect={() => run.mutate({ f: () => api.patch(`/boards/${b.id}`, { color: c }) })}
                    className="h-6 w-6 cursor-pointer rounded-full outline-none data-[highlighted]:ring-2 data-[highlighted]:ring-accent"
                    style={{ background: c }}
                    aria-label={c}
                  />
                ))}
              </div>
            </MSub>
            <MItem M={CTX} onSelect={() => nav(`/b/${b.id}?settings=1`)}>
              <Settings size={14} /> {t('board.settings')}
            </MItem>
          </>
        )}
        {b.is_member && !isArchived && (
          <MItem M={CTX} onSelect={() => setConfirm({ kind: 'leave', board: b })}>
            <LogOut size={14} /> {t('settings.leave')}
          </MItem>
        )}
        {(b.can_archive || b.can_delete) && <MSep M={CTX} />}
        {b.can_archive && (
          <>
            {isArchived ? (
              <MItem M={CTX} onSelect={() => run.mutate({ f: () => api.post(`/boards/${b.id}/restore`), msg: t('toast.boardRestored', { name: b.name }) })}>
                <ArchiveRestore size={14} /> {t('archive.restore')}
              </MItem>
            ) : (
              <MItem M={CTX} onSelect={() => setConfirm({ kind: 'archive', board: b })}>
                <Archive size={14} /> {t('archive.archiveBoard')}
              </MItem>
            )}
          </>
        )}
        {b.can_delete && (
          <>
            <MItem M={CTX} danger onSelect={() => setConfirm({ kind: 'purge', board: b })}>
              <Trash2 size={14} /> {t('archive.deleteForever')}
            </MItem>
          </>
        )}
      </ContextMenu>
    )
  }

  return pageMenu(
    <div className="min-h-full">
      <div className="mx-auto max-w-6xl p-4 sm:p-6">
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{t('boards.title')}</h1>
          <div className="flex rounded-md border border-line p-0.5">
            {(['active', 'archived'] as const).map((k) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={clsx(
                  'flex items-center gap-1 rounded px-2.5 py-0.5 text-xs cursor-pointer',
                  tab === k ? 'bg-accent text-white' : 'text-muted hover:bg-black/5 dark:hover:bg-white/10',
                )}
              >
                {k === 'archived' && <Archive size={12} />}
                {t(`boards.tab_${k}`)}
                {k === 'archived' && !!archived.data?.length && ` (${archived.data.length})`}
              </button>
            ))}
          </div>
          <select
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            className="ml-auto h-9 rounded-md border border-line bg-surface px-2 text-sm"
            aria-label={t('filter.owner')}
          >
            <option value="">{t('filter.allOwners')}</option>
            {owners.map((o) => (
              <option key={o.id} value={o.id}>
                {t('filter.ownedBy')}: {label(o)}
              </option>
            ))}
          </select>
          <div className="relative w-full max-w-xs">
            <Search size={15} className="absolute left-2.5 top-2.5 text-muted" />
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('search.filterBoards')} className="pl-8" />
          </div>
          {canCreate && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={16} /> {t('boards.new')}
            </Button>
          )}
        </div>
        {tab === 'archived' && <p className="mb-3 text-sm text-muted">{t('archive.boardsHint')}</p>}
        {tab === 'active' && boards.length > 1 && (
          <p className="mb-3 text-xs text-muted">{canArrange ? t('boards.dragHint') : t('boards.dragDisabled')}</p>
        )}
        {isLoading ? (
          <Spinner />
        ) : boards.length === 0 ? (
          <div className="flex flex-col items-start gap-3 text-muted">
            <p>{tab === 'archived' ? t('archive.noBoards') : t('boards.empty')}</p>
            {tab === 'active' && (
              <Button onClick={() => tutorial.mutate()} disabled={tutorial.isPending}>
                <BookOpen size={15} /> {t('boards.addTutorial')}
              </Button>
            )}
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={() => (justDragged.current = true)}
            onDragEnd={onDragEnd}
            onDragCancel={() => setTimeout(() => (justDragged.current = false), 0)}
          >
          <SortableContext items={boards.map((b) => b.id)} strategy={rectSortingStrategy}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {boards.map((b) => (
              <Fragment key={b.id}>
              {boardMenu(
                b,
                tab === 'active' ? (
                  <SortableBoard b={b} disabled={!canArrange} justDragged={justDragged} />
                ) : (
                  <div key={b.id} className="relative overflow-hidden rounded-xl border border-dashed border-line bg-surface/60 p-4">
                    <BoardTile b={b} />
                    <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
                      <span className="text-xs text-muted">
                        {t('archive.archivedAgo', { when: fmtRelative(b.archived_at!) })}
                      </span>
                      {b.can_archive && (
                          <Button size="sm" className="ml-auto" onClick={() => run.mutate({ f: () => api.post(`/boards/${b.id}/restore`), msg: t('toast.boardRestored', { name: b.name }) })}>
                            <ArchiveRestore size={13} /> {t('archive.restore')}
                          </Button>
                      )}
                      {b.can_delete && (
                          <Button size="sm" variant="danger" className={b.can_archive ? '' : 'ml-auto'} onClick={() => setConfirm({ kind: 'purge', board: b })}>
                            <Trash2 size={13} />
                          </Button>
                      )}
                    </div>
                  </div>
                ),
              )}
              </Fragment>
            ))}
          </div>
          </SortableContext>
          </DndContext>
        )}
        <CreateBoard open={creating} onOpenChange={setCreating} />
        {renaming && (
          <RenameDialog
            value={renaming.name}
            onClose={() => setRenaming(null)}
            onSave={(name) => {
              run.mutate({ f: () => api.patch(`/boards/${renaming.id}`, { name }), msg: t('common.saved') })
              setRenaming(null)
            }}
          />
        )}
        {confirm?.kind === 'archive' && (
          <ConfirmDialog
            title={t('archive.archiveBoard')}
            message={t('archive.archiveBoardMsg', { name: confirm.board.name })}
            confirmLabel={t('archive.archiveBoard')}
            danger={false}
            onConfirm={() => run.mutateAsync({ f: () => api.del(`/boards/${confirm.board.id}`), msg: t('toast.boardArchived', { name: confirm.board.name }) })}
            onClose={() => setConfirm(null)}
          />
        )}
        {confirm?.kind === 'purge' && (
          <ConfirmDialog
            title={t('archive.deleteForever')}
            message={t('archive.purgeBoardMsg', { name: confirm.board.name, cards: confirm.board.card_count })}
            confirmLabel={t('archive.deleteForever')}
            typeToConfirm="Delete"
            onConfirm={() => run.mutateAsync({ f: () => api.del(`/boards/${confirm.board.id}/permanent`), msg: t('toast.boardDeleted', { name: confirm.board.name }) })}
            onClose={() => setConfirm(null)}
          />
        )}
        {confirm?.kind === 'leave' && me && (
          <ConfirmDialog
            title={t('settings.leave')}
            message={t('boards.leaveMsg', { name: confirm.board.name })}
            confirmLabel={t('settings.leave')}
            onConfirm={() => run.mutateAsync({ f: () => api.del(`/boards/${confirm.board.id}/members/${me.id}`), msg: t('toast.left', { name: confirm.board.name }) })}
            onClose={() => setConfirm(null)}
          />
        )}
      </div>
    </div>,
  )
}

function BoardTile({ b }: { b: BoardListItem }) {
  const { t } = useTranslation()
  return (
    <>
      <div className="absolute inset-x-0 top-0 h-1" style={{ background: b.color }} />
      <div className="flex items-start gap-2">
        <h2 className="font-semibold group-hover:text-accent">{b.name}</h2>
        {!b.is_member && (
          <span title={t('boards.notMember')} className="ml-auto text-muted">
            <Eye size={15} />
          </span>
        )}
      </div>
      {b.description && <p className="mt-1 line-clamp-2 text-sm text-muted">{b.description}</p>}
      <div className="mt-3 flex items-center gap-1.5 text-xs text-muted">
        <span className="flex -space-x-1.5">
          {b.owners.slice(0, 3).map((o) => (
            <Avatar key={o.id} name={label(o)} color={o.avatar_color} src={avatarUrl(o.avatar_id)} size={20} />
          ))}
        </span>
        <span className="truncate">{b.owners.map((o) => label(o)).join(', ')}</span>
      </div>
      <div className="mt-2 flex gap-3 text-xs text-muted">
        <span>{t('boards.cards', { count: b.card_count })}</span>
        {b.done_count > 0 && <span className="text-done">{t('board.doneOf', { done: b.done_count, total: b.card_count })}</span>}
        <span>{t('boards.members', { count: b.member_count })}</span>
        <span className="ml-auto">{fmtRelative(b.updated_at)}</span>
      </div>
    </>
  )
}

export function CreateBoard({ open, onOpenChange, templateId }: { open: boolean; onOpenChange: (o: boolean) => void; templateId?: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const nav = useNavigate()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState<string | null>('#2f5bd3')
  const [lists, setLists] = useState(t('boards.defaultLists'))
  const templates = useQuery({ queryKey: ['board-templates'], queryFn: () => api.get<BoardTemplate[]>('/board-templates'), enabled: open })
  const [tplId, setTplId] = useState(templateId ?? '')
  const tpl = templates.data?.find((x) => x.id === tplId)
  // a template brings its own colour and description unless the user typed something
  const [touched, setTouched] = useState({ description: false, color: false })
  const pick = (id: string) => {
    setTplId(id)
    const x = templates.data?.find((y) => y.id === id)
    if (x && !touched.color) setColor(x.color)
    if (x && !touched.description) setDescription(x.description)
  }
  const prefilled = useRef(false)
  if (templateId && !prefilled.current && templates.data) {
    prefilled.current = true
    const x = templates.data.find((y) => y.id === templateId)
    if (x) {
      setColor(x.color)
      setDescription(x.description)
    }
  }
  const m = useMutation({
    mutationFn: () =>
      api.post<Board>('/boards', {
        name,
        description,
        color,
        lists: lists.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
        template_id: tplId || undefined,
      }),
    onSuccess: (b) => {
      qc.invalidateQueries({ queryKey: ['boards'] })
      toastSuccess(t('toast.boardCreated', { name: b.name }))
      onOpenChange(false)
      nav(`/b/${b.id}`)
    },
    onError: toastError,
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    m.mutate()
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('boards.new')}>
      <form onSubmit={submit} className="space-y-4 p-5">
        <Field label={t('common.name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('boards.namePlaceholder')} autoFocus required />
        </Field>
        {!!templates.data?.length && (
          <Field label={t('boardTemplates.template')}>
            <select value={tplId} onChange={(e) => pick(e.target.value)} className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm">
              <option value="">{t('boardTemplates.blank')}</option>
              {templates.data.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={t('common.description')}>
          <Input value={description} onChange={(e) => (setDescription(e.target.value), setTouched({ ...touched, description: true }))} />
        </Field>
        {tpl ? (
          <p className="rounded-md bg-black/[0.03] px-3 py-2 text-xs text-muted dark:bg-white/5">
            {t('boardTemplates.willCreate', {
              lists: tpl.data.lists.map((l) => l.name).join(', '),
              extra: [
                t('boardTemplates.nStatuses', { count: tpl.counts.statuses }),
                t('boardTemplates.nLabels', { count: tpl.counts.labels }),
                t('boardTemplates.nCardTemplates', { count: tpl.counts.card_templates }),
                t('boardTemplates.nCards', { count: tpl.counts.cards }),
              ].join(', '),
            })}
          </p>
        ) : (
          <Field label={t('boards.listsLabel')}>
            <Input value={lists} onChange={(e) => setLists(e.target.value)} />
          </Field>
        )}
        <Field label={t('common.color')}>
          <ColorPicker value={color} onChange={(c) => (setColor(c), setTouched({ ...touched, color: true }))} />
        </Field>
        <div className="flex justify-end gap-2">
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

function SortableBoard({
  b,
  disabled,
  justDragged,
  ...rest
}: { b: BoardListItem; disabled: boolean; justDragged: RefObject<boolean> } & Record<string, unknown>) {
  const nav = useNavigate()
  const s = useSortable({ id: b.id, disabled })
  const down = useRef<{ x: number; y: number } | null>(null)
  // the right-click wrapper and dnd-kit both listen to pointerdown: run both
  const menuDown = rest.onPointerDown as ((e: React.PointerEvent) => void) | undefined
  const dragDown = s.listeners?.onPointerDown as ((e: React.PointerEvent) => void) | undefined
  const open = () => nav(`/b/${b.id}`)
  // A plain element, not <a>: the browser would otherwise follow the link natively at the end of a drag.
  return (
    <div
      {...rest /* context-menu trigger props */}
      ref={s.setNodeRef}
      style={{ transform: CSS.Translate.toString(s.transform), transition: s.transition }}
      {...s.attributes}
      role="link"
      aria-disabled={undefined}
      {...s.listeners}
      onPointerDown={(e: React.PointerEvent) => {
        down.current = { x: e.clientX, y: e.clientY }
        menuDown?.(e)
        dragDown?.(e)
      }}
      onClick={(e) => {
        const d = down.current
        if (justDragged.current || (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5)) return
        if (e.ctrlKey || e.metaKey) window.open(`/b/${b.id}`, '_blank', 'noopener')
        else open()
      }}
      onAuxClick={(e) => e.button === 1 && window.open(`/b/${b.id}`, '_blank', 'noopener')}
      onKeyDown={(e) => {
        if (e.key === 'Enter') open()
        else (s.listeners?.onKeyDown as ((e: React.KeyboardEvent) => void) | undefined)?.(e)
      }}
      className={clsx(
        'group relative block cursor-pointer select-none overflow-hidden rounded-xl border border-line bg-surface p-4 shadow-sm outline-none transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-accent',
        s.isDragging && 'z-10 opacity-80 shadow-xl',
      )}
    >
      <BoardTile b={b} />
    </div>
  )
}
