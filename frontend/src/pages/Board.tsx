import {
  closestCenter,
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { arrayMove, horizontalListSortingStrategy, SortableContext, sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Check, Filter, Plus, Search, Settings, Tag, User, Wifi, WifiOff, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams, useSearchParams } from 'react-router'
import { BoardSettings } from '../components/BoardSettings'
import { CardModal } from '../components/CardModal'
import { CardGhost } from '../components/CardTile'
import { Column } from '../components/Column'
import { toastError } from '../components/toast'
import { Button, Input, Menu, MenuContent, MenuItem, MenuTrigger, Spinner } from '../components/ui'
import { api } from '../lib/api'
import { useMe } from '../lib/auth'
import { groupCards, useBoard, useBoardSocket } from '../lib/board'
import { errorText } from '../lib/i18n'
import type { CardSummary } from '../lib/types'

type Columns = Record<string, string[]>

export function BoardPage() {
  const { boardId = '' } = useParams()
  const { t } = useTranslation()
  const [sp, setSp] = useSearchParams()
  const openCard = sp.get('card')
  const b = useBoard(boardId)
  const online = useBoardSocket(boardId)
  const { data: me } = useMe()
  const qc = useQueryClient()
  const [settingsOpen, setSettingsOpen] = useState(false)

  // filters
  const [text, setText] = useState('')
  const [mine, setMine] = useState(false)
  const [labelFilter, setLabelFilter] = useState<string[]>([])
  const filtering = !!text.trim() || mine || labelFilter.length > 0

  const data = b.data
  const cardsById = useMemo(() => new Map((data?.cards ?? []).map((c) => [c.id, c])), [data])
  const full = useMemo(() => groupCards(data?.cards ?? []), [data])

  const visible = useMemo(() => {
    const q = text.trim().toLowerCase().replace(/^#/, '')
    const match = (c: CardSummary) => {
      if (mine && !c.assignee_ids.includes(me?.id ?? '')) return false
      if (labelFilter.length && !labelFilter.some((l) => c.label_ids.includes(l))) return false
      if (!q) return true
      const hay = [
        c.title,
        c.excerpt,
        String(c.number),
        ...c.label_ids.map((l) => b.labels.get(l)?.name ?? ''),
        ...c.assignee_ids.map((u) => b.members.get(u)?.display_name ?? ''),
      ]
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    }
    const out: Columns = {}
    for (const l of data?.lists ?? []) out[l.id] = (full[l.id] ?? []).filter((id) => match(cardsById.get(id)!))
    return out
  }, [data, full, text, mine, labelFilter, me, cardsById, b.labels, b.members])

  // drag state: while dragging (and until the server confirms) we render from `override`
  const [override, setOverride] = useState<Columns | null>(null)
  const [listOverride, setListOverride] = useState<string[] | null>(null)
  const [active, setActive] = useState<{ type: 'card' | 'list'; id: string } | null>(null)
  const startList = useRef<string | null>(null)
  const columns = override ?? visible
  const listOrder = listOverride ?? (data?.lists ?? []).map((l) => l.id)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const moveCard = useMutation({
    mutationFn: (p: { id: string; list_id: string; index: number }) => api.post(`/cards/${p.id}/move`, p),
    onError: (e) => {
      toastError(e)
    },
    onSettled: async () => {
      await qc.invalidateQueries({ queryKey: ['board', boardId] })
      setOverride(null)
    },
  })
  const moveList = useMutation({
    mutationFn: (p: { id: string; index: number }) => api.patch(`/lists/${p.id}`, { index: p.index }),
    onError: toastError,
    onSettled: async () => {
      await qc.invalidateQueries({ queryKey: ['board', boardId] })
      setListOverride(null)
    },
  })

  if (b.isLoading) return <div className="p-6"><Spinner /></div>
  if (b.error || !data) return <div className="p-6 text-muted">{errorText(b.error)}</div>

  const findList = (id: string, cols: Columns): string | undefined => {
    if (id.startsWith('drop:')) return id.slice(5)
    if (id.startsWith('list:')) return id.slice(5)
    return Object.keys(cols).find((k) => cols[k].includes(id))
  }

  const collision: CollisionDetection = (args) => {
    if (active?.type === 'list') {
      return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((c) => String(c.id).startsWith('list:')) })
    }
    const containers = args.droppableContainers.filter((c) => !String(c.id).startsWith('list:') || cardsFolded(String(c.id)))
    const within = pointerWithin({ ...args, droppableContainers: containers })
    // prefer a card under the pointer over the column drop zone
    const card = within.find((c) => !String(c.id).startsWith('drop:') && !String(c.id).startsWith('list:'))
    if (card) return [card]
    if (within.length) return within
    return closestCorners({ ...args, droppableContainers: containers })
  }
  const cardsFolded = (id: string) => !!data.lists.find((l) => `list:${l.id}` === id)?.folded

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id)
    if (id.startsWith('list:')) {
      setActive({ type: 'list', id: id.slice(5) })
      setListOverride(listOrder)
    } else {
      setActive({ type: 'card', id })
      startList.current = findList(id, columns) ?? null
      setOverride(columns)
    }
  }

  const onDragOver = (e: DragOverEvent) => {
    if (active?.type !== 'card' || !e.over) return
    const activeId = String(e.active.id)
    const overId = String(e.over.id)
    setOverride((cols) => {
      if (!cols) return cols
      const from = findList(activeId, cols)
      const to = findList(overId, cols)
      if (!from || !to || from === to) return cols
      const target = cols[to].filter((x) => x !== activeId)
      const overIndex = target.indexOf(overId)
      const index = overIndex >= 0 ? overIndex : target.length
      target.splice(index, 0, activeId)
      return { ...cols, [from]: cols[from].filter((x) => x !== activeId), [to]: target }
    })
  }

  const onDragEnd = (e: DragEndEvent) => {
    const kind = active?.type
    setActive(null)
    if (kind === 'list') {
      const activeId = String(e.active.id).slice(5)
      const overId = e.over ? String(e.over.id).replace(/^(list|drop):/, '') : null
      const order = listOrder
      const from = order.indexOf(activeId)
      const to = overId ? order.indexOf(overId) : -1
      if (to < 0 || from === to) return setListOverride(null)
      const next = arrayMove(order, from, to)
      setListOverride(next)
      moveList.mutate({ id: activeId, index: next.indexOf(activeId) })
      return
    }
    if (!override) return
    const activeId = String(e.active.id)
    let cols = override
    const listId = findList(activeId, cols)
    if (!listId) return setOverride(null)
    if (e.over) {
      const overId = String(e.over.id)
      const overList = findList(overId, cols)
      if (overList === listId && !overId.startsWith('drop:') && !overId.startsWith('list:')) {
        const arr = cols[listId]
        cols = { ...cols, [listId]: arrayMove(arr, arr.indexOf(activeId), arr.indexOf(overId)) }
      }
    }
    const vis = cols[listId]
    const i = vis.indexOf(activeId)
    // Translate the position among *visible* cards to an index in the full (unfiltered) list.
    const fullOrder = (full[listId] ?? []).filter((x) => x !== activeId)
    let index: number
    if (i > 0) index = fullOrder.indexOf(vis[i - 1]) + 1
    else if (vis.length > 1) index = Math.max(0, fullOrder.indexOf(vis[1]))
    else index = filtering ? fullOrder.length : 0
    const card = cardsById.get(activeId)
    const unchanged = card?.list_id === listId && (full[listId] ?? []).indexOf(activeId) === index
    if (unchanged) return setOverride(null)
    setOverride(cols)
    moveCard.mutate({ id: activeId, list_id: listId, index })
  }

  const activeCard = active?.type === 'card' ? cardsById.get(active.id) : undefined
  const dragDisabled = !b.can('cards.move')
  const listsById = new Map(data.lists.map((l) => [l.id, l]))

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface/60 px-4 py-2">
        <span className="h-3 w-3 rounded-sm" style={{ background: data.board.color }} />
        <h1 className="mr-2 truncate text-lg font-semibold">{data.board.name}</h1>
        <div className="relative w-full max-w-[220px]">
          <Search size={14} className="absolute left-2.5 top-2.5 text-muted" />
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={t('search.filterCards')} className="h-8 pl-8" />
        </div>
        <Button variant={mine ? 'primary' : 'outline'} size="sm" onClick={() => setMine(!mine)}>
          <User size={14} /> {t('board.onlyMine')}
        </Button>
        {data.labels.length > 0 && (
          <Menu>
            <MenuTrigger asChild>
              <Button variant={labelFilter.length ? 'primary' : 'outline'} size="sm">
                <Tag size={14} /> {t('board.labels')}
                {labelFilter.length > 0 && ` (${labelFilter.length})`}
              </Button>
            </MenuTrigger>
            <MenuContent align="start">
              {data.labels.map((l) => (
                <MenuItem
                  key={l.id}
                  onSelect={() =>
                    setLabelFilter((f) => (f.includes(l.id) ? f.filter((x) => x !== l.id) : [...f, l.id]))
                  }
                >
                  <span className="h-3 w-3 rounded-sm" style={{ background: l.color }} />
                  {l.name}
                  {labelFilter.includes(l.id) && <Check size={14} className="ml-auto" />}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        )}
        {filtering && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setText('')
              setMine(false)
              setLabelFilter([])
            }}
          >
            <X size={14} /> {t('board.clearFilters')}
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {filtering && <Filter size={14} className="text-accent" />}
          <span title={online ? t('board.live') : t('board.offline')} className={online ? 'text-green-600' : 'text-muted'}>
            {online ? <Wifi size={15} /> : <WifiOff size={15} />}
          </span>
          <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
            <Settings size={14} /> <span className="hidden sm:inline">{t('board.settings')}</span>
          </Button>
        </div>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={() => {
          setActive(null)
          setOverride(null)
          setListOverride(null)
        }}
      >
        <div className="scroll-thin flex min-h-0 flex-1 items-start gap-3 overflow-x-auto p-4">
          <SortableContext items={listOrder.map((id) => `list:${id}`)} strategy={horizontalListSortingStrategy}>
            {listOrder.map((id) => {
              const list = listsById.get(id)
              if (!list) return null
              const ids = columns[id] ?? []
              return (
                <Column
                  key={id}
                  list={list}
                  cards={ids.map((c) => cardsById.get(c)).filter((c): c is CardSummary => !!c)}
                  totalCount={(full[id] ?? []).length}
                  b={b}
                  boardId={boardId}
                  onOpen={(cid) => setSp({ card: cid })}
                  dragDisabled={dragDisabled}
                />
              )
            })}
          </SortableContext>
          {b.can('lists.manage') && <AddList boardId={boardId} />}
        </div>
        <DragOverlay dropAnimation={null}>{activeCard ? <CardGhost card={activeCard} b={b} /> : null}</DragOverlay>
      </DndContext>

      {openCard && (
        <CardModal
          key={openCard}
          cardId={openCard}
          b={b}
          onClose={() => {
            sp.delete('card')
            setSp(sp)
          }}
        />
      )}
      <BoardSettings open={settingsOpen} onOpenChange={setSettingsOpen} b={b} boardId={boardId} />
    </div>
  )
}

function AddList({ boardId }: { boardId: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const m = useMutation({
    mutationFn: () => api.post(`/boards/${boardId}/lists`, { name }),
    onSuccess: () => {
      setName('')
      qc.invalidateQueries({ queryKey: ['board', boardId] })
    },
    onError: toastError,
  })
  if (!open)
    return (
      <button
        onClick={() => setOpen(true)}
        className={clsx('flex w-[288px] shrink-0 items-center gap-1 rounded-xl border-2 border-dashed border-line px-3 py-2.5 text-sm text-muted hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer')}
      >
        <Plus size={16} /> {t('board.addList')}
      </button>
    )
  return (
    <form
      className="w-[288px] shrink-0 space-y-2 rounded-xl bg-column p-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim()) m.mutate()
      }}
    >
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
        placeholder={t('board.listName')}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      />
      <div className="flex gap-2">
        <Button variant="primary" size="sm">
          {t('common.add')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  )
}
