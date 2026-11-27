/** A board's Analytics view: KPIs for people with "View analytics" (see backend/src/analytics.rs for definitions). */
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { AlertTriangle, Clock, Hourglass, Link2, Timer } from 'lucide-react'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api'
import { fmtDate } from '../lib/prefs'
import { avatarUrl } from '../lib/user'
import { Avatar, Spinner } from './ui'
import { fmtMinutes } from '../lib/time'

interface Data {
  days: number
  tz: string
  overview: {
    open: number
    created: number
    finished: number
    overdue: number
    due_week: number
    no_due: number
    unassigned: number
    blocked: number
    stale: number
    finished_with_due: number
    on_time: number
    archived_in_period: number
  }
  weeks: { week: string; created: number; finished: number }[]
  created_before: number
  finished_before: number
  times: {
    lead_n: number
    lead_median: number | null
    lead_p85: number | null
    cycle_n: number
    cycle_median: number | null
    cycle_p85: number | null
  }
  columns: {
    id: string
    name: string
    color: string | null
    wip_limit: number | null
    cards: number
    open: number
    avg_age_days: number | null
  }[]
  stale: CardRef[]
  blocked: CardRef[]
  people: { user_id: string; name: string; color: string; avatar_id: string | null; open: number; overdue: number; finished: number }[]
  labels: { id: string; name: string; color: string; open: number; finished: number }[]
  priority: { key: string; open: number }[]
  statuses: { key: string; name: string; color: string; open: number }[]
  flow: { day: string; list_id: string; cards: number }[]
  time?: {
    total_minutes: number
    people: { user_id: string; name: string; color: string; minutes: number }[]
    cards: { id: string; number: number; title: string; minutes: number; estimate_minutes: number | null }[]
    estimated: { cards: number; estimate_minutes: number; logged_minutes: number }
  }
}
interface CardRef {
  id: string
  number: number
  title: string
  list: string
  age_days: number
  idle_days: number
  due_at: string | null
}

const PERIODS = [7, 30, 90, 180, 365]

const days = (d: number | null) => (d == null ? '—' : d < 1 ? `${Math.round(d * 24)}h` : `${d < 10 ? d.toFixed(1) : Math.round(d)}d`)

export function Analytics({ boardId, onOpenCard }: { boardId: string; onOpenCard: (id: string) => void }) {
  const { t } = useTranslation()
  const [period, setPeriod] = useState(90)
  const q = useQuery({
    queryKey: ['analytics', boardId, period],
    queryFn: () => api.get<Data>(`/boards/${boardId}/analytics?days=${period}`),
    placeholderData: (prev) => prev,
  })
  const d = q.data
  if (!d)
    return (
      <div className="flex justify-center p-10">
        {q.isError ? <p className="text-sm text-muted">{t('errors.forbidden')}</p> : <Spinner />}
      </div>
    )
  const o = d.overview
  const onTime = o.finished_with_due ? Math.round((o.on_time / o.finished_with_due) * 100) : null
  return (
    <div className={clsx('viz min-h-0 flex-1 overflow-y-auto pb-6 pt-3', q.isFetching && 'opacity-70 transition-opacity')}>
      <div className="mx-auto max-w-6xl space-y-5 px-3 sm:px-4">
        {/* one filter row, scoping everything below */}
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">{t('analytics.period')}</span>
            <select
              value={period}
              onChange={(e) => setPeriod(Number(e.target.value))}
              className="h-8 rounded-md border border-line bg-surface px-2 text-sm"
            >
              {PERIODS.map((p) => (
                <option key={p} value={p}>
                  {t('analytics.lastDays', { count: p })}
                </option>
              ))}
            </select>
          </label>
          <span className="text-xs text-muted">{t('analytics.definitions')}</span>
        </div>

        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label={t('analytics.open')} value={o.open} />
          <Tile label={t('analytics.finished')} value={o.finished} sub={t('analytics.createdN', { count: o.created })} />
          <Tile label={t('analytics.overdue')} value={o.overdue} status={o.overdue > 0 ? 'critical' : undefined} />
          <Tile
            label={t('analytics.onTime')}
            value={onTime == null ? '—' : `${onTime}%`}
            sub={onTime == null ? t('analytics.noDueFinished') : t('analytics.ofN', { count: o.finished_with_due })}
          />
          <Tile
            label={t('analytics.lead')}
            value={days(d.times.lead_median)}
            sub={t('analytics.p85', { v: days(d.times.lead_p85) })}
            icon={<Timer size={13} />}
          />
          <Tile
            label={t('analytics.cycle')}
            value={days(d.times.cycle_median)}
            sub={d.times.cycle_n ? t('analytics.p85', { v: days(d.times.cycle_p85) }) : t('analytics.noCycle')}
            icon={<Hourglass size={13} />}
          />
          <Tile
            label={t('analytics.blocked')}
            value={o.blocked}
            status={o.blocked > 0 ? 'warning' : undefined}
            icon={<Link2 size={13} />}
          />
          <Tile label={t('analytics.stale')} value={o.stale} status={o.stale > 0 ? 'warning' : undefined} icon={<Clock size={13} />} />
        </section>
        <p className="-mt-2 text-xs text-muted">
          {t('analytics.dueSummary', { week: o.due_week, noDue: o.no_due, unassigned: o.unassigned })}
        </p>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card title={t('analytics.throughput')} hint={t('analytics.throughputHint')}>
            <Throughput weeks={d.weeks} />
          </Card>
          <Card title={t('analytics.flow')} hint={t('analytics.flowHint')}>
            <Flow flow={d.flow} columns={d.columns} />
          </Card>
          <Card title={t('analytics.columns')} hint={t('analytics.columnsHint')}>
            <Bars
              rows={d.columns.map((c) => ({
                key: c.id,
                label: c.name,
                value: c.open,
                note: c.avg_age_days != null ? t('analytics.avgAge', { v: days(c.avg_age_days) }) : undefined,
                limit: c.wip_limit,
              }))}
            />
          </Card>
          <Card title={t('analytics.people')} hint={t('analytics.peopleHint')}>
            <People rows={d.people} unassigned={o.unassigned} />
          </Card>
          {d.time && (d.time.total_minutes > 0 || d.time.estimated.cards > 0) && (
            <Card title={t('analytics.timeTitle')} hint={t('analytics.timeHint', { total: fmtMinutes(d.time.total_minutes) })}>
              <Bars fmt={fmtMinutes} rows={d.time.people.map((p) => ({ key: p.user_id, label: p.name, value: p.minutes }))} />
              {d.time.estimated.cards > 0 && (
                <p className="mt-3 text-sm">
                  {t('analytics.estimateVsLogged', {
                    count: d.time.estimated.cards,
                    est: fmtMinutes(d.time.estimated.estimate_minutes),
                    logged: fmtMinutes(d.time.estimated.logged_minutes),
                    pct: Math.round((d.time.estimated.logged_minutes / Math.max(1, d.time.estimated.estimate_minutes)) * 100),
                  })}
                </p>
              )}
              {d.time.cards.length > 0 && (
                <ul className="mt-3 divide-y divide-[var(--border)] border-t border-line">
                  {d.time.cards.map((c) => (
                    <li key={c.id}>
                      <button onClick={() => onOpenCard(c.id)} className="flex w-full items-center gap-2 py-1.5 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer">
                        <span className="text-xs text-muted">#{c.number}</span>
                        <span className="min-w-0 flex-1 truncate">{c.title}</span>
                        <span className="whitespace-nowrap text-xs tabular-nums">
                          {fmtMinutes(c.minutes)}
                          {c.estimate_minutes ? <span className="text-muted"> / {fmtMinutes(c.estimate_minutes)}</span> : null}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
          <Card title={t('analytics.labels')}>
            {d.labels.length === 0 ? (
              <Empty />
            ) : (
              <Bars
                rows={d.labels.map((l) => ({
                  key: l.id,
                  label: l.name,
                  dot: l.color,
                  value: l.open,
                  note: t('analytics.finishedN', { count: l.finished }),
                }))}
              />
            )}
          </Card>
          <Card title={t('analytics.statusPriority')}>
            <Bars rows={d.statuses.map((s) => ({ key: s.key, label: s.name, dot: s.color, value: s.open }))} />
            <div className="mt-4 border-t border-line pt-3">
              <Bars
                rows={[3, 2, 1, 0].map((p) => ({
                  key: String(p),
                  label: p ? '★'.repeat(p) : t('analytics.noPriority'),
                  value: d.priority.find((x) => x.key === String(p))?.open ?? 0,
                }))}
              />
            </div>
          </Card>
          <Card title={t('analytics.staleTitle')} hint={t('analytics.staleHint')}>
            <CardList cards={d.stale} onOpen={onOpenCard} metric={(c) => t('analytics.idle', { v: days(c.idle_days) })} />
          </Card>
          <Card title={t('analytics.blockedTitle')} hint={t('analytics.blockedHint')}>
            <CardList cards={d.blocked} onOpen={onOpenCard} metric={(c) => t('analytics.age', { v: days(c.age_days) })} />
          </Card>
        </div>
      </div>
    </div>
  )
}

function Empty() {
  const { t } = useTranslation()
  return <p className="py-6 text-center text-sm text-muted">{t('analytics.nothing')}</p>
}

function Card({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-line bg-surface p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {hint && <p className="mb-3 mt-0.5 text-xs text-muted">{hint}</p>}
      {!hint && <div className="mb-3" />}
      {children}
    </section>
  )
}

function Tile({
  label,
  value,
  sub,
  status,
  icon,
}: {
  label: string
  value: ReactNode
  sub?: string
  status?: 'warning' | 'critical'
  icon?: ReactNode
}) {
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
      <div className="flex items-center gap-1 text-xs text-muted">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-2xl font-semibold">
        {value}
        {/* a status color never works alone: icon + the label above */}
        {status && (
          <AlertTriangle size={16} style={{ color: status === 'critical' ? 'var(--status-critical)' : 'var(--status-warning)' }} />
        )}
      </div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </div>
  )
}

/** Hover readout shared by the charts: positioned over the chart, text only (labels via textContent through React). */
function Tip({ x, children }: { x: number; children: ReactNode }) {
  return (
    <div
      className="pointer-events-none absolute top-0 z-10 min-w-36 -translate-x-1/2 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs shadow-lg"
      style={{ left: `clamp(70px, ${x}%, calc(100% - 70px))` }}
    >
      {children}
    </div>
  )
}

function Key({ color, line }: { color: string; line?: boolean }) {
  return (
    <span className={clsx('inline-block shrink-0', line ? 'h-0.5 w-3 rounded' : 'h-2.5 w-2.5 rounded-sm')} style={{ background: color }} />
  )
}

function NumbersTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  const { t } = useTranslation()
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-muted">{t('analytics.showNumbers')}</summary>
      <div className="mt-1 max-h-56 overflow-auto">
        <table className="w-full tabular-nums">
          <thead className="text-left text-muted">
            <tr>
              {head.map((h) => (
                <th key={h} className="px-1 py-0.5 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-line">
                {r.map((c, j) => (
                  <td key={j} className="px-1 py-0.5">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}

const W = 600
const H = 200
const PAD = { l: 30, r: 8, t: 10, b: 22 }

function niceMax(v: number) {
  if (v <= 4) return Math.max(v, 1)
  const p = 10 ** Math.floor(Math.log10(v))
  const m = [1, 2, 2.5, 5, 10].find((m) => m * p >= v) ?? 10
  return m * p
}

function Axis({ max }: { max: number }) {
  const ticks = [0, max / 2, max]
  return (
    <>
      {ticks.map((v) => {
        const y = PAD.t + (H - PAD.t - PAD.b) * (1 - v / max)
        return (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y} y2={y} stroke={v === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'} strokeWidth={1} />
            <text x={PAD.l - 6} y={y + 3} textAnchor="end" fontSize={10} fill="var(--muted)" className="tabular-nums">
              {Number.isInteger(v) ? v : v.toFixed(1)}
            </text>
          </g>
        )
      })}
    </>
  )
}

/** Created vs finished per week: grouped columns, the week is the hit target. */
function Throughput({ weeks }: { weeks: Data['weeks'] }) {
  const { t } = useTranslation()
  const [hover, setHover] = useState<number | null>(null)
  const max = niceMax(Math.max(1, ...weeks.flatMap((w) => [w.created, w.finished])))
  const band = (W - PAD.l - PAD.r) / weeks.length
  const bar = Math.max(1, Math.min(12, (band - 4) / 2))
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / max)
  const every = Math.ceil(weeks.length / 6)
  const series = [
    { key: 'finished' as const, name: t('analytics.sFinished'), color: 'var(--series-1)' },
    { key: 'created' as const, name: t('analytics.sCreated'), color: 'var(--series-2)' },
  ]
  return (
    <div>
      <Legend items={series.map((s) => ({ name: s.name, color: s.color }))} />
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={t('analytics.throughput')}>
          <Axis max={max} />
          {weeks.map((w, i) => {
            const cx = PAD.l + band * i + band / 2
            return (
              <g key={w.week}>
                {series.map((s, j) => {
                  const v = w[s.key]
                  if (!v) return null
                  const x = cx - bar - 1 + j * (bar + 2)
                  const top = y(v)
                  const h = y(0) - top
                  const r = Math.min(4, bar / 2, h)
                  return (
                    <path
                      key={s.key}
                      d={`M${x},${y(0)} V${top + r} Q${x},${top} ${x + r},${top} H${x + bar - r} Q${x + bar},${top} ${x + bar},${top + r} V${y(0)} Z`}
                      fill={s.color}
                      opacity={hover == null || hover === i ? 1 : 0.55}
                    />
                  )
                })}
                {i % every === 0 && (
                  <text x={cx} y={H - 6} textAnchor="middle" fontSize={10} fill="var(--muted)">
                    {fmtDate(w.week).slice(0, 5)}
                  </text>
                )}
                <rect
                  x={PAD.l + band * i}
                  y={PAD.t}
                  width={band}
                  height={H - PAD.t - PAD.b}
                  fill="transparent"
                  tabIndex={0}
                  aria-label={`${fmtDate(w.week)}: ${series.map((s) => `${s.name} ${w[s.key]}`).join(', ')}`}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(null)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                />
              </g>
            )
          })}
        </svg>
        {hover != null && (
          <Tip x={((PAD.l + band * hover + band / 2) / W) * 100}>
            <div className="mb-1 text-muted">{t('analytics.weekOf', { date: fmtDate(weeks[hover].week) })}</div>
            {series.map((s) => (
              <div key={s.key} className="flex items-center gap-2">
                <Key color={s.color} line />
                <span className="font-semibold tabular-nums">{weeks[hover][s.key]}</span>
                <span className="text-muted">{s.name}</span>
              </div>
            ))}
          </Tip>
        )}
      </div>
      <NumbersTable
        head={[t('analytics.week'), ...series.map((s) => s.name)]}
        rows={weeks.map((w) => [fmtDate(w.week), w.finished, w.created])}
      />
    </div>
  )
}

function Legend({ items }: { items: { name: string; color: string }[] }) {
  return (
    <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
      {items.map((i) => (
        <span key={i.name} className="flex items-center gap-1.5">
          <Key color={i.color} /> {i.name}
        </span>
      ))}
    </div>
  )
}

const SERIES = 8

/** Cards per column, day by day (stacked areas, from the daily snapshots). Past 7 columns the rest fold into "Other". */
function Flow({ flow, columns }: { flow: Data['flow']; columns: Data['columns'] }) {
  const { t } = useTranslation()
  const [hover, setHover] = useState<number | null>(null)
  const ref = useRef<SVGSVGElement>(null)
  const { daysList, series, stacks, max } = useMemo(() => {
    const daysList = [...new Set(flow.map((f) => f.day))].sort()
    const ids = columns.map((c) => c.id)
    const shown = ids.slice(0, ids.length > SERIES ? SERIES - 1 : SERIES)
    const series = shown.map((id, i) => ({ id, name: columns.find((c) => c.id === id)!.name, color: `var(--series-${i + 1})` }))
    if (ids.length > shown.length) series.push({ id: 'other', name: t('analytics.other'), color: `var(--series-${SERIES})` })
    const at = new Map(flow.map((f) => [`${f.day}|${f.list_id}`, f.cards]))
    const stacks = daysList.map((day) => {
      const vals = series.map((s) =>
        s.id === 'other'
          ? ids.slice(shown.length).reduce((n, id) => n + (at.get(`${day}|${id}`) ?? 0), 0)
          : (at.get(`${day}|${s.id}`) ?? 0),
      )
      return vals
    })
    const max = niceMax(Math.max(1, ...stacks.map((v) => v.reduce((a, b) => a + b, 0))))
    return { daysList, series, stacks, max }
  }, [flow, columns, t])
  if (daysList.length < 2)
    return (
      <p className="py-6 text-center text-sm text-muted">
        {t('analytics.flowStarts', { date: daysList[0] ? fmtDate(daysList[0]) : fmtDate(new Date().toISOString()) })}
      </p>
    )
  const x = (i: number) => PAD.l + ((W - PAD.l - PAD.r) * i) / (daysList.length - 1)
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / max)
  // bottom-up: series 0 at the bottom
  const tops = stacks.map((vals) => vals.reduce<number[]>((acc, v, i) => [...acc, (acc[i - 1] ?? 0) + v], []))
  const every = Math.ceil(daysList.length / 6)
  const move = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * W
    const i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (daysList.length - 1))
    setHover(Math.max(0, Math.min(daysList.length - 1, i)))
  }
  return (
    <div>
      <Legend items={series} />
      <div className="relative">
        <svg
          ref={ref}
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto w-full"
          role="img"
          aria-label={t('analytics.flow')}
          onPointerMove={move}
          onPointerLeave={() => setHover(null)}
        >
          <Axis max={max} />
          {series.map((s, si) => {
            const upper = daysList.map((_, i) => `${x(i)},${y(tops[i][si])}`)
            const lower = daysList.map((_, i) => `${x(i)},${y(si ? tops[i][si - 1] : 0)}`).reverse()
            return (
              <g key={s.id}>
                <polygon points={[...upper, ...lower].join(' ')} fill={s.color} opacity={0.85} />
                {/* the 2px surface gap between layers */}
                <polyline points={upper.join(' ')} fill="none" stroke="var(--surface)" strokeWidth={2} strokeLinejoin="round" />
              </g>
            )
          })}
          {daysList.map((day, i) =>
            i % every === 0 || i === daysList.length - 1 ? (
              <text
                key={day}
                x={x(i)}
                y={H - 6}
                textAnchor={i === 0 ? 'start' : i === daysList.length - 1 ? 'end' : 'middle'}
                fontSize={10}
                fill="var(--muted)"
              >
                {fmtDate(day).slice(0, 5)}
              </text>
            ) : null,
          )}
          {hover != null && <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke="var(--muted)" strokeWidth={1} />}
        </svg>
        {hover != null && (
          <Tip x={(x(hover) / W) * 100}>
            <div className="mb-1 text-muted">{fmtDate(daysList[hover])}</div>
            {[...series].reverse().map((s) => (
              <div key={s.id} className="flex items-center gap-2">
                <Key color={s.color} />
                <span className="font-semibold tabular-nums">{stacks[hover][series.indexOf(s)]}</span>
                <span className="truncate text-muted">{s.name}</span>
              </div>
            ))}
          </Tip>
        )}
      </div>
      <NumbersTable head={[t('analytics.day'), ...series.map((s) => s.name)]} rows={daysList.map((d, i) => [fmtDate(d), ...stacks[i]])} />
    </div>
  )
}

/** Horizontal bars, one hue; an item's own colour (label, status) is a dot beside its name, never the bar. */
function Bars({ rows, fmt = String }: { rows: { key: string; label: string; value: number; dot?: string; note?: string; limit?: number | null }[]; fmt?: (v: number) => string }) {
  const { t } = useTranslation()
  const max = Math.max(1, ...rows.map((r) => Math.max(r.value, r.limit ?? 0)))
  if (rows.length === 0) return <Empty />
  return (
    <ul className="space-y-2">
      {rows.map((r) => {
        const over = r.limit != null && r.limit > 0 && r.value > r.limit
        return (
          <li key={r.key} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-sm" title={`${r.label}: ${fmt(r.value)}`}>
            <span className="flex min-w-0 items-center gap-1.5">
              {r.dot && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: r.dot }} />}
              <span className="truncate">{r.label}</span>
            </span>
            <span className="relative h-3">
              {r.value > 0 && (
                <span
                  className="absolute inset-y-0 left-0 rounded-r"
                  style={{ width: `${(r.value / max) * 100}%`, background: over ? 'var(--status-critical)' : 'var(--series-1)' }}
                />
              )}
              {r.limit != null && r.limit > 0 && (
                <span
                  className="absolute -inset-y-0.5 w-0.5 bg-[var(--text)]"
                  style={{ left: `${(r.limit / max) * 100}%` }}
                  title={t('analytics.limit', { n: r.limit })}
                />
              )}
            </span>
            <span className="flex items-center gap-1 whitespace-nowrap text-xs tabular-nums">
              <span className="font-semibold">{fmt(r.value)}</span>
              {r.limit != null && r.limit > 0 && <span className="text-muted">/ {r.limit}</span>}
              {over && (
                <span className="flex items-center gap-0.5 text-[var(--text)]">
                  <AlertTriangle size={12} style={{ color: 'var(--status-critical)' }} /> {t('analytics.overLimit')}
                </span>
              )}
              {r.note && <span className="text-muted">· {r.note}</span>}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function People({ rows, unassigned }: { rows: Data['people']; unassigned: number }) {
  const { t } = useTranslation()
  if (rows.length === 0) return <Empty />
  return (
    <div className="max-h-80 overflow-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted">
          <tr>
            <th className="py-1 font-medium">{t('analytics.person')}</th>
            <th className="py-1 text-right font-medium">{t('analytics.open')}</th>
            <th className="py-1 text-right font-medium">{t('analytics.overdue')}</th>
            <th className="py-1 text-right font-medium">{t('analytics.finished')}</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((p) => (
            <tr key={p.user_id} className="border-t border-line">
              <td className="py-1.5">
                <span className="flex min-w-0 items-center gap-2">
                  <Avatar name={p.name} color={p.color} src={avatarUrl(p.avatar_id)} size={22} />
                  <span className="truncate">{p.name}</span>
                </span>
              </td>
              <td className="py-1.5 text-right">{p.open}</td>
              <td className="py-1.5 text-right">
                {p.overdue > 0 ? (
                  <span className="inline-flex items-center gap-1">
                    <AlertTriangle size={12} style={{ color: 'var(--status-critical)' }} /> {p.overdue}
                  </span>
                ) : (
                  0
                )}
              </td>
              <td className="py-1.5 text-right">{p.finished}</td>
            </tr>
          ))}
          <tr className="border-t border-line text-muted">
            <td className="py-1.5">{t('analytics.unassigned')}</td>
            <td className="py-1.5 text-right">{unassigned}</td>
            <td />
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function CardList({ cards, onOpen, metric }: { cards: CardRef[]; onOpen: (id: string) => void; metric: (c: CardRef) => string }) {
  if (cards.length === 0) return <Empty />
  return (
    <ul className="divide-y divide-[var(--border)]">
      {cards.map((c) => (
        <li key={c.id}>
          <button
            onClick={() => onOpen(c.id)}
            className="flex w-full items-center gap-2 py-1.5 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
          >
            <span className="text-xs text-muted">#{c.number}</span>
            <span className="min-w-0 flex-1 truncate">{c.title}</span>
            <span className="hidden max-w-28 truncate text-xs text-muted sm:inline">{c.list}</span>
            <span className="whitespace-nowrap text-xs tabular-nums">{metric(c)}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}
