import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, User, CalendarPlus } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, Link } from 'react-router'
import { Calendar, type CalItem } from '../components/Calendar'
import { CardContextMenu } from '../components/CardMenu'
import { ContextMenu, CTX, MItem } from '../components/menu'
import { NewCardDialog, type NewCardPreset } from '../components/NewCardDialog'
import { toastError } from '../components/toast'
import { Button } from '../components/ui'
import { api } from '../lib/api'
import { useMe } from '../lib/auth'
import type { BoardListItem } from '../lib/types'

interface Item {
  id: string
  board_id: string
  board_name: string
  board_color: string
  list_name: string
  number: number
  title: string
  due_at: string
  priority: number
  status_name: string | null
  status_color: string | null
  assignee_ids: string[]
  can_edit: boolean
  done: boolean
  start_at: string | null
  assignee_names: string[]
  labels: { name: string; color: string }[]
  excerpt: string
}

/** Every card with a due date, across all boards you can see. */
export function CalendarPage() {
  const { t } = useTranslation()
  const { data: me } = useMe()
  const nav = useNavigate()
  const qc = useQueryClient()
  const [range, setRange] = useState<{ from: string; to: string } | null>(null)
  const [mine, setMine] = useState(false)
  const [board, setBoard] = useState('')
  const [newCard, setNewCard] = useState<NewCardPreset | null>(null)
  const onRange = useCallback((from: Date, to: Date) => setRange({ from: from.toISOString(), to: to.toISOString() }), [])

  const boards = useQuery({ queryKey: ['boards'], queryFn: () => api.get<BoardListItem[]>('/boards') })
  const q = useQuery({
    queryKey: ['calendar', range?.from, range?.to],
    queryFn: () => api.get<Item[]>(`/calendar?from=${encodeURIComponent(range!.from)}&to=${encodeURIComponent(range!.to)}`),
    enabled: !!range,
    placeholderData: keepPreviousData,
  })
  const move = useMutation({
    mutationFn: (p: { id: string; due: string | null }) => api.patch(`/cards/${p.id}`, { due_at: p.due }),
    onError: toastError,
    onSettled: () => qc.invalidateQueries({ queryKey: ['calendar'] }),
  })

  const raw = q.data
  const items = useMemo<CalItem[]>(
    () =>
      (raw ?? [])
        .filter((i) => (!mine || i.assignee_ids.includes(me?.id ?? '')) && (!board || i.board_id === board))
        .map((i) => ({
          id: i.id,
          title: i.title,
          number: i.number,
          due: i.due_at,
          color: i.board_color,
          sub: `${i.board_name} · ${i.list_name}${i.status_name ? ` · ${i.status_name}` : ''}`,
          priority: i.priority,
          canMove: i.can_edit,
          done: i.done,
          badge: { label: i.board_name, color: i.board_color },
        })),
    [raw, mine, board, me?.id],
  )
  const byId = useMemo(() => new Map((raw ?? []).map((i) => [i.id, i])), [raw])
  const open = (id: string, boardId?: string) => nav(`/b/${boardId ?? byId.get(id)?.board_id}?view=calendar&card=${id}`)

  return (
    <div className="h-full">
      <Calendar
        glimpse={(item) => {
          const i = byId.get(item.id)
          return i
            ? {
                number: i.number,
                title: i.title,
                done: i.done,
                status: i.status_name ? { name: i.status_name, color: i.status_color ?? '#a1a1aa' } : null,
                labels: i.labels,
                start_at: i.start_at,
                due_at: i.due_at,
                people: i.assignee_names,
                excerpt: i.excerpt,
                sub: `${i.board_name} · ${i.list_name}`,
              }
            : null
        }}
        items={items}
        onRange={onRange}
        onOpen={(id) => open(id)}
        onNewAt={(due) => setNewCard({ boardId: board || undefined, due })}
        itemMenu={(item, trigger) => {
          const c = byId.get(item.id)
          if (!c) return trigger
          return (
            <CardContextMenu
              card={c}
              canEdit={c.can_edit}
              onOpen={() => open(c.id)}
              onNew={() => setNewCard({ boardId: c.board_id, due: c.due_at })}
            >
              {trigger}
            </CardContextMenu>
          )
        }}
        dayMenu={(due, trigger) => (
          <ContextMenu trigger={trigger}>
            <MItem M={CTX} onSelect={() => setNewCard({ boardId: board || undefined, due })}>
              <Plus size={14} /> {t('menu.newCardOnDay')}
            </MItem>
          </ContextMenu>
        )}
        onMove={(id, due) => move.mutate({ id, due })}
        toolbar={
          <>
            <select value={board} onChange={(e) => setBoard(e.target.value)} className="h-8 w-full rounded-md border border-line bg-surface px-2 text-xs sm:h-7 sm:w-auto sm:max-w-48">
              <option value="">{t('calendar.allBoards')}</option>
              {(boards.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <Button size="sm" variant={mine ? 'primary' : 'outline'} onClick={() => setMine(!mine)}>
              <User size={13} /> {t('board.onlyMine')}
            </Button>
            <Link to="/profile?tab=calendar" className="inline-flex h-7 items-center gap-1 rounded-md border border-line px-2 text-xs hover:bg-black/5 dark:hover:bg-white/5" title={t('feed.hint')}>
              <CalendarPlus size={13} /> {t('feed.subscribe')}
            </Link>
            <Button size="sm" variant="primary" onClick={() => setNewCard({ boardId: board || undefined, due: null })}>
              <Plus size={14} /> {t('menu.newCard')}
            </Button>
          </>
        }
      />
      {newCard && (
        <NewCardDialog preset={newCard} onClose={() => setNewCard(null)} onCreated={(c, boardId, o) => o && open(c.id, boardId)} />
      )}
    </div>
  )
}
