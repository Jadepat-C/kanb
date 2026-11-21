import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarPlus, Copy, RefreshCw, X } from 'lucide-react'
import { Link } from 'react-router'
import type { BoardListItem } from '../lib/types'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api'
import { ask } from './dialogs'
import { toastError, toastSuccess } from './toast'
import { Button, Input } from './ui'

export interface FeedSettings {
  enabled: boolean
  all: boolean
  only_mine: boolean
  board_ids: string[]
  cards: { id: string; board_id: string; number: number; title: string; board_name: string }[]
}

export function useCalendarFeed() {
  return useQuery({ queryKey: ['calendar-feed'], queryFn: () => api.get<FeedSettings>('/me/calendar-feed') })
}

/** "Add to my calendar" on one card. */
export function useCalendarPick() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const feed = useCalendarFeed()
  const picked = new Set((feed.data?.cards ?? []).map((c) => c.id))
  const toggle = (cardId: string) => {
    const on = !picked.has(cardId)
    return api.put(`/cards/${cardId}/calendar`, { on }).then(() => {
      qc.invalidateQueries({ queryKey: ['calendar-feed'] })
      toastSuccess(on ? t('feed.picked') : t('feed.unpicked'))
    }, toastError)
  }
  return { picked, toggle }
}

/** Profile: private iCalendar link for Google / Outlook / Apple Calendar, and what it contains. */
export function CalendarFeed() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const status = useCalendarFeed()
  const boards = useQuery({ queryKey: ['boards'], queryFn: () => api.get<BoardListItem[]>('/boards') })
  const [url, setUrl] = useState<string | null>(null)
  const full = url
  const d = status.data
  const save = (body: Partial<Pick<FeedSettings, 'all' | 'only_mine' | 'board_ids'>>) =>
    api.patch<FeedSettings>('/me/calendar-feed', body).then((r) => qc.setQueryData(['calendar-feed'], r), toastError)
  const unpick = (id: string) => api.put(`/cards/${id}/calendar`, { on: false }).then(() => qc.invalidateQueries({ queryKey: ['calendar-feed'] }), toastError)
  const create = async () => {
    if (status.data?.enabled && !(await ask({ title: t('feed.reset'), message: t('feed.resetMsg'), confirmLabel: t('feed.reset') }))) return
    api.post<{ url: string }>('/me/calendar-feed').then((r) => (setUrl(r.url), qc.invalidateQueries({ queryKey: ['calendar-feed'] })), toastError)
  }
  const off = () => api.del('/me/calendar-feed').then(() => (setUrl(null), qc.invalidateQueries({ queryKey: ['calendar-feed'] }), toastSuccess(t('feed.turnedOff'))), toastError)
  return (
    <section id="calendar-feed" className="space-y-3 rounded-xl border border-line bg-surface p-5">
      <h2 className="font-semibold">{t('feed.title')}</h2>
      <p className="text-sm text-muted">{t('feed.hint')}</p>
      {d && (
        <div className="space-y-3 rounded-lg border border-line p-3">
          <div className="text-xs font-medium text-muted">{t('feed.contains')}</div>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" checked={d.all} onChange={() => save({ all: true })} className="mt-1 accent-[var(--color-accent)]" />
            <span>
              {t('feed.levelApp')}
              <span className="block text-xs text-muted">{t('feed.levelAppHint')}</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" checked={!d.all} onChange={() => save({ all: false })} className="mt-1 accent-[var(--color-accent)]" />
            <span>
              {t('feed.levelChosen')}
              <span className="block text-xs text-muted">{t('feed.levelChosenHint')}</span>
            </span>
          </label>
          {!d.all && (
            <div className="space-y-3 pl-6">
              <div>
                <div className="mb-1 text-xs font-medium text-muted">{t('feed.boards')}</div>
                <div className="flex flex-wrap gap-1.5">
                  {(boards.data ?? []).map((bd) => {
                    const on = d.board_ids.includes(bd.id)
                    return (
                      <button
                        key={bd.id}
                        type="button"
                        onClick={() => save({ board_ids: on ? d.board_ids.filter((x) => x !== bd.id) : [...d.board_ids, bd.id] })}
                        className={'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs cursor-pointer ' + (on ? 'border-accent bg-accent/10 font-medium' : 'border-line hover:bg-black/5 dark:hover:bg-white/5')}
                      >
                        <span className="h-2 w-2 rounded-full" style={{ background: bd.color }} />
                        {bd.name}
                      </button>
                    )
                  })}
                </div>
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-muted">{t('feed.cards', { count: d.cards.length })}</div>
                {d.cards.length === 0 && <p className="text-xs text-muted">{t('feed.noCards')}</p>}
                <div className="flex flex-wrap gap-1">
                  {d.cards.map((c) => (
                    <span key={c.id} className="flex max-w-full items-center gap-1 rounded-md border border-line py-0.5 pl-1.5 pr-0.5 text-xs">
                      <Link to={`/b/${c.board_id}?card=${c.id}`} className="min-w-0 truncate hover:underline">
                        <span className="text-muted">{c.board_name} · #{c.number}</span> {c.title}
                      </Link>
                      <button onClick={() => unpick(c.id)} title={t('common.remove')} className="shrink-0 rounded p-0.5 text-muted hover:text-red-600 cursor-pointer">
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}
          <label className="flex items-start gap-2 border-t border-line pt-3 text-sm">
            <input type="checkbox" checked={d.only_mine} onChange={(e) => save({ only_mine: e.target.checked })} className="mt-1 accent-[var(--color-accent)]" />
            <span>
              {t('feed.onlyMine')}
              <span className="block text-xs text-muted">{t('feed.onlyMineHint')}</span>
            </span>
          </label>
        </div>
      )}
      {full ? (
        <div className="space-y-2">
          <div className="flex gap-2">
            <Input readOnly value={full} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
            <Button onClick={() => navigator.clipboard?.writeText(full).then(() => toastSuccess(t('common.copied')))}>
              <Copy size={14} /> {t('common.copy')}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2 text-sm">
            <a className="text-accent hover:underline" href={full.replace(/^https?:/, 'webcal:')}>
              {t('feed.openApp')}
            </a>
            <span className="text-muted">·</span>
            <a className="text-accent hover:underline" target="_blank" rel="noreferrer" href={`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(full.replace(/^https?:/, 'webcal:'))}`}>
              {t('feed.google')}
            </a>
          </div>
          <p className="text-xs text-amber-700 dark:text-amber-400">{t('feed.secret')}</p>
        </div>
      ) : (
        status.data?.enabled && <p className="text-sm">{t('feed.activeHidden')}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant={status.data?.enabled ? 'outline' : 'primary'} onClick={create}>
          {status.data?.enabled ? <RefreshCw size={14} /> : <CalendarPlus size={14} />} {status.data?.enabled ? t('feed.reset') : t('feed.create')}
        </Button>
        {status.data?.enabled && (
          <Button variant="ghost" onClick={off}>
            {t('feed.turnOff')}
          </Button>
        )}
      </div>
    </section>
  )
}
