import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import clsx from 'clsx'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Popover } from './ui'

export interface CalItem {
  id: string
  title: string
  number: number
  due: string | null
  /** left accent (status colour on a board, board colour on the global calendar) */
  color?: string | null
  /** extra line in the tooltip, e.g. "Board · Column" */
  sub?: string
  priority: number
  canMove: boolean
}

type Mode = 'month' | 'week'

const pad = (n: number) => String(n).padStart(2, '0')
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
/** Weeks start on Monday. */
const startOfWeek = (d: Date) => addDays(d, -((d.getDay() + 6) % 7))

export function visibleRange(cursor: Date, mode: Mode): { start: Date; days: number } {
  if (mode === 'week') return { start: startOfWeek(cursor), days: 7 }
  return { start: startOfWeek(new Date(cursor.getFullYear(), cursor.getMonth(), 1)), days: 42 }
}

/** New due date on `day`, keeping the card's time of day (09:00 for cards that had none). */
function moveTo(day: Date, previous: string | null) {
  const p = previous ? new Date(previous) : null
  const d = new Date(day.getFullYear(), day.getMonth(), day.getDate(), p ? p.getHours() : 9, p ? p.getMinutes() : 0)
  return d.toISOString()
}

export function Calendar({
  items,
  unscheduled,
  onOpen,
  onMove,
  onCreate,
  onRange,
  toolbar,
}: {
  items: CalItem[]
  unscheduled?: CalItem[]
  onOpen: (id: string) => void
  onMove?: (id: string, due: string | null) => void
  onCreate?: (due: string, title: string) => Promise<unknown> | void
  onRange?: (from: Date, to: Date) => void
  toolbar?: ReactNode
}) {
  const { t, i18n } = useTranslation()
  const loc = i18n.language === 'th' ? 'th-TH' : 'en-GB'
  const [cursor, setCursor] = useState(() => new Date())
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem('calendar-mode') as Mode) || 'month')
  const [override, setOverride] = useState<Record<string, string | null>>({})
  const [dragging, setDragging] = useState<CalItem | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const { start, days } = visibleRange(cursor, mode)
  useEffect(() => {
    onRange?.(start, addDays(start, days))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start.getTime(), days])
  // fresh data from the server replaces optimistic moves
  useEffect(() => setOverride({}), [items, unscheduled])
  useEffect(() => {
    try {
      localStorage.setItem('calendar-mode', mode)
    } catch {
      /* ignore */
    }
  }, [mode])

  const all = useMemo(() => [...items, ...(unscheduled ?? [])].map((i) => (i.id in override ? { ...i, due: override[i.id] } : i)), [items, unscheduled, override])
  const byDay = useMemo(() => {
    const m = new Map<string, CalItem[]>()
    for (const i of all) if (i.due) {
      const k = dayKey(new Date(i.due))
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(i)
    }
    for (const v of m.values()) v.sort((a, b) => (a.due! < b.due! ? -1 : a.due! > b.due! ? 1 : b.priority - a.priority))
    return m
  }, [all])
  const noDue = all.filter((i) => !i.due)

  const title =
    mode === 'month'
      ? cursor.toLocaleDateString(loc, { month: 'long', year: 'numeric' })
      : `${start.toLocaleDateString(loc, { day: 'numeric', month: 'short' })} – ${addDays(start, 6).toLocaleDateString(loc, { day: 'numeric', month: 'short', year: 'numeric' })}`
  const step = (n: number) =>
    setCursor((c) => (mode === 'month' ? new Date(c.getFullYear(), c.getMonth() + n, 1) : addDays(c, 7 * n)))

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null)
    if (!e.over || !onMove) return
    const id = String(e.active.id).slice(5)
    const item = all.find((i) => i.id === id)
    if (!item) return
    const target = String(e.over.id).slice(4)
    const due = target === 'none' ? null : moveTo(new Date(`${target}T00:00`), item.due)
    if (due === item.due || (due && item.due && dayKey(new Date(due)) === dayKey(new Date(item.due)))) return
    setOverride((o) => ({ ...o, [id]: due }))
    onMove(id, due)
  }

  const weekdays = Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(new Date()), i).toLocaleDateString(loc, { weekday: 'short' }))
  const today = dayKey(new Date())

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin /* the day under the mouse, not the one the chip overlaps most */}
      onDragStart={(e) => setDragging(all.find((i) => `item:${i.id}` === e.active.id) ?? null)}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <div className="flex h-full min-h-0 gap-3 p-4">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => setCursor(new Date())}>
              {t('calendar.today')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => step(-1)} aria-label="previous">
              <ChevronLeft size={16} />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => step(1)} aria-label="next">
              <ChevronRight size={16} />
            </Button>
            <h2 className="text-lg font-semibold">{title}</h2>
            <div className="ml-auto flex items-center gap-2">
              {toolbar}
              <div className="flex rounded-md border border-line p-0.5">
                {(['month', 'week'] as Mode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={clsx('rounded px-2.5 py-0.5 text-xs cursor-pointer', mode === m ? 'bg-accent text-white' : 'text-muted hover:bg-black/5 dark:hover:bg-white/10')}
                  >
                    {t(`calendar.${m}`)}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-7 border-l border-t border-line text-xs font-medium text-muted">
            {weekdays.map((w, i) => (
              <div key={i} className="border-b border-r border-line bg-surface px-2 py-1.5">
                {w}
              </div>
            ))}
          </div>
          <div className={clsx('grid min-h-0 flex-1 grid-cols-7 border-l border-line', mode === 'month' ? 'auto-rows-fr' : 'grid-rows-1')}>
            {Array.from({ length: days }, (_, i) => {
              const d = addDays(start, i)
              const k = dayKey(d)
              return (
                <Day
                  key={k}
                  date={d}
                  dayKey_={k}
                  isToday={k === today}
                  outside={mode === 'month' && d.getMonth() !== cursor.getMonth()}
                  weekend={d.getDay() === 0 || d.getDay() === 6}
                  items={byDay.get(k) ?? []}
                  limit={mode === 'month' ? 3 : Infinity}
                  onOpen={onOpen}
                  onCreate={onCreate ? (title) => onCreate(moveTo(d, null), title) : undefined}
                  draggable={!!onMove}
                />
              )
            })}
          </div>
        </div>
        {unscheduled && (
          <Unscheduled items={noDue} onOpen={onOpen} draggable={!!onMove} />
        )}
      </div>
      <DragOverlay dropAnimation={null}>{dragging ? <Chip item={dragging} ghost /> : null}</DragOverlay>
    </DndContext>
  )
}

function Day({
  date,
  dayKey_,
  isToday,
  outside,
  weekend,
  items,
  limit,
  onOpen,
  onCreate,
  draggable,
}: {
  date: Date
  dayKey_: string
  isToday: boolean
  outside: boolean
  weekend: boolean
  items: CalItem[]
  limit: number
  onOpen: (id: string) => void
  onCreate?: (title: string) => Promise<unknown> | void
  draggable: boolean
}) {
  const { t } = useTranslation()
  const { setNodeRef, isOver } = useDroppable({ id: `day:${dayKey_}` })
  const [adding, setAdding] = useState(false)
  const shown = items.slice(0, limit)
  const rest = items.length - shown.length
  return (
    <div
      ref={setNodeRef}
      className={clsx(
        'group/day flex min-h-24 min-w-0 flex-col gap-1 overflow-hidden border-b border-r border-line p-1',
        weekend ? 'bg-surface-2' : 'bg-surface',
        outside && 'opacity-50',
        isOver && 'ring-2 ring-inset ring-accent',
      )}
    >
      <div className="flex items-center justify-between px-1">
        <span
          className={clsx(
            'flex h-6 min-w-6 items-center justify-center rounded-full text-xs',
            isToday ? 'bg-accent font-semibold text-white' : 'text-muted',
          )}
        >
          {date.getDate()}
        </span>
        {onCreate && !adding && (
          <button
            onClick={() => setAdding(true)}
            className="rounded p-0.5 text-muted opacity-0 hover:bg-black/5 group-hover/day:opacity-100 cursor-pointer dark:hover:bg-white/10"
            title={t('calendar.addCard')}
          >
            <Plus size={14} />
          </button>
        )}
      </div>
      {adding && onCreate && (
        <input
          autoFocus
          placeholder={t('board.cardTitle')}
          className="w-full rounded border border-line bg-surface px-1.5 py-0.5 text-xs outline-none focus:ring-2 focus:ring-accent/60"
          onBlur={() => setAdding(false)}
          onKeyDown={async (e) => {
            if (e.key === 'Escape') setAdding(false)
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              const v = e.currentTarget.value.trim()
              if (v) await onCreate(v)
              setAdding(false)
            }
          }}
        />
      )}
      <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
        {shown.map((i) => (
          <DraggableChip key={i.id} item={i} onOpen={onOpen} draggable={draggable && i.canMove} />
        ))}
      </div>
      {rest > 0 && (
        <Popover
          trigger={<button className="px-1 text-left text-[11px] text-muted hover:underline cursor-pointer">{t('calendar.more', { count: rest })}</button>}
        >
          <div className="mb-1 text-xs font-medium">{date.toLocaleDateString()}</div>
          <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
            {items.map((i) => (
              <Chip key={i.id} item={i} onClick={() => onOpen(i.id)} />
            ))}
          </div>
        </Popover>
      )}
    </div>
  )
}

function Unscheduled({ items, onOpen, draggable }: { items: CalItem[]; onOpen: (id: string) => void; draggable: boolean }) {
  const { t } = useTranslation()
  const { setNodeRef, isOver } = useDroppable({ id: 'day:none' })
  return (
    <aside
      ref={setNodeRef}
      className={clsx('hidden w-56 shrink-0 flex-col rounded-xl bg-column p-2 lg:flex', isOver && 'ring-2 ring-accent')}
    >
      <div className="mb-1 px-1 text-sm font-semibold">
        {t('calendar.unscheduled')} <span className="font-normal text-muted">{items.length}</span>
      </div>
      <p className="mb-2 px-1 text-[11px] text-muted">{t('calendar.dragHint')}</p>
      <div className="scroll-thin flex min-h-0 flex-col gap-1 overflow-y-auto">
        {items.map((i) => (
          <DraggableChip key={i.id} item={i} onOpen={onOpen} draggable={draggable && i.canMove} />
        ))}
      </div>
    </aside>
  )
}

function DraggableChip({ item, onOpen, draggable }: { item: CalItem; onOpen: (id: string) => void; draggable: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `item:${item.id}`, disabled: !draggable })
  return (
    <div ref={setNodeRef} {...attributes} aria-disabled={undefined} {...listeners} className={clsx(isDragging && 'opacity-30')}>
      <Chip item={item} onClick={() => onOpen(item.id)} />
    </div>
  )
}

function Chip({ item, onClick, ghost }: { item: CalItem; onClick?: () => void; ghost?: boolean }) {
  const { i18n } = useTranslation()
  const due = item.due ? new Date(item.due) : null
  const time = due && (due.getHours() || due.getMinutes()) ? due.toLocaleTimeString(i18n.language === 'th' ? 'th-TH' : 'en-GB', { hour: '2-digit', minute: '2-digit' }) : ''
  const overdue = due && due < new Date()
  return (
    <button
      type="button"
      onClick={onClick}
      title={[`#${item.number} ${item.title}`, item.sub].filter(Boolean).join('\n')}
      className={clsx(
        'flex w-full min-w-0 items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 text-left text-[12px] leading-tight shadow-sm hover:border-accent/50 cursor-pointer',
        ghost && 'w-48 rotate-2 shadow-lg',
      )}
      style={{ borderLeft: `3px solid ${item.color ?? 'var(--border)'}` }}
    >
      {time && <span className={clsx('shrink-0 tabular-nums', overdue ? 'text-red-600' : 'text-muted')}>{time}</span>}
      <span className="min-w-0 flex-1 truncate">{item.title}</span>
      {item.priority > 0 && <span className="shrink-0 text-[10px] text-amber-500">{'★'.repeat(item.priority)}</span>}
    </button>
  )
}
