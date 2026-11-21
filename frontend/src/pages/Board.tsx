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
import { CalendarDays, ChartGantt, Check, Columns3, Filter, Plus, Search, Settings, SlidersHorizontal, Tag, User, Wifi, WifiOff, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { useParams, useSearchParams } from 'react-router'
import { BoardSettings } from '../components/BoardSettings'
import { Calendar, type CalItem } from '../components/Calendar'
import { Gantt } from '../components/Gantt'
import { CardContextMenu } from '../components/CardMenu'
import { ContextMenu, CTX, MItem } from '../components/menu'
import { NewCardDialog, type NewCardPreset } from '../components/NewCardDialog'
import { CardModal } from '../components/CardModal'
import { CardGhost, glimpseOf } from '../components/CardTile'
import { Column } from '../components/Column'
import { toastActivity, toastError } from '../components/toast'
import { Avatar, Button, Input, Menu, MenuContent, MenuItem, MenuTrigger, Popover, Spinner } from '../components/ui'
import { api } from '../lib/api'
import { useMe } from '../lib/auth'
import { groupCards, useBoard, useBoardSocket, type ChangeEvent, type Viewer } from '../lib/board'
import { errorText } from '../lib/i18n'
import type { BoardDetail, CardSummary } from '../lib/types'
import { avatarUrl, label } from '../lib/user'

type Columns = Record<string, string[]>

export function BoardPage() {
  const { boardId = '' } = useParams()
  const { t } = useTranslation()
  const [sp, setSp] = useSearchParams()
  const openCard = sp.get('card')
  const view = sp.get('view') === 'calendar' ? 'calendar' : sp.get('view') === 'gantt' ? 'gantt' : 'board'
  const openCardId = (cid: string) => {
    sp.set('card', cid)
    setSp(sp)
  }
  const b = useBoard(boardId)
  const { data: me } = useMe()
  // "X did Y" toasts for other people's changes; repeated events (e.g. someone typing a description) are collapsed
  const latest = useRef({ b, me })
  latest.current = { b, me }
  const lastToast = useRef(new Map<string, number>())
  const onChange = useCallback(
    (ev: ChangeEvent) => {
      const { b: cur, me: self } = latest.current
      if (!ev.actor_id || !self || ev.actor_id === self.id || ev.kind === 'resync') return
      const who = cur.members.get(ev.actor_id)
      if (!who) return
      const key = `${ev.actor_id}:${ev.card_id ?? ev.kind}`
      const now = Date.now()
      if (now - (lastToast.current.get(key) ?? 0) < 20000) return
      lastToast.current.set(key, now)
      const card = ev.card_id ? cur.data?.cards.find((c) => c.id === ev.card_id) : undefined
      const title = card?.title ?? ''
      let text: string
      if (ev.kind === 'card') text = card ? t('activity.updated', { title }) : t('activity.card')
      else if (ev.kind === 'comment') text = card ? t('activity.comment', { title }) : t('activity.card')
      else if (ev.kind === 'attachment') text = card ? t('activity.attachment', { title }) : t('activity.card')
      else if (ev.kind === 'list') text = t('activity.columns')
      else if (ev.kind === 'board_deleted') text = t('activity.archivedBoard')
      else text = t('activity.settings')
      toastActivity({ name: label(who), color: who.avatar_color, src: avatarUrl(who.avatar_id) }, text)
    },
    [t],
  )
  const { online, viewers, report } = useBoardSocket(boardId, onChange)
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    report({ card_id: openCard, editing: !!openCard && editing })
  }, [openCard, editing, report])
  // opening a card counts as reading its notifications
  const qcN = useQueryClient()
  useEffect(() => {
    if (!openCard) return
    const qc = qcN
    const unread = qc.getQueryData<{ items: { card_id: string | null; read_at: string | null }[] }>(['notifications'])
    if (unread && !unread.items.some((n) => n.card_id === openCard && !n.read_at)) return
    api.post('/notifications/read', { card_id: openCard }).then(() => qc.invalidateQueries({ queryKey: ['notifications'] }), () => {})
  }, [openCard, qcN])
  // other people here (one entry per person; their open card / editing state merged across tabs)
  const others = useMemo(() => {
    const m = new Map<string, Viewer>()
    for (const v of viewers) {
      if (v.user_id === me?.id) continue
      const prev = m.get(v.user_id)
      if (!prev || (v.card_id && !prev.card_id) || (v.editing && !prev.editing)) m.set(v.user_id, v)
    }
    return [...m.values()]
  }, [viewers, me?.id])
  const viewersByCard = useMemo(() => {
    const m = new Map<string, Viewer[]>()
    for (const v of others) if (v.card_id) m.set(v.card_id, [...(m.get(v.card_id) ?? []), v])
    return m
  }, [others])
  const qc = useQueryClient()
  const [settingsOpen, setSettingsOpenState] = useState(() => sp.get('settings') === '1')
  const setSettingsOpen = (o: boolean) => {
    setSettingsOpenState(o)
    if (!o && sp.has('settings')) {
      sp.delete('settings')
      setSp(sp, { replace: true })
    }
  }
  const [newCard, setNewCard] = useState<NewCardPreset | null>(null)

  // filters
  const [text, setText] = useState('')
  const [mine, setMine] = useState(false)
  const [labelFilter, setLabelFilter] = useState<string[]>([])
  const [statusFilter, setStatusFilter] = useState<string[]>([]) // status ids; '' = no status
  const [minPriority, setMinPriority] = useState(0) // 0 = any, -1 = no stars
  const [due, setDue] = useState<DueFilter>('any')
  const extraFilters = statusFilter.length + (minPriority !== 0 ? 1 : 0) + (due !== 'any' ? 1 : 0)
  const filtering = !!text.trim() || mine || labelFilter.length > 0 || extraFilters > 0

  const data = b.data
  const cardsById = useMemo(() => new Map((data?.cards ?? []).map((c) => [c.id, c])), [data])
  const full = useMemo(() => groupCards(data?.cards ?? []), [data])

  const visible = useMemo(() => {
    const q = text.trim().toLowerCase().replace(/^#/, '')
    const match = (c: CardSummary) => {
      if (mine && !c.assignee_ids.includes(me?.id ?? '')) return false
      if (labelFilter.length && !labelFilter.some((l) => c.label_ids.includes(l))) return false
      if (statusFilter.length && !statusFilter.includes(c.status_id ?? '')) return false
      if (minPriority === -1 ? c.priority !== 0 : c.priority < minPriority) return false
      if (!matchDue(c.due_at, due, c.done)) return false
      if (!q) return true
      const hay = [
        c.title,
        c.excerpt,
        String(c.number),
        ...c.label_ids.map((l) => b.labels.get(l)?.name ?? ''),
        ...c.assignee_ids.map((u) => { const m = b.members.get(u); return m ? label(m) : '' }),
      ]
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    }
    const out: Columns = {}
    for (const l of data?.lists ?? []) out[l.id] = (full[l.id] ?? []).filter((id) => match(cardsById.get(id)!))
    return out
  }, [data, full, text, mine, labelFilter, statusFilter, minPriority, due, me, cardsById, b.labels, b.members])

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
  const changeDue = useMutation({
    mutationFn: (p: { id: string; due: string | null }) => api.patch(`/cards/${p.id}`, { due_at: p.due }),
    onError: toastError,
    onSettled: () => qc.invalidateQueries({ queryKey: ['board', boardId] }),
  })
  // Gantt: dates and links change the cached board first, so bars don't jump back while saving
  const patchCache = (id: string, f: (c: CardSummary) => CardSummary) =>
    qc.setQueryData<BoardDetail>(['board', boardId], (d) => d && { ...d, cards: d.cards.map((c) => (c.id === id ? f(c) : c)) })
  const changeDates = useMutation({
    mutationFn: (p: { id: string; dates: { start_at?: string | null; due_at?: string | null } }) => api.patch(`/cards/${p.id}`, p.dates),
    onMutate: (p) => patchCache(p.id, (c) => ({ ...c, ...p.dates })),
    onError: toastError,
    onSettled: () => qc.invalidateQueries({ queryKey: ['board', boardId] }),
  })
  const link = useMutation({
    mutationFn: (p: { id: string; ids: string[] }) => api.put(`/cards/${p.id}/dependencies`, { ids: p.ids }),
    onMutate: (p) => patchCache(p.id, (c) => ({ ...c, depends_on: p.ids })),
    onError: toastError,
    onSettled: () => qc.invalidateQueries({ queryKey: ['board', boardId] }),
  })
  const ganttCards = useMemo(
    () => (data?.lists ?? []).flatMap((l) => (visible[l.id] ?? []).map((id) => cardsById.get(id)).filter((c): c is CardSummary => !!c)),
    [data, visible, cardsById],
  )
  const createOnDay = useMutation({
    mutationFn: (p: { list: string; title: string; due: string }) => api.post(`/lists/${p.list}/cards`, { title: p.title, due_at: p.due }),
    onError: toastError,
    onSettled: () => qc.invalidateQueries({ queryKey: ['board', boardId] }),
  })
  // calendar items follow the same filters as the board
  const calItems = useMemo(() => {
    const ids = new Set(Object.values(visible).flat())
    const toItem = (c: CardSummary): CalItem => ({
      id: c.id,
      title: c.title,
      number: c.number,
      due: c.due_at,
      color: c.status_id ? b.statuses.get(c.status_id)?.color : null,
      sub: data?.lists.find((l) => l.id === c.list_id)?.name,
      priority: c.priority,
      canMove: b.can('cards.due'),
      done: c.done,
    })
    const cards = (data?.cards ?? []).filter((c) => ids.has(c.id))
    return { dated: cards.filter((c) => c.due_at).map(toItem), undated: cards.filter((c) => !c.due_at).map(toItem) }
  }, [visible, data, b])

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
        {data.statuses.some((s) => s.is_done) && data.cards.length > 0 && <Progress done={data.cards.filter((c) => c.done).length} total={data.cards.length} />}
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
        <Popover
          trigger={
            <Button variant={extraFilters ? 'primary' : 'outline'} size="sm">
              <SlidersHorizontal size={14} /> {t('filter.title')}
              {extraFilters > 0 && ` (${extraFilters})`}
            </Button>
          }
        >
          <div className="space-y-3">
            <FilterGroup title={t('filter.status')}>
              {[...data.statuses, { id: '', name: t('filter.noStatus'), color: '#d4d4d8' }].map((st) => (
                <Chip
                  key={st.id || 'none'}
                  active={statusFilter.includes(st.id)}
                  onClick={() => setStatusFilter((f) => (f.includes(st.id) ? f.filter((x) => x !== st.id) : [...f, st.id]))}
                >
                  <span className="h-2 w-2 rounded-full" style={{ background: st.color }} />
                  {st.name}
                </Chip>
              ))}
            </FilterGroup>
            <FilterGroup title={t('filter.priority')}>
              <Chip active={minPriority === 0} onClick={() => setMinPriority(0)}>{t('filter.any')}</Chip>
              {[1, 2, 3].map((n) => (
                <Chip key={n} active={minPriority === n} onClick={() => setMinPriority(n)}>
                  {'★'.repeat(n)}
                  {n < 3 ? '+' : ''}
                </Chip>
              ))}
              <Chip active={minPriority === -1} onClick={() => setMinPriority(-1)}>{t('filter.noPriority')}</Chip>
            </FilterGroup>
            <FilterGroup title={t('filter.due')}>
              {(['any', 'overdue', 'today', 'week', 'has', 'none'] as DueFilter[]).map((k) => (
                <Chip key={k} active={due === k} onClick={() => setDue(k)}>
                  {t(`filter.${k}`)}
                </Chip>
              ))}
            </FilterGroup>
          </div>
        </Popover>
        {filtering && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setText('')
              setMine(false)
              setLabelFilter([])
              setStatusFilter([])
              setMinPriority(0)
              setDue('any')
            }}
          >
            <X size={14} /> {t('board.clearFilters')}
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <div className="flex rounded-md border border-line p-0.5">
            {(['board', 'calendar', 'gantt'] as const).map((v) => (
              <button
                key={v}
                onClick={() => {
                  if (v === 'board') sp.delete('view')
                  else sp.set('view', v)
                  setSp(sp)
                }}
                className={clsx(
                  'flex items-center gap-1 rounded px-2 py-0.5 text-xs cursor-pointer',
                  view === v ? 'bg-accent text-white' : 'text-muted hover:bg-black/5 dark:hover:bg-white/10',
                )}
              >
                {v === 'board' ? <Columns3 size={13} /> : v === 'calendar' ? <CalendarDays size={13} /> : <ChartGantt size={13} />}
                <span className="hidden sm:inline">{t(`calendar.${v}`)}</span>
              </button>
            ))}
          </div>
          {filtering && <Filter size={14} className="text-accent" />}
          <PresenceStack viewers={others} cards={cardsById} />
          <span title={online ? t('board.live') : t('board.offline')} className={online ? 'text-green-600' : 'text-muted'}>
            {online ? <Wifi size={15} /> : <WifiOff size={15} />}
          </span>
          <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
            <Settings size={14} /> <span className="hidden sm:inline">{t('board.settings')}</span>
          </Button>
        </div>
      </div>

      {view === 'gantt' ? (
        <div className="min-h-0 flex-1 pt-2">
          <Gantt
            cards={ganttCards}
            allCards={data.cards}
            lists={data.lists}
            statuses={b.statuses}
            labels={b.labels}
            members={b.members}
            onOpen={openCardId}
            onDates={b.can('cards.due') ? (id, dates) => changeDates.mutate({ id, dates }) : undefined}
            onLink={
              b.can('cards.dependencies')
                ? (id, dep) => {
                    const c = cardsById.get(id)
                    if (c && !c.depends_on.includes(dep)) link.mutate({ id, ids: [...c.depends_on, dep] })
                  }
                : undefined
            }
            toolbar={
              b.can('cards.create') && (
                <Button size="sm" variant="primary" onClick={() => setNewCard({ boardId, due: null })}>
                  <Plus size={14} /> {t('menu.newCard')}
                </Button>
              )
            }
            itemMenu={(c, trigger) => (
              <CardContextMenu card={{ ...c, board_id: boardId }} b={b} onOpen={() => openCardId(c.id)} onNew={() => setNewCard({ boardId, listId: c.list_id, due: c.due_at })}>
                {trigger}
              </CardContextMenu>
            )}
          />
        </div>
      ) : view === 'calendar' ? (
        <div className="min-h-0 flex-1">
          <Calendar
            items={calItems.dated}
            unscheduled={calItems.undated}
            glimpse={(item) => {
              const c = cardsById.get(item.id)
              return c ? glimpseOf(c, b, data.lists.find((l) => l.id === c.list_id)?.name) : null
            }}
            onOpen={openCardId}
            onMove={b.can('cards.due') ? (id, due) => changeDue.mutate({ id, due }) : undefined}
            onCreate={
              b.can('cards.create') && data.lists.length
                ? (due, title) => createOnDay.mutateAsync({ list: (data.lists.find((l) => !l.folded) ?? data.lists[0]).id, title, due })
                : undefined
            }
            onNewAt={b.can('cards.create') ? (due) => setNewCard({ boardId, due }) : undefined}
            toolbar={
              b.can('cards.create') && (
                <Button size="sm" variant="primary" onClick={() => setNewCard({ boardId, due: null })}>
                  <Plus size={14} /> {t('menu.newCard')}
                </Button>
              )
            }
            itemMenu={(item, trigger) => {
              const c = cardsById.get(item.id)
              if (!c) return trigger
              return (
                <CardContextMenu
                  card={{ ...c, board_id: boardId }}
                  b={b}
                  onOpen={() => openCardId(c.id)}
                  onNew={() => setNewCard({ boardId, listId: c.list_id, due: c.due_at })}
                >
                  {trigger}
                </CardContextMenu>
              )
            }}
            dayMenu={
              b.can('cards.create')
                ? (due, trigger) => (
                    <ContextMenu trigger={trigger}>
                      <MItem M={CTX} onSelect={() => setNewCard({ boardId, due })}>
                        <Plus size={14} /> {t('menu.newCardOnDay')}
                      </MItem>
                    </ContextMenu>
                  )
                : undefined
            }
          />
        </div>
      ) : (
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
                  onOpen={openCardId}
                  dragDisabled={dragDisabled}
                  viewersByCard={viewersByCard}
                />
              )
            })}
          </SortableContext>
          {b.can('lists.create') && <AddList boardId={boardId} />}
        </div>
        <DragOverlay dropAnimation={null}>{activeCard ? <CardGhost card={activeCard} b={b} /> : null}</DragOverlay>
      </DndContext>
      )}

      {openCard && (
        <CardModal
          key={openCard}
          cardId={openCard}
          viewers={viewersByCard.get(openCard) ?? []}
          onEditingChange={setEditing}
          b={b}
          onClose={() => {
            sp.delete('card')
            setSp(sp)
          }}
        />
      )}
      {newCard && (
        <NewCardDialog
          preset={newCard}
          onClose={() => setNewCard(null)}
          onCreated={(c, _board, open) => open && openCardId(c.id)}
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

type DueFilter = 'any' | 'overdue' | 'today' | 'week' | 'has' | 'none'

function matchDue(dueAt: string | null, f: DueFilter, done = false) {
  if (f === 'any') return true
  if (f === 'none') return !dueAt
  if (!dueAt) return false
  if (f === 'has') return true
  const d = new Date(dueAt)
  const now = new Date()
  if (f === 'overdue') return d < now && !done
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const endToday = new Date(startToday.getTime() + 86400000)
  if (f === 'today') return d >= startToday && d < endToday
  return d >= startToday && d < new Date(startToday.getTime() + 8 * 86400000) // week: today + next 7 days
}

function FilterGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-muted">{title}</div>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs cursor-pointer',
        active ? 'border-accent bg-accent/10 font-medium text-accent dark:text-[#a9bdf5]' : 'border-line text-muted hover:bg-black/5 dark:hover:bg-white/5',
      )}
    >
      {children}
    </button>
  )
}

/** Avatars of the other people on this board; hover shows what each is doing. */
function PresenceStack({ viewers, cards }: { viewers: Viewer[]; cards: Map<string, CardSummary> }) {
  const { t } = useTranslation()
  if (!viewers.length) return null
  const shown = viewers.slice(0, 5)
  const what = (v: Viewer) => {
    const c = v.card_id ? cards.get(v.card_id) : undefined
    if (!c) return t('presence.viewing')
    return t(v.editing ? 'presence.editingCard' : 'presence.onCard', { number: c.number, title: c.title })
  }
  return (
    <div className="flex items-center -space-x-1.5" aria-label={t('presence.here')}>
      {shown.map((v) => (
        <span key={v.user_id} className="relative" title={`${label(v)} · ${what(v)}`}>
          <Avatar name={label(v)} color={v.avatar_color} src={avatarUrl(v.avatar_id)} size={26} />
          <span
            className={clsx(
              'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-[var(--surface)]',
              v.editing ? 'animate-pulse bg-amber-500' : 'bg-green-500',
            )}
          />
        </span>
      ))}
      {viewers.length > shown.length && <span className="pl-2.5 text-xs text-muted">+{viewers.length - shown.length}</span>}
    </div>
  )
}

/** "12 / 20 done" with a small bar. */
export function Progress({ done, total }: { done: number; total: number }) {
  const { t } = useTranslation()
  const pct = total ? Math.round((done / total) * 100) : 0
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted" title={t('board.progress', { done, total, pct })}>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
        <span className="block h-full rounded-full bg-done" style={{ width: `${pct}%` }} />
      </span>
      {t('board.doneOf', { done, total })}
    </span>
  )
}
