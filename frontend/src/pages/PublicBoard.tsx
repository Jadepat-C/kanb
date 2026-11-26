/** A board opened from its public link (/p/:token): read-only, no account, no live socket (refreshes every minute). */
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { CalendarClock, CalendarDays, Download, Eye, Languages, Link2Off, MessageSquare, Moon, Paperclip, Sun } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams, useSearchParams } from 'react-router'
import { LabelChip, Stars } from '../components/CardTile'
import { Markdown } from '../components/Markdown'
import { Avatar, Button, Dialog, Spinner } from '../components/ui'
import { api } from '../lib/api'
import { groupCards } from '../lib/board'
import { setLocale } from '../lib/i18n'
import { fmtDate, fmtRelative, fmtSize, isDark, setTheme } from '../lib/prefs'
import type { CardSummary, Label, List, Status } from '../lib/types'

interface Person {
  user_id: string
  display_name: string
  avatar_color: string
}

interface PublicBoardData {
  board: { name: string; description: string; color: string }
  comments: boolean
  files: boolean
  lists: List[]
  cards: CardSummary[]
  labels: Label[]
  statuses: Status[]
  people: Person[]
}

interface PublicCardData {
  card: {
    id: string
    list_id: string
    number: number
    title: string
    description: string
    priority: number
    status_id: string | null
    color: string | null
    start_at: string | null
    due_at: string | null
    done_at: string | null
    created_at: string
    updated_at: string
    label_ids: string[]
    assignee_ids: string[]
  }
  attachments: {
    id: string
    filename: string
    content_type: string
    size: number
    created_at: string
  }[]
  comments: {
    id: string
    author_name: string | null
    author_color: string | null
    body: string
    created_at: string
    edited: boolean
  }[]
  people: Person[]
}

/** Search engines shouldn't list shared boards, even if a link ends up somewhere public. */
function useNoIndex() {
  useEffect(() => {
    const m = document.createElement('meta')
    m.name = 'robots'
    m.content = 'noindex, nofollow'
    document.head.appendChild(m)
    return () => m.remove()
  }, [])
}

export function PublicBoard() {
  const { token = '' } = useParams()
  const { t, i18n } = useTranslation()
  const [, force] = useState(0)
  const [sp, setSp] = useSearchParams()
  useNoIndex()
  const q = useQuery({
    queryKey: ['public', token],
    queryFn: () => api.get<PublicBoardData>(`/public/${token}`),
    refetchInterval: 60_000,
  })
  const d = q.data
  useEffect(() => {
    if (d) document.title = `${d.board.name} · Kanb`
  }, [d])
  const grouped = useMemo(() => groupCards(d?.cards ?? []), [d])
  const byId = useMemo(() => new Map((d?.cards ?? []).map((c) => [c.id, c])), [d])
  const labels = useMemo(() => new Map((d?.labels ?? []).map((l) => [l.id, l])), [d])
  const statuses = useMemo(() => new Map((d?.statuses ?? []).map((s) => [s.id, s])), [d])
  const people = useMemo(() => new Map((d?.people ?? []).map((p) => [p.user_id, p])), [d])
  const open = sp.get('card')

  const toggles = (
    <div className="flex shrink-0 gap-1">
      <Button variant="ghost" size="sm" onClick={() => setLocale(i18n.language === 'th' ? 'en' : 'th')}>
        <Languages size={15} /> {i18n.language === 'th' ? 'ไทย' : 'EN'}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('nav.theme')}
        onClick={() => {
          setTheme(isDark() ? 'light' : 'dark')
          force((x) => x + 1)
        }}
      >
        {isDark() ? <Sun size={15} /> : <Moon size={15} />}
      </Button>
    </div>
  )

  if (q.isLoading)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  if (!d)
    return (
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="w-full max-w-sm space-y-3 rounded-xl border border-line bg-surface p-6 text-center shadow-sm">
          <Link2Off size={28} className="mx-auto text-muted" />
          <h1 className="text-lg font-semibold">{t('publicBoard.notFound')}</h1>
          <p className="text-sm text-muted">{t('publicBoard.notFoundHint')}</p>
        </div>
      </div>
    )
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5">
        <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: d.board.color }} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold">{d.board.name}</h1>
          {d.board.description && <p className="truncate text-xs text-muted">{d.board.description}</p>}
        </div>
        <span className="hidden shrink-0 items-center gap-1 rounded-full bg-black/5 px-2 py-0.5 text-xs text-muted sm:flex dark:bg-white/10">
          <Eye size={13} /> {t('publicBoard.readOnly')}
        </span>
        {toggles}
      </header>
      <main className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
        <div className="flex h-full items-start gap-3 p-3 sm:p-4">
          {d.lists.map((l) => {
            const ids = grouped[l.id] ?? []
            return (
              <section
                key={l.id}
                className="flex max-h-full w-[85vw] max-w-72 shrink-0 flex-col rounded-xl bg-[var(--surface-2)] sm:w-72"
                aria-label={l.name}
              >
                <h2 className="flex items-center gap-2 px-3 pb-1.5 pt-2.5 text-sm font-semibold">
                  {l.color && <span className="h-2.5 w-2.5 rounded-full" style={{ background: l.color }} />}
                  <span className="min-w-0 flex-1 truncate">{l.name}</span>
                  <span className="text-xs font-normal text-muted">{ids.length}</span>
                </h2>
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                  {ids.length === 0 && <p className="px-1 py-2 text-xs text-muted">{t('publicBoard.empty')}</p>}
                  {ids.map((id) => {
                    const c = byId.get(id)!
                    const status = c.status_id ? statuses.get(c.status_id) : undefined
                    const overdue = !c.done && !!c.due_at && new Date(c.due_at).getTime() < Date.now()
                    return (
                      <button
                        key={id}
                        onClick={() => setSp({ card: id })}
                        className="relative block w-full overflow-hidden rounded-md border border-line bg-surface px-3 py-2 text-left text-sm shadow-sm hover:border-accent/50 cursor-pointer"
                      >
                        {c.color && <span className="absolute inset-y-0 left-0 w-1" style={{ background: c.color }} />}
                        {c.label_ids.length > 0 && (
                          <span className="mb-1.5 flex flex-wrap gap-1">
                            {c.label_ids
                              .map((lid) => labels.get(lid))
                              .filter(Boolean)
                              .map((lb) => (
                                <LabelChip key={lb!.id} name={lb!.name} color={lb!.color} />
                              ))}
                          </span>
                        )}
                        <span className={clsx('block [overflow-wrap:anywhere]', c.done && 'text-muted line-through')}>
                          <span className="mr-1 text-xs text-muted">#{c.number}</span>
                          {c.title}
                        </span>
                        <span className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted">
                          {status && (
                            <span className="flex items-center gap-1">
                              <span className="h-2 w-2 rounded-full" style={{ background: status.color }} /> {status.name}
                            </span>
                          )}
                          {c.priority > 0 && <Stars value={c.priority} size={11} />}
                          {c.due_at && (
                            <span className={clsx('flex items-center gap-1', overdue && 'font-medium text-red-600')}>
                              <CalendarClock size={12} /> {fmtDate(c.due_at)}
                            </span>
                          )}
                          {c.comment_count > 0 && (
                            <span className="flex items-center gap-0.5">
                              <MessageSquare size={12} /> {c.comment_count}
                            </span>
                          )}
                          {c.attachment_count > 0 && (
                            <span className="flex items-center gap-0.5">
                              <Paperclip size={12} /> {c.attachment_count}
                            </span>
                          )}
                          {c.assignee_ids.length > 0 && (
                            <span className="ml-auto flex -space-x-1.5">
                              {c.assignee_ids
                                .map((u) => people.get(u))
                                .filter(Boolean)
                                .slice(0, 4)
                                .map((p) => (
                                  <Avatar key={p!.user_id} name={p!.display_name} color={p!.avatar_color} size={20} />
                                ))}
                            </span>
                          )}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </section>
            )
          })}
        </div>
      </main>
      <footer className="border-t border-line px-4 py-1.5 text-center text-[11px] text-muted">
        {t('publicBoard.poweredBy')} ·{' '}
        <Link to="/login" className="hover:underline">
          {t('publicBoard.signIn')}
        </Link>
      </footer>
      {open && (
        <PublicCard
          token={token}
          cardId={open}
          labels={labels}
          statuses={statuses}
          lists={d.lists}
          showComments={d.comments}
          onClose={() => setSp({})}
        />
      )}
    </div>
  )
}

function PublicCard({
  token,
  cardId,
  labels,
  statuses,
  lists,
  showComments,
  onClose,
}: {
  token: string
  cardId: string
  labels: Map<string, Label>
  statuses: Map<string, Status>
  lists: List[]
  showComments: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  const q = useQuery({
    queryKey: ['public', token, 'card', cardId],
    queryFn: () => api.get<PublicCardData>(`/public/${token}/cards/${cardId}`),
  })
  const d = q.data
  const c = d?.card
  const base = `/api/public/${token}/files`
  const status = c?.status_id ? statuses.get(c.status_id) : undefined
  const list = lists.find((l) => l.id === c?.list_id)
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex gap-3 text-sm">
      <span className="w-24 shrink-0 text-muted">{label}</span>
      <span className="min-w-0 flex-1">{value}</span>
    </div>
  )
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={c ? `#${c.number} ${c.title}` : ' '} wide>
      {!d ? (
        <div className="flex justify-center p-10">
          {q.isError ? <p className="text-sm text-muted">{t('errors.not_found')}</p> : <Spinner />}
        </div>
      ) : (
        <div className="grid gap-6 p-5 md:grid-cols-[1fr_240px]">
          <div className="min-w-0 space-y-5">
            {c!.description.trim() ? (
              <Markdown source={c!.description} fileBase={base} />
            ) : (
              <p className="text-sm text-muted">{t('publicBoard.noDescription')}</p>
            )}
            {d.attachments.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">{t('publicBoard.attachments')}</h3>
                <ul className="divide-y divide-[var(--border)] rounded-lg border border-line">
                  {d.attachments.map((a) => (
                    <li key={a.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                      <Paperclip size={14} className="shrink-0 text-muted" />
                      <a
                        href={`${base}/${a.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="min-w-0 flex-1 truncate hover:underline"
                      >
                        {a.filename}
                      </a>
                      <span className="shrink-0 text-xs text-muted">{fmtSize(a.size)}</span>
                      <a
                        href={`${base}/${a.id}?download=1`}
                        className="rounded p-1 text-muted hover:bg-black/5 dark:hover:bg-white/10"
                        aria-label={t('common.download')}
                        title={t('common.download')}
                      >
                        <Download size={14} />
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {showComments && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">{t('publicBoard.comments')}</h3>
                {d.comments.length === 0 && <p className="text-sm text-muted">{t('publicBoard.noComments')}</p>}
                {d.comments.map((m) => (
                  <div key={m.id} className="flex gap-2.5">
                    <Avatar name={m.author_name ?? '?'} color={m.author_color ?? '#71717a'} size={26} />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-muted">
                        <span className="font-medium text-[var(--text)]">{m.author_name ?? '—'}</span> · {fmtRelative(m.created_at)}
                        {m.edited && ` · ${t('card.edited')}`}
                      </div>
                      <Markdown source={m.body} fileBase={base} compact />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <aside className="space-y-2.5 md:border-l md:border-line md:pl-5">
            {list && row(t('card.column'), list.name)}
            {status &&
              row(
                t('card.status'),
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ background: status.color }} /> {status.name}
                </span>,
              )}
            {c!.label_ids.length > 0 &&
              row(
                t('card.labels'),
                <span className="flex flex-wrap gap-1">
                  {c!.label_ids
                    .map((id) => labels.get(id))
                    .filter(Boolean)
                    .map((l) => (
                      <LabelChip key={l!.id} name={l!.name} color={l!.color} />
                    ))}
                </span>,
              )}
            {d.people.length > 0 &&
              row(
                t('card.assignees'),
                <span className="flex flex-col gap-1">
                  {d.people.map((p) => (
                    <span key={p.user_id} className="flex items-center gap-1.5">
                      <Avatar name={p.display_name} color={p.avatar_color} size={20} /> {p.display_name}
                    </span>
                  ))}
                </span>,
              )}
            {c!.priority > 0 && row(t('card.priority'), <Stars value={c!.priority} />)}
            {c!.start_at && row(t('card.start'), fmtDate(c!.start_at, true))}
            {c!.due_at &&
              row(
                t('card.due'),
                <span className="flex items-center gap-1">
                  <CalendarDays size={13} /> {fmtDate(c!.due_at, true)}
                </span>,
              )}
            <p className="border-t border-line pt-2.5 text-xs text-muted">
              {t('publicBoard.updated', { when: fmtRelative(c!.updated_at) })}
            </p>
          </aside>
        </div>
      )}
    </Dialog>
  )
}
