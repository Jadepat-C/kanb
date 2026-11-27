/** Time tracking: the card's Time section (estimate, timer, time entered by hand, entries) and the running-timer chip
 * in the header. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Play, Plus, Square, Timer, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { api } from '../lib/api'
import { useMe } from '../lib/auth'
import { fmtDate } from '../lib/prefs'
import { clock, fmtMinutes, parseDuration } from '../lib/time'
import { askText } from './dialogs'
import { toast, toastError } from './toast'
import { Button, Input } from './ui'

interface Entry {
  id: string
  user_id: string
  user_name: string | null
  started_at: string
  ended_at: string | null
  minutes: number
  note: string
}
interface CardTime {
  entries: Entry[]
  total_minutes: number
  estimate_minutes: number | null
  can_log: boolean
  can_manage: boolean
}
export interface RunningTimer {
  id: string
  card_id: string
  card_number: number
  card_title: string
  board_id: string
  board_name: string
  started_at: string
}

/** My running timer (one at most, on any board). */
export function useMyTimer() {
  return useQuery({ queryKey: ['my-timer'], queryFn: () => api.get<{ running: RunningTimer | null }>('/me/timer'), refetchOnWindowFocus: true })
}

/** Seconds since `since`, ticking every second (null = not running). */
function useElapsed(since: string | null | undefined) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!since) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [since])
  return since ? Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000)) : 0
}

/** Stopping a timer that ran for more than 12 hours asks for the real time first (forgotten overnight, say). */
function useStopTimer() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (r: RunningTimer) => {
      const minutes = Math.round((Date.now() - new Date(r.started_at).getTime()) / 60000)
      let body: { minutes?: number } = {}
      if (minutes > 12 * 60) {
        const typed = await askText({ title: t('time.longTitle'), label: t('time.longLabel', { time: fmtMinutes(minutes) }), defaultValue: fmtMinutes(minutes), confirmLabel: t('time.stop') })
        if (typed === null) return null
        const m = parseDuration(typed)
        if (!m) throw new Error(t('time.badDuration'))
        body = { minutes: m }
      }
      return api.post<{ card_id: string; minutes: number }>('/me/timer/stop', body)
    },
    onSuccess: (r) => {
      if (!r) return
      qc.invalidateQueries({ queryKey: ['my-timer'] })
      qc.invalidateQueries({ queryKey: ['time', r.card_id] })
      qc.invalidateQueries({ queryKey: ['board'] })
      toast(t('time.logged', { time: fmtMinutes(r.minutes) }), 'success')
    },
    onError: toastError,
  })
}

/** The header chip while my timer runs: elapsed time, the card (a link), and Stop. */
export function TimerChip() {
  const { t } = useTranslation()
  const r = useMyTimer().data?.running
  const secs = useElapsed(r?.started_at)
  const stop = useStopTimer()
  if (!r) return null
  return (
    <div className="flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 py-0.5 pl-2.5 pr-0.5 text-xs">
      <Timer size={13} className="shrink-0 text-accent" />
      <Link to={`/b/${r.board_id}?card=${r.card_id}`} className="flex min-w-0 items-center gap-1.5 hover:underline" title={`${r.board_name} · #${r.card_number} ${r.card_title}`}>
        <span className="font-mono tabular-nums">{clock(secs)}</span>
        <span className="hidden max-w-40 truncate text-muted lg:inline">#{r.card_number} {r.card_title}</span>
      </Link>
      <button
        className="rounded-full p-1 text-muted hover:bg-black/5 hover:text-[var(--text)] dark:hover:bg-white/10 cursor-pointer"
        title={t('time.stop')}
        aria-label={t('time.stop')}
        disabled={stop.isPending}
        onClick={() => stop.mutate(r)}
      >
        <Square size={12} fill="currentColor" />
      </button>
    </div>
  )
}

/** "1h 30m of 4h" with a bar, for the card's sidebar. */
function Progress({ logged, estimate }: { logged: number; estimate: number | null }) {
  const { t } = useTranslation()
  const pct = estimate ? Math.min(100, (logged / estimate) * 100) : 0
  const over = !!estimate && logged > estimate
  return (
    <div className="space-y-1">
      <div className="text-sm">
        <span className="font-medium">{fmtMinutes(logged)}</span>
        {estimate ? <span className="text-muted"> {t('time.ofEstimate', { time: fmtMinutes(estimate) })}</span> : <span className="text-muted"> {t('time.loggedWord')}</span>}
      </div>
      {!!estimate && (
        <div className="flex h-1.5 overflow-hidden rounded-full bg-black/5 dark:bg-white/10" role="meter" aria-valuenow={logged} aria-valuemax={estimate} aria-label={t('time.title')}>
          <div className={clsx('rounded-full', over ? 'bg-red-500' : 'bg-accent')} style={{ width: `${pct}%` }} />
        </div>
      )}
      {over && <div className="text-xs text-red-600 dark:text-red-400">{t('time.over', { time: fmtMinutes(logged - estimate!) })}</div>}
    </div>
  )
}

export function TimeSection({ cardId, canEditEstimate, patch }: { cardId: string; canEditEstimate: boolean; patch: (p: Record<string, unknown>) => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: me } = useMe()
  const q = useQuery({ queryKey: ['time', cardId], queryFn: () => api.get<CardTime>(`/cards/${cardId}/time`) })
  const running = useMyTimer().data?.running
  const here = running?.card_id === cardId ? running : null
  const secs = useElapsed(here?.started_at)
  const stop = useStopTimer()
  const [estimate, setEstimate] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['time', cardId] })
    qc.invalidateQueries({ queryKey: ['my-timer'] })
    qc.invalidateQueries({ queryKey: ['board'] })
  }
  const start = useMutation({
    mutationFn: () => api.post<{ stopped: { minutes: number } | null }>(`/cards/${cardId}/time/start`),
    onSuccess: (r) => {
      if (r.stopped) toast(t('time.switched', { time: fmtMinutes(r.stopped.minutes) }))
      refresh()
    },
    onError: (e) => (refresh(), toastError(e)),
  })
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/time/${id}`), onSuccess: refresh, onError: toastError })
  const d = q.data
  if (!d) return null
  const est = d.estimate_minutes
  const entries = showAll ? d.entries : d.entries.slice(0, 3)
  const saveEstimate = () => {
    if (estimate === null) return
    const m = estimate.trim() ? parseDuration(estimate, 1_000_000) : null
    setEstimate(null)
    if (estimate.trim() && !m) return toast(t('time.badDuration'), 'error')
    if (m !== est) patch({ estimate_minutes: m })
  }
  return (
    <div className="space-y-2">
      <div className="mb-1 text-xs font-medium text-muted">{t('time.title')}</div>
      <Progress logged={d.total_minutes} estimate={est} />
      {d.can_log && (
        <div className="flex flex-wrap gap-1.5">
          {here ? (
            <Button size="sm" variant="primary" disabled={stop.isPending} onClick={() => stop.mutate(here)}>
              <Square size={12} fill="currentColor" /> <span className="font-mono tabular-nums">{clock(secs)}</span> {t('time.stop')}
            </Button>
          ) : (
            <Button size="sm" disabled={start.isPending} onClick={() => start.mutate()} title={running ? t('time.switchHint', { card: `#${running.card_number}` }) : undefined}>
              <Play size={12} /> {t('time.start')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setAdding(!adding)}>
            <Plus size={13} /> {t('time.log')}
          </Button>
        </div>
      )}
      {adding && <LogForm cardId={cardId} onDone={() => (setAdding(false), refresh())} />}
      <label className="flex items-center gap-2 text-xs text-muted">
        <span className="shrink-0">{t('time.estimate')}</span>
        <Input
          className="h-7 text-xs"
          value={estimate ?? (est ? fmtMinutes(est) : '')}
          placeholder={canEditEstimate ? t('time.estimatePlaceholder') : '—'}
          disabled={!canEditEstimate}
          onChange={(e) => setEstimate(e.target.value)}
          onBlur={saveEstimate}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </label>
      {d.entries.length > 0 && (
        <ul className="space-y-1 text-xs">
          {entries.map((e) => (
            <li key={e.id} className="group flex items-start gap-1.5">
              <span className="w-16 shrink-0 font-medium tabular-nums">{e.ended_at ? fmtMinutes(e.minutes) : t('time.running')}</span>
              <span className="min-w-0 flex-1 text-muted">
                {(e.user_name ?? '').split(' · ')[0]} · {fmtDate(e.started_at)}
                {e.note && <span className="block truncate text-[var(--text)]" title={e.note}>{e.note}</span>}
              </span>
              {e.ended_at && (d.can_manage || (e.user_id === me?.id && d.can_log)) && (
                <button
                  className="rounded p-0.5 text-muted opacity-0 hover:text-red-600 group-hover:opacity-100 focus:opacity-100 cursor-pointer [@media(hover:none)]:opacity-100"
                  title={t('common.delete')}
                  aria-label={t('common.delete')}
                  onClick={() => remove.mutate(e.id)}
                >
                  <Trash2 size={12} />
                </button>
              )}
            </li>
          ))}
          {d.entries.length > 3 && (
            <li>
              <button className="text-accent hover:underline cursor-pointer" onClick={() => setShowAll(!showAll)}>
                {showAll ? t('time.fewer') : t('time.allEntries', { count: d.entries.length })}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

/** Time entered by hand: how long ("1h 30m", "1.5", "90m", "1:30"), which day, and a note. */
function LogForm({ cardId, onDone }: { cardId: string; onDone: () => void }) {
  const { t } = useTranslation()
  const today = new Date()
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const [dur, setDur] = useState('')
  const [day, setDay] = useState(iso(today))
  const [note, setNote] = useState('')
  const minutes = parseDuration(dur)
  const save = useMutation({
    mutationFn: () => {
      // that day at 09:00 local time, or "just now" for today
      const [y, m, dd] = day.split('-').map(Number)
      const started = day === iso(today) ? undefined : new Date(y, m - 1, dd, 9, 0).toISOString()
      return api.post(`/cards/${cardId}/time`, { minutes, started_at: started, note })
    },
    onSuccess: () => (toast(t('time.logged', { time: fmtMinutes(minutes ?? 0) }), 'success'), onDone()),
    onError: toastError,
  })
  return (
    <form
      className="space-y-1.5 rounded-md border border-line p-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (minutes) save.mutate()
      }}
    >
      <div className="flex gap-1.5">
        <Input className="h-8 text-sm" value={dur} onChange={(e) => setDur(e.target.value)} placeholder={t('time.durationPlaceholder')} autoFocus aria-label={t('time.duration')} />
        <Input className="h-8 w-36 text-sm" type="date" value={day} max={iso(today)} onChange={(e) => setDay(e.target.value)} aria-label={t('time.day')} />
      </div>
      <Input className="h-8 text-sm" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('time.notePlaceholder')} maxLength={500} />
      {dur && !minutes && <p className="text-xs text-red-600">{t('time.badDuration')}</p>}
      <Button size="sm" variant="primary" disabled={!minutes || save.isPending}>
        {t('time.save')}
      </Button>
    </form>
  )
}
