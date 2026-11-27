/** The bar at the bottom of the board while cards are selected: change them all at once. */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Archive, ArrowRightLeft, CalendarClock, CircleDot, Eye, EyeOff, MoreHorizontal, Star, Tag, UserCheck, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api'
import { useMe } from '../lib/auth'
import type { BoardHelpers } from '../lib/board'
import { selection, useSelection } from '../lib/selection'
import { label as userLabel } from '../lib/user'
import { ask } from './dialogs'
import { toast, toastError, toastSuccess } from './toast'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from './ui'

type Bulk = { action: string; list_id?: string; at?: 'top' | 'bottom'; changes?: Record<string, unknown>; add?: string[]; remove?: string[]; watching?: boolean }

/** Today + `days` at 09:00 local time (as a card's own menu does for a card without a due time). */
function dueIn(days: number) {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate() + days, 9, 0).toISOString()
}

function BarMenu({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <button className="flex items-center gap-1.5 rounded-md px-1.5 py-1.5 text-sm hover:bg-black/5 sm:px-2 dark:hover:bg-white/10 cursor-pointer">
          {icon}
          <span className="hidden md:inline">{label}</span>
        </button>
      </MenuTrigger>
      <MenuContent align="start">{children}</MenuContent>
    </Menu>
  )
}

export function SelectionBar({ b, boardId }: { b: BoardHelpers; boardId: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: me } = useMe()
  const sel = useSelection()
  // only cards still on the board (someone may have archived one meanwhile)
  const ids = (b.data?.cards ?? []).filter((c) => sel.has(c.id)).map((c) => c.id)
  const run = useMutation({
    mutationFn: (body: Bulk) => api.post<{ done: number; failed: { id: string; error: string }[] }>(`/boards/${boardId}/cards/bulk`, { card_ids: ids, ...body }),
    onSuccess: (r, body) => {
      qc.invalidateQueries({ queryKey: ['board', boardId] })
      for (const id of ids) qc.invalidateQueries({ queryKey: ['card', id] })
      const total = r.done + r.failed.length
      if (r.failed.length === 0) toastSuccess(t('bulk.done', { count: r.done }))
      else if (r.done === 0) toast(t('bulk.none'), 'error')
      else toast(t('bulk.partial', { done: r.done, total }), 'error')
      // archived cards leave the board; the rest stay selected for the next change
      if (body.action === 'archive') selection.clear()
      else if (r.failed.length) selection.set(ids.filter((id) => !r.failed.some((f) => f.id === id)))
    },
    onError: toastError,
  })
  if (ids.length === 0 || !b.data) return null
  const d = b.data
  const go = (body: Bulk) => run.mutate(body)
  const update = (changes: Record<string, unknown>) => go({ action: 'update', changes })
  const allWatched = ids.every((id) => b.watching.has(id))
  return (
    <div
      role="toolbar"
      aria-label={t('bulk.selected', { count: ids.length })}
      className="fixed inset-x-4 bottom-4 z-30 mx-auto flex w-fit max-w-[calc(100%-2rem)] flex-wrap items-center justify-center gap-0.5 rounded-xl border border-line bg-surface p-1.5 shadow-lg"
    >
      <span className="px-1.5 text-sm font-medium tabular-nums sm:px-2">{t('bulk.selected', { count: ids.length })}</span>
      <span className="mx-1 hidden h-5 w-px bg-[var(--border)] sm:block" />
      {b.can('cards.move') && (
        <BarMenu icon={<ArrowRightLeft size={15} />} label={t('menu.moveTo')}>
          <MenuLabel>{t('menu.moveTo')}</MenuLabel>
          {d.lists.map((l) => (
            <MenuItem key={l.id} onSelect={() => go({ action: 'move', list_id: l.id, at: 'bottom' })}>
              {l.name}
            </MenuItem>
          ))}
        </BarMenu>
      )}
      {b.can('cards.status') && d.statuses.length > 0 && (
        <BarMenu icon={<CircleDot size={15} />} label={t('card.status')}>
          {d.statuses.map((s) => (
            <MenuItem key={s.id} onSelect={() => update({ status_id: s.id })}>
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
              {s.name}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onSelect={() => update({ status_id: null })}>{t('bulk.noStatus')}</MenuItem>
        </BarMenu>
      )}
      {b.can('cards.edit') && (
        <BarMenu icon={<Star size={15} />} label={t('card.priority')}>
          {[3, 2, 1, 0].map((p) => (
            <MenuItem key={p} onSelect={() => update({ priority: p })}>
              <span className="w-12 text-amber-500">{p ? '★'.repeat(p) : ''}</span>
              {p === 0 && <span className="text-muted">{t('filter.noPriority')}</span>}
            </MenuItem>
          ))}
        </BarMenu>
      )}
      {b.can('cards.due') && (
        <BarMenu icon={<CalendarClock size={15} />} label={t('card.due')}>
          <MenuItem onSelect={() => update({ due_at: dueIn(0) })}>{t('menu.today')}</MenuItem>
          <MenuItem onSelect={() => update({ due_at: dueIn(1) })}>{t('menu.tomorrow')}</MenuItem>
          <MenuItem onSelect={() => update({ due_at: dueIn(7) })}>{t('menu.nextWeek')}</MenuItem>
          <MenuSeparator />
          <MenuItem onSelect={() => update({ due_at: null })}>{t('menu.clearDue')}</MenuItem>
        </BarMenu>
      )}
      {b.can('cards.labels') && d.labels.length > 0 && (
        <BarMenu icon={<Tag size={15} />} label={t('card.labels')}>
          <MenuLabel>{t('bulk.add')}</MenuLabel>
          {d.labels.map((l) => (
            <MenuItem key={l.id} onSelect={() => go({ action: 'labels', add: [l.id] })}>
              <span className="h-3 w-3 rounded-sm" style={{ background: l.color }} />
              {l.name}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuLabel>{t('bulk.remove')}</MenuLabel>
          {d.labels.map((l) => (
            <MenuItem key={l.id} onSelect={() => go({ action: 'labels', remove: [l.id] })}>
              <span className="h-3 w-3 rounded-sm opacity-50" style={{ background: l.color }} />
              <span className="line-through decoration-[var(--muted)]">{l.name}</span>
            </MenuItem>
          ))}
        </BarMenu>
      )}
      {b.can('cards.assign') && (
        <BarMenu icon={<UserCheck size={15} />} label={t('bulk.assign')}>
          <MenuLabel>{t('bulk.add')}</MenuLabel>
          {d.members.map((m) => (
            <MenuItem key={m.user_id} onSelect={() => go({ action: 'assignees', add: [m.user_id] })}>
              {m.user_id === me?.id ? t('bulk.me') : userLabel(m)}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuLabel>{t('bulk.remove')}</MenuLabel>
          {d.members.map((m) => (
            <MenuItem key={m.user_id} onSelect={() => go({ action: 'assignees', remove: [m.user_id] })}>
              <span className="line-through decoration-[var(--muted)]">{m.user_id === me?.id ? t('bulk.me') : userLabel(m)}</span>
            </MenuItem>
          ))}
        </BarMenu>
      )}
      <BarMenu icon={<MoreHorizontal size={15} />} label={t('bulk.more')}>
        <MenuItem onSelect={() => go({ action: 'watch', watching: !allWatched })}>
          {allWatched ? <EyeOff size={14} /> : <Eye size={14} />} {allWatched ? t('watch.stop') : t('watch.start')}
        </MenuItem>
        {b.can('cards.archive') && (
          <MenuItem
            danger
            onSelect={async () => {
              const ok = await ask({ title: t('bulk.archiveTitle', { count: ids.length }), message: t('bulk.archiveMsg'), confirmLabel: t('bulk.archive'), danger: true })
              if (ok) go({ action: 'archive' })
            }}
          >
            <Archive size={14} /> {t('bulk.archive')}
          </MenuItem>
        )}
      </BarMenu>
      <span className="mx-1 hidden h-5 w-px bg-[var(--border)] sm:block" />
      <button
        className="rounded-md p-1.5 text-muted hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer"
        onClick={() => selection.clear()}
        title={t('bulk.clear')}
        aria-label={t('bulk.clear')}
      >
        <X size={16} />
      </button>
    </div>
  )
}
