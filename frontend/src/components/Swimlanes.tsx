/**
 * The board split into rows (lanes) by assignee, label, priority, status or department, with the columns repeated in
 * every lane. Each person picks their own grouping (kept in this browser, per board).
 *
 * A card sits in exactly one lane. With several assignees or labels that is the first one in the board's order (the
 * members' names, the labels' names); a card's department is that of this first assignee. Dragging a card to another
 * lane changes that field: the lane it came from is swapped for the new one (other assignees or labels stay), and the
 * "none" lane clears the field. Department lanes can't be changed by dragging (a card has no department of its own).
 */
import {
  closestCorners,
  DndContext,
  DragOverlay,
  pointerWithin,
  useDroppable,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api'
import type { BoardHelpers, Viewer } from '../lib/board'
import { useDepartments } from '../lib/departments'
import { useDragSensors } from '../lib/dnd'
import type { CardSummary, List } from '../lib/types'
import { avatarUrl, label as userLabel } from '../lib/user'
import { CardGhost, CardTile } from './CardTile'
import { toast, toastError } from './toast'
import { Avatar } from './ui'

export type LaneBy = 'assignee' | 'label' | 'priority' | 'status' | 'department'
export const LANE_OPTIONS: LaneBy[] = ['assignee', 'label', 'priority', 'status', 'department']

/** The grouping chosen for a board, kept in this browser. */
export function loadLanes(boardId: string): { by: LaneBy | null; empty: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(`kanb.lanes.${boardId}`) ?? 'null')
    if (v && (v.by === null || LANE_OPTIONS.includes(v.by))) return { by: v.by, empty: !!v.empty }
  } catch {
    /* private window, blocked storage: no grouping */
  }
  return { by: null, empty: false }
}
export function saveLanes(boardId: string, v: { by: LaneBy | null; empty: boolean }) {
  try {
    localStorage.setItem(`kanb.lanes.${boardId}`, JSON.stringify(v))
  } catch {
    /* not kept: fine */
  }
}

interface Lane {
  key: string // 'none' or the value's id (user, label, status, department) or priority number
  name: string
  dot?: string
  avatar?: { name: string; color: string; src?: string }
}

type Cells = Record<string, string[]> // `${lane}|${list}` → card ids, in order

const cellKey = (lane: string, list: string) => `${lane}|${list}`
const splitCell = (k: string) => {
  const i = k.lastIndexOf('|')
  return { lane: k.slice(0, i), list: k.slice(i + 1) }
}

export function Swimlanes({
  b,
  boardId,
  by,
  showEmpty,
  visible,
  full,
  filtering,
  onOpen,
  dragDisabled,
  viewersByCard,
}: {
  b: BoardHelpers
  boardId: string
  by: LaneBy
  showEmpty: boolean
  /** each column's cards after the filters, in order */
  visible: Record<string, string[]>
  /** each column's cards, in order */
  full: Record<string, string[]>
  filtering: boolean
  onOpen: (id: string) => void
  dragDisabled: boolean
  viewersByCard: Map<string, Viewer[]>
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const deps = useDepartments().data ?? []
  const data = b.data!
  const cardsById = useMemo(() => new Map(data.cards.map((c) => [c.id, c])), [data.cards])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [override, setOverride] = useState<Cells | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const sensors = useDragSensors(6)

  // the board's order for "first assignee / first label"
  const memberOrder = useMemo(() => new Map(data.members.map((m, i) => [m.user_id, i])), [data.members])
  const labelOrder = useMemo(() => new Map(data.labels.map((l, i) => [l.id, i])), [data.labels])
  const first = (ids: string[], order: Map<string, number>) =>
    [...ids].filter((x) => order.has(x)).sort((x, y) => order.get(x)! - order.get(y)!)[0] as string | undefined

  const laneOf = (c: CardSummary): string => {
    switch (by) {
      case 'assignee':
        return first(c.assignee_ids, memberOrder) ?? 'none'
      case 'label':
        return first(c.label_ids, labelOrder) ?? 'none'
      case 'priority':
        return String(c.priority)
      case 'status':
        return c.status_id ?? 'none'
      case 'department': {
        const who = first(c.assignee_ids, memberOrder)
        return (who && b.members.get(who)?.department_id) || 'none'
      }
    }
  }

  const allLanes: Lane[] = useMemo(() => {
    const none = { key: 'none', name: t(`lanes.none_${by}`) }
    switch (by) {
      case 'assignee':
        return [
          ...data.members.map((m) => ({ key: m.user_id, name: userLabel(m), avatar: { name: userLabel(m), color: m.avatar_color, src: avatarUrl(m.avatar_id) ?? undefined } })),
          none,
        ]
      case 'label':
        return [...data.labels.map((l) => ({ key: l.id, name: l.name, dot: l.color })), none]
      case 'priority':
        return [3, 2, 1].map((p) => ({ key: String(p), name: '★'.repeat(p) })).concat({ key: '0', name: t('lanes.none_priority') })
      case 'status':
        return [...data.statuses.map((s) => ({ key: s.id, name: s.name, dot: s.color })), none]
      case 'department':
        return [...deps.map((d) => ({ key: d.id, name: d.name, dot: d.color })), none]
    }
  }, [by, data.members, data.labels, data.statuses, deps, t])

  const lists = data.lists
  // the filtered cards, cell by cell
  const cells: Cells = useMemo(() => {
    const out: Cells = {}
    for (const l of lists) {
      for (const id of visible[l.id] ?? []) {
        const c = cardsById.get(id)
        if (!c) continue
        ;(out[cellKey(laneOf(c), l.id)] ??= []).push(id)
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lists, visible, cardsById, by, memberOrder, labelOrder, b.members])
  const shown = override ?? cells
  const laneCount = (lane: string) => lists.reduce((n, l) => n + (shown[cellKey(lane, l.id)]?.length ?? 0), 0)
  const alwaysAll = by === 'priority' || by === 'status'
  const lanes = allLanes.filter((l) => alwaysAll || showEmpty || laneCount(l.key) > 0)

  const findCell = (id: string, cs: Cells): string | undefined => {
    if (id.startsWith('drop:')) return id.slice(5)
    return Object.keys(cs).find((k) => cs[k].includes(id))
  }

  const collision: CollisionDetection = (args) => {
    const within = pointerWithin(args)
    const card = within.find((c) => !String(c.id).startsWith('drop:'))
    if (card) return [card]
    if (within.length) return within
    return closestCorners(args)
  }

  const onDragStart = (e: DragStartEvent) => {
    setActive(String(e.active.id))
    setOverride(shown)
  }
  const onDragOver = (e: DragOverEvent) => {
    if (!e.over) return
    const activeId = String(e.active.id)
    const overId = String(e.over.id)
    setOverride((cs) => {
      if (!cs) return cs
      const from = findCell(activeId, cs)
      const to = findCell(overId, cs)
      if (!from || !to || from === to) return cs
      const target = (cs[to] ?? []).filter((x) => x !== activeId)
      const at = target.indexOf(overId)
      target.splice(at >= 0 ? at : target.length, 0, activeId)
      return { ...cs, [from]: cs[from].filter((x) => x !== activeId), [to]: target }
    })
  }

  const finish = async () => {
    await qc.invalidateQueries({ queryKey: ['board', boardId] })
    setOverride(null)
  }

  /** The field change for moving `c` from lane `from` to lane `to`; null when nothing changes. */
  const laneChange = (c: CardSummary, from: string, to: string): { perm: string; run: () => Promise<unknown> } | 'refused' | null => {
    if (from === to) return null
    const swap = (ids: string[]) => {
      const next = ids.filter((x) => x !== from)
      return to === 'none' ? [] : next.includes(to) ? next : [...next, to]
    }
    switch (by) {
      case 'assignee':
        return { perm: 'cards.assign', run: () => api.put(`/cards/${c.id}/assignees`, { ids: swap(c.assignee_ids) }) }
      case 'label':
        return { perm: 'cards.labels', run: () => api.put(`/cards/${c.id}/labels`, { ids: swap(c.label_ids) }) }
      case 'priority':
        return { perm: 'cards.edit', run: () => api.patch(`/cards/${c.id}`, { priority: Number(to) }) }
      case 'status':
        return { perm: 'cards.status', run: () => api.patch(`/cards/${c.id}`, { status_id: to === 'none' ? null : to }) }
      case 'department':
        return 'refused'
    }
  }

  const onDragEnd = async (e: DragEndEvent) => {
    const activeId = String(e.active.id)
    setActive(null)
    let cs = override
    if (!cs) return
    const target = findCell(activeId, cs)
    const card = cardsById.get(activeId)
    if (!target || !card) return setOverride(null)
    // reordering inside one cell
    if (e.over) {
      const overId = String(e.over.id)
      if (findCell(overId, cs) === target && !overId.startsWith('drop:')) {
        const arr = [...cs[target]]
        const from = arr.indexOf(activeId)
        const to = arr.indexOf(overId)
        arr.splice(to, 0, ...arr.splice(from, 1))
        cs = { ...cs, [target]: arr }
        setOverride(cs)
      }
    }
    const { lane, list } = splitCell(target)
    const fromLane = laneOf(card)
    // where in the whole column: after the card above it in this cell, or before the one below
    const vis = cs[target]
    const i = vis.indexOf(activeId)
    const fullOrder = (full[list] ?? []).filter((x) => x !== activeId)
    let index: number
    if (i > 0) index = fullOrder.indexOf(vis[i - 1]) + 1
    else if (vis.length > 1) index = Math.max(0, fullOrder.indexOf(vis[1]))
    else index = filtering || lane !== fromLane ? fullOrder.length : 0
    const moved = card.list_id !== list || (full[list] ?? []).indexOf(activeId) !== index

    const change = laneChange(card, fromLane, lane)
    if (change === 'refused') {
      toast(t('lanes.cantChangeDepartment'), 'error')
      return setOverride(null)
    }
    if (change && !b.canCard(change.perm, card)) {
      toast(t('errors.forbidden'), 'error')
      return setOverride(null)
    }
    if (!change && !moved) return setOverride(null)
    try {
      // the field first, then the place: if the field can't change, the card doesn't half-move
      if (change) await change.run()
      if (moved) await api.post(`/cards/${activeId}/move`, { list_id: list, index })
    } catch (err) {
      toastError(err)
    } finally {
      await finish()
    }
  }

  const toggle = (k: string) =>
    setCollapsed((s) => {
      const n = new Set(s)
      if (!n.delete(k)) n.add(k)
      return n
    })
  const columnTotal = (l: List) => (full[l.id] ?? []).length

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => (setActive(null), setOverride(null))}
    >
      <div className="scroll-thin min-h-0 flex-1 overflow-auto p-4 pt-0">
        <div className="w-max min-w-full">
          {/* the columns, once, above every lane */}
          <div className="sticky top-0 z-20 flex gap-3 bg-[var(--bg)] pb-2 pt-4">
            {lists.map((l) => {
              const over = !!l.wip_limit && columnTotal(l) > l.wip_limit
              return (
                <div key={l.id} className={clsx('flex shrink-0 items-center gap-1.5 rounded-lg bg-column px-3 py-2', l.folded ? 'w-10' : 'w-[288px]')} title={l.name}>
                  {l.color && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: l.color }} />}
                  {!l.folded && <span className="flex-1 truncate text-sm font-semibold">{l.name}</span>}
                  {!l.folded && (
                    <span className={clsx('text-xs tabular-nums', over ? 'font-semibold text-red-600 dark:text-red-400' : 'text-muted')}>
                      {columnTotal(l)}
                      {l.wip_limit ? ` / ${l.wip_limit}` : ''}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
          {lanes.map((lane) => {
            const shut = collapsed.has(lane.key)
            const n = laneCount(lane.key)
            return (
              <section key={lane.key} className="mb-3" aria-label={lane.name}>
                <button
                  onClick={() => toggle(lane.key)}
                  className="sticky left-0 mb-1.5 flex max-w-[calc(100vw-2rem)] items-center gap-1.5 rounded-md px-1 py-1 text-sm font-semibold hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer"
                  aria-expanded={!shut}
                >
                  {shut ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                  {lane.avatar && <Avatar name={lane.avatar.name} color={lane.avatar.color} src={lane.avatar.src} size={20} />}
                  {lane.dot && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: lane.dot }} />}
                  <span className={clsx('truncate', lane.key === 'none' && 'text-muted', lane.key === '0' && by === 'priority' && 'text-muted', by === 'priority' && lane.key !== '0' && 'text-amber-500')}>
                    {lane.name}
                  </span>
                  <span className="text-xs font-normal text-muted tabular-nums">{n}</span>
                </button>
                {!shut && (
                  <div className="flex gap-3 border-b border-line pb-3">
                    {lists.map((l) =>
                      l.folded ? (
                        <div key={l.id} className="w-10 shrink-0 rounded-lg bg-column/60" />
                      ) : (
                        <Cell
                          key={l.id}
                          id={cellKey(lane.key, l.id)}
                          cards={(shown[cellKey(lane.key, l.id)] ?? []).map((id) => cardsById.get(id)).filter((c): c is CardSummary => !!c)}
                          b={b}
                          onOpen={onOpen}
                          dragDisabled={dragDisabled}
                          viewersByCard={viewersByCard}
                        />
                      ),
                    )}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      </div>
      <DragOverlay dropAnimation={null}>{active && cardsById.get(active) ? <CardGhost card={cardsById.get(active)!} b={b} /> : null}</DragOverlay>
    </DndContext>
  )
}

function Cell({
  id,
  cards,
  b,
  onOpen,
  dragDisabled,
  viewersByCard,
}: {
  id: string
  cards: CardSummary[]
  b: BoardHelpers
  onOpen: (id: string) => void
  dragDisabled: boolean
  viewersByCard: Map<string, Viewer[]>
}) {
  const drop = useDroppable({ id: `drop:${id}` })
  return (
    <div ref={drop.setNodeRef} className={clsx('flex min-h-16 w-[288px] shrink-0 flex-col gap-2 rounded-xl bg-column p-2', drop.isOver && 'ring-2 ring-accent/40')}>
      <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        {cards.map((c) => (
          <CardTile key={c.id} card={c} b={b} onOpen={onOpen} disabled={dragDisabled} viewers={viewersByCard.get(c.id)} />
        ))}
      </SortableContext>
    </div>
  )
}
