import clsx from 'clsx'
import { ChevronRight, Crosshair } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactElement, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { CardSummary, List, Status } from '../lib/types'

type Zoom = 'day' | 'week' | 'month'
const PX: Record<Zoom, number> = { day: 36, week: 14, month: 4 }
const ROW = 34
const HEAD = 46
const DAY = 86_400_000

/** Local midnight of a date. */
function midnight(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}
function addDays(d: Date, n: number) {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}
/** Whole local days from `origin` (DST-safe). */
function dayIndex(origin: Date, d: Date) {
  return Math.round((midnight(d).getTime() - origin.getTime()) / DAY)
}
/** Same date and time, n days later (local calendar days). */
function shiftIso(iso: string, n: number) {
  return addDays(new Date(iso), n).toISOString()
}
function atTime(day: Date, h: number) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, 0).toISOString()
}

interface Geo {
  x0: number // first day (inclusive)
  x1: number // day after the last (exclusive)
  kind: 'bar' | 'open' | 'milestone'
}

type Drag =
  | { mode: 'move' | 'start' | 'end'; id: string; x: number; delta: number; moved: boolean }
  | { mode: 'create'; id: string; from: number; to: number }
  | { mode: 'link'; id: string; x: number; y: number; px: number; py: number }

export function Gantt({
  cards,
  allCards,
  lists,
  statuses,
  onOpen,
  onDates,
  onLink,
  itemMenu,
  toolbar,
}: {
  cards: CardSummary[]
  allCards: CardSummary[]
  lists: List[]
  statuses: Map<string, Status>
  onOpen: (id: string) => void
  /** null = clear; omitted from the call = unchanged */
  onDates?: (id: string, dates: { start_at?: string | null; due_at?: string | null }) => void
  /** `cardId` will wait for `dependsOn` */
  onLink?: (cardId: string, dependsOn: string) => void
  itemMenu?: (card: CardSummary, trigger: ReactElement) => ReactNode
  toolbar?: ReactNode
}) {
  const { t, i18n } = useTranslation()
  const [zoom, setZoom] = useState<Zoom>(() => (localStorage.getItem('gantt.zoom') as Zoom) || 'day')
  const [collapsed, setCollapsed] = useState<string[]>([])
  const [drag, setDrag] = useState<Drag | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const px = PX[zoom]
  const narrow = typeof window !== 'undefined' && window.innerWidth < 640
  const LEFT = narrow ? 150 : 260
  const locale = i18n.language === 'th' ? 'th-TH' : 'en-GB'

  useEffect(() => {
    try {
      localStorage.setItem('gantt.zoom', zoom)
    } catch {
      /* private mode */
    }
  }, [zoom])

  // timeline range: all dates plus today, padded, starting on a Monday
  const { origin, days } = useMemo(() => {
    const today = midnight(new Date())
    let lo = addDays(today, -14)
    let hi = addDays(today, 45)
    for (const c of cards)
      for (const iso of [c.start_at, c.due_at]) {
        if (!iso) continue
        const d = midnight(new Date(iso))
        if (d < lo) lo = addDays(d, -7)
        if (d > hi) hi = addDays(d, 21)
      }
    lo = addDays(lo, -((lo.getDay() + 6) % 7))
    if (zoom === 'month') {
      lo = new Date(lo.getFullYear(), lo.getMonth(), 1)
      hi = new Date(hi.getFullYear(), hi.getMonth() + 2, 0)
    }
    return { origin: lo, days: dayIndex(lo, hi) + 1 }
  }, [cards, zoom])
  const W = days * px

  const geo = (c: CardSummary): Geo | null => {
    const s = c.start_at ? dayIndex(origin, new Date(c.start_at)) : null
    const d = c.due_at ? dayIndex(origin, new Date(c.due_at)) : null
    if (s !== null && d !== null) return { x0: Math.min(s, d), x1: Math.max(s, d) + 1, kind: 'bar' }
    if (s !== null) return { x0: s, x1: s + 1, kind: 'open' }
    if (d !== null) return { x0: d, x1: d + 1, kind: 'milestone' }
    return null
  }
  // geometry including an in-progress drag
  const liveGeo = (c: CardSummary): Geo | null => {
    const g = geo(c)
    if (!drag || drag.id !== c.id) return g
    if (drag.mode === 'create') return { x0: Math.min(drag.from, drag.to), x1: Math.max(drag.from, drag.to) + 1, kind: 'bar' }
    if (!g || drag.mode === 'link') return g
    const d = drag.delta
    if (drag.mode === 'move') return { ...g, x0: g.x0 + d, x1: g.x1 + d }
    if (drag.mode === 'start') return { ...g, x0: Math.min(g.x0 + d, g.x1 - 1) }
    return { ...g, x1: Math.max(g.x1 + d, g.x0 + 1) }
  }

  // rows: columns in board order, their cards below
  const rows = useMemo(() => {
    const out: ({ type: 'list'; list: List; count: number } | { type: 'card'; card: CardSummary })[] = []
    for (const l of lists) {
      const cs = cards.filter((c) => c.list_id === l.id)
      if (!cs.length) continue
      out.push({ type: 'list', list: l, count: cs.length })
      if (!collapsed.includes(l.id)) for (const c of cs) out.push({ type: 'card', card: c })
    }
    return out
  }, [cards, lists, collapsed])
  const rowOf = new Map<string, number>()
  rows.forEach((r, i) => r.type === 'card' && rowOf.set(r.card.id, i))
  const H = rows.length * ROW

  const todayX = ((Date.now() - origin.getTime()) / DAY) * px
  const scrollToToday = () => {
    const el = scroller.current
    if (el) el.scrollLeft = Math.max(0, todayX - (el.clientWidth - LEFT) / 3)
  }
  useLayoutEffect(scrollToToday, [zoom]) // eslint-disable-line react-hooks/exhaustive-deps

  // header ticks
  const header = useMemo(() => {
    const top: { x: number; w: number; label: string }[] = []
    const bottom: { x: number; label: string; weekend?: boolean }[] = []
    let cur = ''
    for (let i = 0; i < days; i++) {
      const d = addDays(origin, i)
      const key = zoom === 'month' ? `${d.getFullYear()}` : `${d.getFullYear()}-${d.getMonth()}`
      if (key !== cur) {
        cur = key
        top.push({ x: i * px, w: 0, label: zoom === 'month' ? d.toLocaleDateString(locale, { year: 'numeric' }) : d.toLocaleDateString(locale, { month: 'long', year: 'numeric' }) })
      }
      top[top.length - 1].w += px
      if (zoom === 'day') bottom.push({ x: i * px, label: `${d.getDate()}`, weekend: d.getDay() === 0 || d.getDay() === 6 })
      else if (zoom === 'week' && d.getDay() === 1) bottom.push({ x: i * px, label: d.toLocaleDateString(locale, { day: 'numeric', month: 'short' }) })
      else if (zoom === 'month' && d.getDate() === 1) bottom.push({ x: i * px, label: d.toLocaleDateString(locale, { month: 'short' }) })
    }
    return { top, bottom }
  }, [origin, days, px, zoom, locale])

  // ---------- pointer handling ----------
  const dayAt = (clientX: number) => {
    const el = scroller.current!
    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft - LEFT
    return Math.max(0, Math.min(days - 1, Math.floor(x / px)))
  }
  const begin = (e: RPointerEvent, d: Drag) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    setDrag(d)
  }
  const onMove = (e: RPointerEvent) => {
    if (!drag) return
    if (drag.mode === 'create') setDrag({ ...drag, to: dayAt(e.clientX) })
    else if (drag.mode === 'link') setDrag({ ...drag, px: e.clientX, py: e.clientY })
    else {
      const delta = Math.round((e.clientX - drag.x) / px)
      if (delta !== drag.delta || (!drag.moved && Math.abs(e.clientX - drag.x) > 3)) setDrag({ ...drag, delta, moved: drag.moved || Math.abs(e.clientX - drag.x) > 3 })
    }
  }
  const onUp = (e: RPointerEvent) => {
    const d = drag
    setDrag(null)
    if (!d) return
    const card = allCards.find((c) => c.id === d.id)
    if (!card) return
    if (d.mode === 'link') {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-gantt-card]')
      const target = el?.getAttribute('data-gantt-card')
      if (target && target !== d.id) onLink?.(target, d.id)
      return
    }
    if (d.mode === 'create') {
      const [a, b] = [Math.min(d.from, d.to), Math.max(d.from, d.to)]
      onDates?.(card.id, { start_at: atTime(addDays(origin, a), 9), due_at: atTime(addDays(origin, b), 17) })
      return
    }
    if (!d.moved) return onOpen(card.id)
    if (!d.delta) return
    const g = geo(card)!
    if (d.mode === 'move') {
      onDates?.(card.id, {
        ...(card.start_at ? { start_at: shiftIso(card.start_at, d.delta) } : {}),
        ...(card.due_at ? { due_at: shiftIso(card.due_at, d.delta) } : {}),
      })
    } else if (d.mode === 'start') {
      const delta = Math.min(d.delta, g.x1 - 1 - g.x0)
      if (card.start_at) onDates?.(card.id, { start_at: shiftIso(card.start_at, delta) })
      else if (card.due_at) onDates?.(card.id, { start_at: atTime(addDays(origin, g.x0 + delta), 9) }) // milestone → bar
    } else {
      const delta = Math.max(d.delta, g.x0 + 1 - g.x1)
      if (card.due_at && g.kind !== 'milestone') onDates?.(card.id, { due_at: shiftIso(card.due_at, delta) })
      else if (g.kind === 'open') onDates?.(card.id, { due_at: atTime(addDays(origin, g.x1 - 1 + delta), 17) })
    }
  }

  // ---------- dependency arrows ----------
  const arrows: { d: string; bad: boolean; key: string }[] = []
  for (const c of cards) {
    const to = rowOf.get(c.id)
    if (to === undefined) continue
    const gs = liveGeo(c)
    if (!gs) continue
    for (const pid of c.depends_on) {
      const p = cards.find((x) => x.id === pid)
      const from = p && rowOf.get(pid)
      if (!p || from === undefined) continue
      const gp = liveGeo(p)
      if (!gp) continue
      const ex = gp.kind === 'milestone' ? (gp.x0 + 0.5) * px + 6 : gp.x1 * px
      const sx = gs.kind === 'milestone' ? (gs.x0 + 0.5) * px - 6 : gs.x0 * px
      const ey = from * ROW + ROW / 2
      const sy = to * ROW + ROW / 2
      const bad = (gs.kind === 'milestone' ? gs.x0 + 1 : gs.x0) < (gp.kind === 'milestone' ? gp.x0 + 1 : gp.x1)
      const dir = sy >= ey ? 1 : -1
      const d =
        sx - ex >= 16
          ? `M${ex},${ey} H${ex + 8} V${sy} H${sx - 1}`
          : `M${ex},${ey} H${ex + 8} V${ey + (dir * ROW) / 2} H${sx - 10} V${sy} H${sx - 1}`
      arrows.push({ d, bad, key: `${pid}>${c.id}` })
    }
  }
  const conflicts = arrows.filter((a) => a.bad).length

  const colorOf = (c: CardSummary) => c.color ?? '#6366f1'
  const statusOf = (c: CardSummary) => (c.status_id ? statuses.get(c.status_id) : undefined)
  const editable = !!onDates

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
        <div className="flex rounded-md border border-line p-0.5">
          {(['day', 'week', 'month'] as Zoom[]).map((z) => (
            <button
              key={z}
              onClick={() => setZoom(z)}
              className={clsx('rounded px-2 py-0.5 text-xs cursor-pointer', zoom === z ? 'bg-accent text-white' : 'text-muted hover:bg-black/5 dark:hover:bg-white/10')}
            >
              {t(`gantt.${z}`)}
            </button>
          ))}
        </div>
        <button onClick={scrollToToday} className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer">
          <Crosshair size={13} /> {t('gantt.today')}
        </button>
        {conflicts > 0 && <span className="rounded bg-red-500/15 px-2 py-0.5 text-xs text-red-600">{t('gantt.conflicts', { count: conflicts })}</span>}
        <span className="hidden text-xs text-muted lg:inline">{editable ? t('gantt.hint') : ''}</span>
        <div className="ml-auto">{toolbar}</div>
      </div>
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-auto border-t border-line select-none" onPointerMove={onMove} onPointerUp={onUp}>
        {rows.length === 0 && <p className="p-8 text-center text-sm text-muted">{t('gantt.empty')}</p>}
        <div style={{ width: LEFT + W, height: HEAD + H }} className="relative">
          {/* header */}
          <div className="sticky top-0 z-30 flex bg-surface" style={{ height: HEAD }}>
            <div className="sticky left-0 z-10 flex items-end border-b border-r border-line bg-surface px-3 pb-1.5 text-xs font-medium text-muted" style={{ width: LEFT, minWidth: LEFT }}>
              {t('gantt.card')}
            </div>
            <div className="relative border-b border-line" style={{ width: W }}>
              {header.top.map((h) => (
                <div key={h.x} className="absolute top-0 h-[22px] truncate border-l border-line px-1.5 pt-0.5 text-xs font-medium" style={{ left: h.x, width: h.w }}>
                  {h.label}
                </div>
              ))}
              {header.bottom.map((h) => (
                <div
                  key={h.x}
                  className={clsx('absolute top-[22px] h-6 border-l border-line pt-1 text-[10px] text-muted', zoom === 'day' ? 'text-center' : 'pl-1', h.weekend && 'bg-black/[0.03] dark:bg-white/[0.04]')}
                  style={{ left: h.x, width: zoom === 'day' ? px : undefined }}
                >
                  {h.label}
                </div>
              ))}
            </div>
          </div>
          {/* grid: weekends + today */}
          <div className="pointer-events-none absolute" style={{ left: LEFT, top: HEAD, width: W, height: H }}>
            {zoom !== 'month' &&
              Array.from({ length: days }, (_, i) => {
                const wd = addDays(origin, i).getDay()
                return wd === 0 || wd === 6 ? <div key={i} className="absolute top-0 h-full bg-black/[0.025] dark:bg-white/[0.03]" style={{ left: i * px, width: px }} /> : null
              })}
            <div className="absolute top-0 z-10 h-full w-px bg-red-500/70" style={{ left: todayX }} />
          </div>
          {/* rows */}
          {rows.map((r, i) => {
            if (r.type === 'list') {
              const open = !collapsed.includes(r.list.id)
              return (
                <div key={`l-${r.list.id}`} className="absolute flex w-full border-b border-line bg-black/[0.03] dark:bg-white/[0.04]" style={{ top: HEAD + i * ROW, height: ROW }}>
                  <button
                    onClick={() => setCollapsed(open ? [...collapsed, r.list.id] : collapsed.filter((x) => x !== r.list.id))}
                    className="sticky left-0 z-20 flex items-center gap-1.5 border-r border-line bg-[color-mix(in_srgb,var(--surface)_94%,var(--text))] px-2 text-left text-xs font-semibold cursor-pointer"
                    style={{ width: LEFT, minWidth: LEFT }}
                  >
                    <ChevronRight size={13} className={clsx('shrink-0 transition-transform', open && 'rotate-90')} />
                    {r.list.color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: r.list.color }} />}
                    <span className="truncate">{r.list.name}</span>
                    <span className="font-normal text-muted">({r.count})</span>
                  </button>
                </div>
              )
            }
            const c = r.card
            const g = liveGeo(c)
            const color = colorOf(c)
            const label = (
              <button
                onClick={() => onOpen(c.id)}
                className="sticky left-0 z-20 flex items-center gap-1.5 border-r border-line bg-surface px-3 text-left text-xs hover:bg-[color-mix(in_srgb,var(--surface)_92%,var(--text))] cursor-pointer"
                style={{ width: LEFT, minWidth: LEFT }}
                title={`#${c.number} ${c.title}`}
              >
                <span className="shrink-0 text-muted">#{c.number}</span>
                <span className="truncate">{c.title}</span>
              </button>
            )
            return (
              <div key={c.id} className="absolute flex w-full border-b border-line" style={{ top: HEAD + i * ROW, height: ROW }}>
                {itemMenu ? itemMenu(c, label) : label}
                <div
                  className={clsx('group/row relative', !g && editable && 'cursor-crosshair')}
                  style={{ width: W }}
                  onPointerDown={!g && editable ? (e) => begin(e, { mode: 'create', id: c.id, from: dayAt(e.clientX), to: dayAt(e.clientX) }) : undefined}
                >
                  {!g && editable && !drag && (
                    <span className="pointer-events-none absolute top-1/2 hidden -translate-y-1/2 whitespace-nowrap text-[10px] text-muted group-hover/row:block" style={{ left: Math.max(4, todayX + 8) }}>
                      {t('gantt.dragToSchedule')}
                    </span>
                  )}
                  {g && g.kind === 'milestone' ? (
                    <div
                      data-gantt-card={c.id}
                      title={`#${c.number} ${c.title}`}
                      className={clsx('group/bar absolute top-1/2 z-10 flex items-center', editable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer')}
                      style={{ left: (g.x0 + 0.5) * px - 8, transform: 'translateY(-50%)' }}
                      onPointerDown={editable ? (e) => begin(e, { mode: 'move', id: c.id, x: e.clientX, delta: 0, moved: false }) : undefined}
                      onClick={editable ? undefined : () => onOpen(c.id)}
                    >
                      <span className="block h-4 w-4 rotate-45 rounded-[3px] border-2 border-white shadow dark:border-zinc-900" style={{ background: color }} />
                      <span className="ml-1.5 whitespace-nowrap text-[11px]">{c.title}</span>
                      {onLink && <LinkDot onDown={(e) => begin(e, { mode: 'link', id: c.id, x: e.clientX, y: e.clientY, px: e.clientX, py: e.clientY })} />}
                    </div>
                  ) : g ? (
                    <div
                      data-gantt-card={c.id}
                      title={`#${c.number} ${c.title}`}
                      className={clsx(
                        'group/bar absolute top-[6px] z-10 flex items-center rounded-md text-[11px] font-medium text-white shadow-sm',
                        editable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
                        g.kind === 'open' && 'bg-clip-padding [mask-image:linear-gradient(90deg,#000_60%,transparent)]',
                      )}
                      style={{ left: g.x0 * px + 1, width: Math.max(8, (g.x1 - g.x0) * px - 2), height: ROW - 12, background: color }}
                      onPointerDown={editable ? (e) => begin(e, { mode: 'move', id: c.id, x: e.clientX, delta: 0, moved: false }) : undefined}
                      onClick={editable ? undefined : () => onOpen(c.id)}
                    >
                      {editable && (
                        <span
                          className="absolute inset-y-0 left-0 w-2 cursor-ew-resize rounded-l-md hover:bg-black/20"
                          onPointerDown={(e) => begin(e, { mode: 'start', id: c.id, x: e.clientX, delta: 0, moved: false })}
                        />
                      )}
                      {statusOf(c) && (g.x1 - g.x0) * px >= 40 && (
                        <span title={statusOf(c)!.name} className="ml-2 h-2 w-2 shrink-0 rounded-full ring-2 ring-white/70" style={{ background: statusOf(c)!.color }} />
                      )}
                      <span className={clsx('truncate px-2', (g.x1 - g.x0) * px < 70 && 'absolute left-full ml-1 text-[var(--text)]')}>{c.title}</span>
                      {editable && (
                        <span
                          className="absolute inset-y-0 right-0 w-2 cursor-ew-resize rounded-r-md hover:bg-black/20"
                          onPointerDown={(e) => begin(e, { mode: 'end', id: c.id, x: e.clientX, delta: 0, moved: false })}
                        />
                      )}
                      {onLink && <LinkDot onDown={(e) => begin(e, { mode: 'link', id: c.id, x: e.clientX, y: e.clientY, px: e.clientX, py: e.clientY })} />}
                    </div>
                  ) : null}
                </div>
              </div>
            )
          })}
          {/* dependency arrows */}
          <svg className="pointer-events-none absolute z-20 overflow-visible" style={{ left: LEFT, top: HEAD }} width={W} height={H}>
            <defs>
              <marker id="g-arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" className="fill-zinc-500" />
              </marker>
              <marker id="g-arr-bad" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" className="fill-red-500" />
              </marker>
            </defs>
            {arrows.map((a) => (
              <path key={a.key} d={a.d} fill="none" strokeWidth={1.5} className={a.bad ? 'stroke-red-500' : 'stroke-zinc-500'} markerEnd={`url(#${a.bad ? 'g-arr-bad' : 'g-arr'})`} />
            ))}
          </svg>
        </div>
        {drag?.mode === 'link' && (
          <svg className="pointer-events-none fixed inset-0 z-50" width="100%" height="100%">
            <line x1={drag.x} y1={drag.y} x2={drag.px} y2={drag.py} strokeWidth={2} strokeDasharray="4 3" className="stroke-accent" />
          </svg>
        )}
      </div>
    </div>
  )
}

/** Handle on a bar's end: drag it onto another card → that card waits for this one. */
function LinkDot({ onDown, left }: { onDown: (e: RPointerEvent) => void; left?: number }) {
  const { t } = useTranslation()
  return (
    <span
      title={t('gantt.linkHint')}
      onPointerDown={onDown}
      className="absolute inset-y-0 hidden w-5 cursor-crosshair items-center justify-center group-hover/bar:flex"
      style={left !== undefined ? { left } : { right: -20 }}
    >
      <span className="h-3 w-3 rounded-full border-2 border-white bg-accent shadow dark:border-zinc-900" />
    </span>
  )
}
