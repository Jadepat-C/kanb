import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  ArrowRightLeft,
  CalendarClock,
  CircleDot,
  Copy,
  CopyPlus,
  ExternalLink,
  Link2,
  Palette,
  Pencil,
  Plus,
  Star,
  Tag,
  UserCheck,
} from 'lucide-react'
import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api'
import { useMe } from '../lib/auth'
import type { BoardHelpers } from '../lib/board'
import { toast, toastError } from './toast'
import { Button, Dialog, Input, PALETTE } from './ui'
import { ContextMenu, CTX, MItem, MLabel, MSep, MSub } from './menu'

/** What the menu needs to know about a card. Board-level details are optional (not known on the global calendar). */
export interface MenuCard {
  id: string
  board_id: string
  number: number
  title: string
  due_at: string | null
  list_id?: string
  status_id?: string | null
  priority?: number
  label_ids?: string[]
  assignee_ids?: string[]
  color?: string | null
}

const M = CTX

/** Same time of day as before (09:00 if there was none), on today + `days`. */
function dueIn(days: number, prev: string | null) {
  const p = prev ? new Date(prev) : null
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate() + days, p ? p.getHours() : 9, p ? p.getMinutes() : 0).toISOString()
}

/**
 * Right-click menu for a card (Kanban tile or calendar chip).
 * `b` (board data) enables the board-specific submenus; `canEdit` is used when `b` isn't available.
 */
export function CardContextMenu({
  card,
  b,
  canEdit,
  onOpen,
  onNew,
  children,
}: {
  card: MenuCard
  b?: BoardHelpers
  canEdit?: boolean
  onOpen: () => void
  onNew?: () => void
  children: ReactElement
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: me } = useMe()
  const [renaming, setRenaming] = useState(false)
  const can = (p: string) => (b ? b.can(p) : p === 'cards.edit' ? !!canEdit : true) // server enforces the rest

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['board', card.board_id] })
    qc.invalidateQueries({ queryKey: ['calendar'] })
    qc.invalidateQueries({ queryKey: ['card', card.id] })
    qc.invalidateQueries({ queryKey: ['timeline', card.id] })
  }
  const run = useMutation({
    mutationFn: (f: () => Promise<unknown>) => f(),
    onSuccess: refresh,
    onError: toastError,
  })
  const patch = (body: Record<string, unknown>) => run.mutate(() => api.patch(`/cards/${card.id}`, body))
  const setIds = (kind: 'labels' | 'assignees', ids: string[]) => run.mutate(() => api.put(`/cards/${card.id}/${kind}`, { ids }))
  const toggle = (arr: string[], id: string) => (arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id])
  const data = b?.data

  const link = `${location.origin}/b/${card.board_id}?card=${card.id}`
  const mine = !!me && !!card.assignee_ids?.includes(me.id)
  const isMember = !!me && !!data?.members.some((m) => m.user_id === me.id)

  return (
    <>
      <ContextMenu trigger={children}>
        <MLabel M={M}>
          #{card.number} {card.title}
        </MLabel>
        <MItem M={M} onSelect={onOpen} shortcut="Enter">
          <ExternalLink size={14} /> {t('menu.open')}
        </MItem>
        {can('cards.edit') && (
          <MItem M={M} onSelect={() => setRenaming(true)}>
            <Pencil size={14} /> {t('common.rename')}
          </MItem>
        )}
        <MSep M={M} />
        {onNew && can('cards.create') && (
          <MItem M={M} onSelect={onNew}>
            <Plus size={14} /> {t('menu.newCard')}
          </MItem>
        )}
        {can('cards.create') && (
          <MItem M={M} onSelect={() => run.mutate(() => api.post(`/cards/${card.id}/duplicate`))}>
            <CopyPlus size={14} /> {t('menu.duplicate')}
          </MItem>
        )}
        <MItem
          M={M}
          onSelect={() =>
            navigator.clipboard?.writeText(link).then(
              () => toast(t('menu.linkCopied')),
              () => toast(link),
            )
          }
        >
          <Link2 size={14} /> {t('menu.copyLink')}
        </MItem>
        <MItem
          M={M}
          onSelect={() =>
            navigator.clipboard?.writeText(`#${card.number} ${card.title}`).then(() => toast(t('menu.copied')))
          }
        >
          <Copy size={14} /> {t('menu.copyTitle')}
        </MItem>

        {(data || can('cards.edit')) && <MSep M={M} />}
        {data && card.list_id && can('cards.move') && (
          <MSub M={M} icon={<ArrowRightLeft size={14} />} label={t('menu.moveTo')}>
            {data.lists.map((l) => (
              <MItem
                key={l.id}
                M={M}
                checked={l.id === card.list_id}
                onSelect={() => l.id !== card.list_id && run.mutate(() => api.post(`/cards/${card.id}/move`, { list_id: l.id, index: 1e9 }))}
              >
                {l.name}
              </MItem>
            ))}
          </MSub>
        )}
        {data && can('cards.edit') && (
          <MSub M={M} icon={<CircleDot size={14} />} label={t('card.status')}>
            {data.statuses.map((s) => (
              <MItem key={s.id} M={M} checked={card.status_id === s.id} onSelect={() => patch({ status_id: s.id })}>
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
                {s.name}
              </MItem>
            ))}
            <MItem M={M} checked={!card.status_id} onSelect={() => patch({ status_id: null })}>
              <span className="h-2.5 w-2.5 rounded-full border border-line" />
              {t('filter.noStatus')}
            </MItem>
          </MSub>
        )}
        {data && can('cards.edit') && (
          <MSub M={M} icon={<Star size={14} />} label={t('card.priority')}>
            {[3, 2, 1, 0].map((p) => (
              <MItem key={p} M={M} checked={card.priority === p} onSelect={() => patch({ priority: p })}>
                <span className="w-12 text-amber-500">{p ? '★'.repeat(p) : ''}</span>
                {p === 0 && <span className="text-muted">{t('filter.noPriority')}</span>}
              </MItem>
            ))}
          </MSub>
        )}
        {can('cards.edit') && (
          <MSub M={M} icon={<CalendarClock size={14} />} label={t('card.due')}>
            <MItem M={M} onSelect={() => patch({ due_at: dueIn(0, card.due_at) })}>
              {t('menu.today')}
            </MItem>
            <MItem M={M} onSelect={() => patch({ due_at: dueIn(1, card.due_at) })}>
              {t('menu.tomorrow')}
            </MItem>
            <MItem M={M} onSelect={() => patch({ due_at: dueIn(7, card.due_at) })}>
              {t('menu.nextWeek')}
            </MItem>
            <MItem M={M} onSelect={onOpen}>
              {t('menu.pickDate')}
            </MItem>
            {card.due_at && (
              <>
                <MSep M={M} />
                <MItem M={M} onSelect={() => patch({ due_at: null })}>
                  {t('menu.clearDue')}
                </MItem>
              </>
            )}
          </MSub>
        )}
        {data && can('cards.edit') && data.labels.length > 0 && (
          <MSub M={M} icon={<Tag size={14} />} label={t('card.labels')}>
            {data.labels.map((l) => (
              <MItem
                key={l.id}
                M={M}
                keepOpen
                checked={!!card.label_ids?.includes(l.id)}
                onSelect={() => setIds('labels', toggle(card.label_ids ?? [], l.id))}
              >
                <span className="h-3 w-3 rounded-sm" style={{ background: l.color }} />
                {l.name}
              </MItem>
            ))}
          </MSub>
        )}
        {data && can('cards.edit') && isMember && (
          <MItem M={M} onSelect={() => setIds('assignees', toggle(card.assignee_ids ?? [], me!.id))}>
            <UserCheck size={14} /> {mine ? t('menu.unassignMe') : t('menu.assignMe')}
          </MItem>
        )}
        {data && can('cards.edit') && (
          <MSub M={M} icon={<Palette size={14} />} label={t('card.color')}>
            <div className="grid grid-cols-6 gap-1 p-1">
              {[null, ...PALETTE].map((c) => (
                <M.Item
                  key={c ?? 'none'}
                  onSelect={() => patch({ color: c })}
                  className="h-6 w-6 cursor-pointer rounded-full border border-line outline-none data-[highlighted]:ring-2 data-[highlighted]:ring-accent"
                  style={{ background: c ?? 'transparent' }}
                  aria-label={c ?? 'none'}
                />
              ))}
            </div>
          </MSub>
        )}
        {can('cards.delete') && (
          <>
            <MSep M={M} />
            <MItem M={M} danger onSelect={() => confirm(t('card.archiveConfirm')) && run.mutate(() => api.del(`/cards/${card.id}`))}>
              <Archive size={14} /> {t('card.archive')}
            </MItem>
          </>
        )}
      </ContextMenu>
      {renaming && (
        <RenameDialog
          value={card.title}
          onClose={() => setRenaming(false)}
          onSave={(title) => {
            patch({ title })
            setRenaming(false)
          }}
        />
      )}
    </>
  )
}

export function RenameDialog({ value, onSave, onClose, title }: { value: string; onSave: (v: string) => void; onClose: () => void; title?: string }) {
  const { t } = useTranslation()
  const [v, setV] = useState(value)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={title ?? t('common.rename')}>
      <form
        className="space-y-3 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (v.trim()) onSave(v.trim())
        }}
      >
        <Input value={v} onChange={(e) => setV(e.target.value)} autoFocus onFocus={(e) => e.currentTarget.select()} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary">{t('common.save')}</Button>
        </div>
      </form>
    </Dialog>
  )
}
