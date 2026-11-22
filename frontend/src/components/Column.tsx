import { useDroppable } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Archive, ArrowDownUp, LayoutTemplate, ChevronsLeftRight, ChevronsRightLeft, Gauge, GripVertical, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import { useCallback, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api'
import type { BoardHelpers, Viewer } from '../lib/board'
import { templateDue, type CardSummary, type CardTemplate, type List } from '../lib/types'
import { CardTile } from './CardTile'
import { ask, askText } from './dialogs'
import { toastError, toastSuccess } from './toast'
import { ContextMenu, CTX, DROP, MItem, MSep, MSub, type MenuKit } from './menu'
import { Button, Menu, MenuContent, MenuTrigger } from './ui'

export function Column({
  list,
  cards,
  totalCount,
  b,
  boardId,
  onOpen,
  dragDisabled,
  viewersByCard,
}: {
  viewersByCard?: Map<string, Viewer[]>
  list: List
  cards: CardSummary[]
  totalCount: number
  b: BoardHelpers
  boardId: string
  onOpen: (id: string) => void
  dragDisabled: boolean
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const canManage = b.can('lists.edit')
  const sortable = useSortable({ id: `list:${list.id}`, data: { type: 'list' }, disabled: !canManage })
  const drop = useDroppable({ id: `drop:${list.id}`, data: { type: 'drop', listId: list.id } })
  const [adding, setAdding] = useState<null | 'top' | 'bottom'>(null)
  const [renaming, setRenaming] = useState(false)
  const openBottom = useCallback(() => setAdding('bottom'), [])

  const update = useMutation({
    mutationFn: (p: Partial<List>) => api.patch(`/lists/${list.id}`, p),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['board', boardId] }),
    onError: toastError,
  })
  const sort = useMutation({
    mutationFn: (p: { by: string; desc: boolean }) => api.post(`/lists/${list.id}/sort`, p),
    onSuccess: () => (qc.invalidateQueries({ queryKey: ['board', boardId] }), toastSuccess(t('toast.sorted', { name: list.name }))),
    onError: toastError,
  })
  const remove = useMutation({
    mutationFn: () => api.del(`/lists/${list.id}`),
    onSuccess: () => (qc.invalidateQueries({ queryKey: ['board', boardId] }), toastSuccess(t('toast.columnDeleted', { name: list.name }))),
    onError: toastError,
  })
  const archive = useMutation({
    mutationFn: () => api.post(`/lists/${list.id}/archive`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['board', boardId] })
      qc.invalidateQueries({ queryKey: ['archived-lists', boardId] })
      toastSuccess(t('toast.columnArchived', { name: list.name }))
    },
    onError: toastError,
  })
  const fromTemplate = useMutation({
    mutationFn: (tp: CardTemplate) => api.post<CardSummary>(`/lists/${list.id}/cards`, { title: '', template_id: tp.id, due_at: templateDue(tp) }),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['board', boardId] })
      toastSuccess(t('toast.cardCreated', { title: c.title }))
      onOpen(c.id) // open it right away so it can be renamed / filled in
    },
    onError: toastError,
  })
  const confirmDelete = async () => {
    const ok = await ask({
      title: t('board.deleteList'),
      message: totalCount ? t('column.deleteMsg', { name: list.name, count: totalCount }) : t('column.deleteEmptyMsg', { name: list.name }),
      confirmLabel: t('board.deleteList'),
      danger: true,
      typeToConfirm: totalCount ? 'Delete' : undefined,
    })
    if (ok) remove.mutate()
  }
  const setWip = async () => {
    const v = await askText({
      title: t('board.wipLimit'),
      label: t('board.wipPrompt'),
      defaultValue: list.wip_limit?.toString() ?? '',
      inputType: 'number',
    })
    if (v === null) return
    const n = parseInt(v, 10)
    update.mutate({ wip_limit: Number.isFinite(n) && n > 0 ? n : null })
  }

  const style = { transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition }
  const over = list.wip_limit != null && totalCount > list.wip_limit
  // Odoo-style progress bar: share of cards per status, in the board's status order
  const counts = new Map<string, number>()
  cards.forEach((c) => counts.set(c.status_id ?? '', (counts.get(c.status_id ?? '') ?? 0) + 1))
  const bar = [...b.statuses.values()].map((s) => ({ key: s.id, name: s.name, color: s.color, n: counts.get(s.id) ?? 0 }))
  if (counts.get('')) bar.push({ key: '', name: t('filter.noStatus'), color: '#d4d4d8', n: counts.get('')! })

  // shared by the "⋯" menu and the right-click menu
  const ColumnItems = ({ M, withNew }: { M: MenuKit; withNew?: boolean }) => (
    <>
      {withNew && b.can('cards.create') && (
        <>
          <MItem M={M} onSelect={() => (list.folded ? update.mutate({ folded: false }) : undefined, setAdding('top'))}>
            <Plus size={14} /> {t('menu.newCardTop')}
          </MItem>
          <MItem M={M} onSelect={() => (list.folded ? update.mutate({ folded: false }) : undefined, setAdding('bottom'))}>
            <Plus size={14} /> {t('menu.newCardBottom')}
          </MItem>
          {!!b.data?.templates.length && (
            <MSub M={M} icon={<LayoutTemplate size={14} />} label={t('templates.newFrom')}>
              {b.data.templates.map((tp) => (
                <MItem key={tp.id} M={M} onSelect={() => fromTemplate.mutate(tp)}>
                  {tp.name}
                </MItem>
              ))}
            </MSub>
          )}
          <MSep M={M} />
        </>
      )}
      <MItem M={M} onSelect={() => update.mutate({ folded: !list.folded })}>
        {list.folded ? <ChevronsLeftRight size={14} /> : <ChevronsRightLeft size={14} />} {list.folded ? t('board.unfold') : t('board.fold')}
      </MItem>
      {b.can('cards.move') && cards.length > 1 && (
        <MSub M={M} icon={<ArrowDownUp size={14} />} label={t('sort.title')}>
          {(
            [
              ['priority', true, 'sort.priority'],
              ['due', false, 'sort.due'],
              ['created', true, 'sort.created'],
              ['created', false, 'sort.createdAsc'],
              ['updated', true, 'sort.updated'],
              ['title', false, 'sort.title_'],
              ['number', false, 'sort.number'],
            ] as const
          ).map(([by, desc, label]) => (
            <MItem key={label} M={M} onSelect={() => sort.mutate({ by, desc })}>
              {t(label)}
            </MItem>
          ))}
        </MSub>
      )}
      {canManage && (
        <>
          <MItem M={M} onSelect={() => setRenaming(true)}>
            <Pencil size={14} /> {t('common.rename')}
          </MItem>
          <MItem M={M} onSelect={setWip}>
            <Gauge size={14} /> {t('board.wipLimit')}
          </MItem>
        </>
      )}
      {(b.can('lists.archive') || b.can('lists.delete')) && <MSep M={M} />}
      {b.can('lists.archive') && (
        <MItem M={M} onSelect={() => archive.mutate()}>
          <Archive size={14} /> {t('column.archive')}
        </MItem>
      )}
      {b.can('lists.delete') && (
        <>
          {(totalCount === 0 || b.can('cards.delete')) && (
            <MItem M={M} danger onSelect={confirmDelete}>
              <Trash2 size={14} /> {t('board.deleteList')}
            </MItem>
          )}
        </>
      )}
    </>
  )

  if (list.folded) {
    return (
      <ContextMenu trigger={
      <div
        ref={(el) => {
          sortable.setNodeRef(el)
          drop.setNodeRef(el)
        }}
        style={style}
        className={clsx(
          'flex w-10 shrink-0 cursor-pointer flex-col items-center gap-2 rounded-xl bg-column py-3',
          drop.isOver && 'ring-2 ring-accent',
        )}
        onClick={() => update.mutate({ folded: false })}
        title={t('board.unfold')}
        {...sortable.attributes}
        {...sortable.listeners}
      >
        <ChevronsLeftRight size={14} className="text-muted" />
        <span className="text-xs text-muted">{totalCount}</span>
        <span className="text-sm font-medium [writing-mode:vertical-rl]">{list.name}</span>
      </div>
      }>
        <ColumnItems M={CTX} withNew />
      </ContextMenu>
    )
  }

  return (
    <ContextMenu trigger={
    <div
      ref={sortable.setNodeRef}
      style={style}
      className={clsx('flex max-h-full w-[288px] shrink-0 flex-col rounded-xl bg-column', sortable.isDragging && 'opacity-50')}
    >
      <div className="px-2 pt-2" {...sortable.attributes} {...sortable.listeners}>
        <div className={clsx('group/col flex items-center gap-1 px-1', canManage && 'cursor-grab active:cursor-grabbing')}>
          {canManage && (
            <GripVertical size={14} className="-ml-1 shrink-0 text-muted opacity-40 group-hover/col:opacity-100" aria-label={t('sort.dragHint')} />
          )}
          {list.color && <span className="h-2.5 w-2.5 rounded-full" style={{ background: list.color }} />}
          {renaming ? (
            <form
              className="flex-1"
              onSubmit={(e: FormEvent<HTMLFormElement>) => {
                e.preventDefault()
                const v = new FormData(e.currentTarget).get('name') as string
                if (v.trim()) update.mutate({ name: v.trim() })
                setRenaming(false)
              }}
            >
              <input
                name="name"
                defaultValue={list.name}
                autoFocus
                onBlur={(e) => e.currentTarget.form?.requestSubmit()}
                onKeyDown={(e) => {
                  // the header around this box is the column's drag handle: its keyboard sensor would take Space
                  // (and Enter) as "pick the column up" and swallow the key, so keys stay inside the box
                  e.stopPropagation()
                  if (e.key === 'Escape') setRenaming(false)
                }}
                onPointerDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
                className="w-full rounded border border-line bg-surface px-1.5 py-0.5 text-sm font-semibold outline-none"
              />
            </form>
          ) : (
            <h3 className="flex-1 truncate text-sm font-semibold" onDoubleClick={() => canManage && setRenaming(true)}>
              {list.name}
            </h3>
          )}
          <span className={clsx('rounded px-1.5 text-xs', over ? 'bg-red-500/15 font-semibold text-red-600' : 'text-muted')}>
            {totalCount}
            {list.wip_limit != null && `/${list.wip_limit}`}
          </span>
          {b.can('cards.create') && (
            <button
              className="rounded p-1 text-muted hover:bg-black/5 touch:p-1.5 dark:hover:bg-white/10 cursor-pointer"
              onClick={() => setAdding('top')}
              onPointerDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              title={t('board.addCard')}
            >
              <Plus size={15} />
            </button>
          )}
          <Menu>
            <MenuTrigger asChild>
              <button
                className="rounded p-1 text-muted hover:bg-black/5 touch:p-1.5 dark:hover:bg-white/10 cursor-pointer"
                onPointerDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
              >
                <MoreHorizontal size={15} />
              </button>
            </MenuTrigger>
            <MenuContent>
              <ColumnItems M={DROP} />
            </MenuContent>
          </Menu>
        </div>
        {/* Odoo-style status progress bar */}
        {cards.length > 0 && (
          <div className="mx-1 mt-2 flex h-1 overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
            {bar.map((s) =>
              s.n ? <div key={s.key} title={`${s.name}: ${s.n}`} style={{ width: `${(s.n / cards.length) * 100}%`, background: s.color }} /> : null,
            )}
          </div>
        )}
      </div>

      <div
        ref={drop.setNodeRef}
        className={clsx('scroll-thin flex min-h-12 flex-1 flex-col gap-2 overflow-y-auto p-2', drop.isOver && 'rounded-lg bg-accent/5')}
      >
        {adding === 'top' && <QuickAdd listId={list.id} boardId={boardId} at="top" onDone={() => setAdding(null)} />}
        <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          {cards.map((c) => (
            <CardTile key={c.id} card={c} b={b} onOpen={onOpen} disabled={dragDisabled} onNew={openBottom} viewers={viewersByCard?.get(c.id)} />
          ))}
        </SortableContext>
        {adding === 'bottom' && <QuickAdd listId={list.id} boardId={boardId} at="bottom" onDone={() => setAdding(null)} />}
      </div>
      {b.can('cards.create') && adding !== 'bottom' && (
        <button
          onClick={() => setAdding('bottom')}
          className="m-2 mt-0 flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-muted hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer"
        >
          <Plus size={15} /> {t('board.addCard')}
        </button>
      )}
    </div>
    }>
      <ColumnItems M={CTX} withNew />
    </ContextMenu>
  )
}

function QuickAdd({ listId, boardId, at, onDone }: { listId: string; boardId: string; at: 'top' | 'bottom'; onDone: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [title, setTitle] = useState('')
  const m = useMutation({
    mutationFn: (title: string) => api.post(`/lists/${listId}/cards`, { title, at }),
    onSuccess: () => {
      setTitle('')
      qc.invalidateQueries({ queryKey: ['board', boardId] })
    },
    onError: toastError,
  })
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (title.trim()) m.mutate(title.trim())
      }}
      className="space-y-2"
    >
      <textarea
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        autoFocus
        rows={2}
        placeholder={t('board.cardTitle')}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            e.currentTarget.form?.requestSubmit()
          }
          if (e.key === 'Escape') onDone()
        }}
        className="w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-sm shadow-sm outline-none focus:ring-2 focus:ring-accent/60"
      />
      <div className="flex gap-2">
        <Button variant="primary" size="sm" disabled={m.isPending}>
          {t('common.add')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  )
}
