import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import clsx from 'clsx'
import { CalendarClock, CheckSquare, MessageSquare, Paperclip, Star } from 'lucide-react'
import { HoverCard } from 'radix-ui'
import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BoardHelpers } from '../lib/board'
import { fmtDate } from '../lib/prefs'
import type { CardSummary } from '../lib/types'
import { Markdown } from './Markdown'
import { Avatar } from './ui'

export function Stars({ value, onChange, size = 13 }: { value: number; onChange?: (v: number) => void; size?: number }) {
  return (
    <span className="inline-flex">
      {[1, 2, 3].map((i) => (
        <Star
          key={i}
          size={size}
          onClick={onChange ? (e) => (e.stopPropagation(), onChange(value === i ? i - 1 : i)) : undefined}
          className={clsx(onChange && 'cursor-pointer', i <= value ? 'fill-amber-400 text-amber-400' : 'text-zinc-300 dark:text-zinc-600')}
        />
      ))}
    </span>
  )
}

function isOverdue(c: CardSummary) {
  return !!c.due_at && new Date(c.due_at).getTime() < Date.now()
}

function TileBody({ card, b }: { card: CardSummary; b: BoardHelpers }) {
  const { t } = useTranslation()
  const labels = card.label_ids.map((id) => b.labels.get(id)).filter(Boolean)
  const status = card.status_id ? b.statuses.get(card.status_id) : undefined
  void t
  return (
    <>
      {card.color && <div className="absolute inset-y-0 left-0 w-1 rounded-l-lg" style={{ background: card.color }} />}
      {labels.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {labels.map((l) => (
            <span key={l!.id} className="rounded px-1.5 py-px text-[11px] font-medium text-white" style={{ background: l!.color }}>
              {l!.name}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-start gap-1.5">
        <span className="min-w-0 flex-1 text-sm leading-snug [overflow-wrap:anywhere]">{card.title}</span>
        {status && <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: status.color }} title={status.name} />}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted">
        <span>#{card.number}</span>
        {card.priority > 0 && <Stars value={card.priority} size={11} />}
        {card.due_at && (
          <span className={clsx('inline-flex items-center gap-0.5', isOverdue(card) && 'rounded bg-red-500/15 px-1 text-red-600')}>
            <CalendarClock size={11} />
            {fmtDate(card.due_at)}
          </span>
        )}
        {card.checklist_total > 0 && (
          <span className={clsx('inline-flex items-center gap-0.5', card.checklist_done === card.checklist_total && 'text-green-600')}>
            <CheckSquare size={11} />
            {card.checklist_done}/{card.checklist_total}
          </span>
        )}
        {card.comment_count > 0 && (
          <span className="inline-flex items-center gap-0.5">
            <MessageSquare size={11} />
            {card.comment_count}
          </span>
        )}
        {card.attachment_count > 0 && (
          <span className="inline-flex items-center gap-0.5">
            <Paperclip size={11} />
            {card.attachment_count}
          </span>
        )}
        <span className="ml-auto flex -space-x-1.5">
          {card.assignee_ids.slice(0, 4).map((id) => {
            const m = b.members.get(id)
            return m ? <Avatar key={id} name={m.display_name} color={m.avatar_color} size={20} /> : null
          })}
        </span>
      </div>
    </>
  )
}

/** Hover preview ("glimpse") of a card: rendered description excerpt + key facts. */
function Preview({ card, b }: { card: CardSummary; b: BoardHelpers }) {
  const { t } = useTranslation()
  const status = card.status_id ? b.statuses.get(card.status_id) : undefined
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-muted">#{card.number}</span>
        <span className="font-semibold leading-snug">{card.title}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        {status && (
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ background: status.color }} />
            {status.name}
          </span>
        )}
        {card.due_at && <span>· {t('card.due')}: {fmtDate(card.due_at, true)}</span>}
        {card.assignee_ids.length > 0 && (
          <span>· {card.assignee_ids.map((id) => b.members.get(id)?.display_name).filter(Boolean).join(', ')}</span>
        )}
      </div>
      {card.excerpt ? (
        <div className="max-h-64 overflow-hidden border-t border-line pt-2">
          <Markdown source={card.excerpt} compact />
        </div>
      ) : (
        <p className="text-xs italic text-muted">{t('card.noDescription')}</p>
      )}
    </div>
  )
}

export const CardTile = memo(function CardTile({
  card,
  b,
  onOpen,
  disabled,
}: {
  card: CardSummary
  b: BoardHelpers
  onOpen: (id: string) => void
  disabled: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { type: 'card', listId: card.list_id },
    disabled,
  })
  // Controlled so the preview never opens on top of a dialog (e.g. the card you just clicked).
  const [preview, setPreview] = useState(false)
  return (
    <HoverCard.Root
      openDelay={650}
      closeDelay={80}
      open={preview}
      onOpenChange={(o) => setPreview(o && !document.querySelector('[role=dialog]'))}
    >
      <HoverCard.Trigger asChild>
        <div
          ref={setNodeRef}
          style={{ transform: CSS.Translate.toString(transform), transition }}
          {...attributes}
          aria-disabled={undefined /* not draggable ≠ not clickable: the card still opens */}
          {...listeners}
          onClick={() => {
            setPreview(false)
            onOpen(card.id)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onOpen(card.id)
            else listeners?.onKeyDown?.(e)
          }}
          className={clsx(
            'relative cursor-pointer select-none rounded-lg border border-line bg-surface px-3 py-2 shadow-sm outline-none transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-accent',
            card.color && 'pl-3.5',
            isDragging && 'opacity-40',
          )}
        >
          <TileBody card={card} b={b} />
        </div>
      </HoverCard.Trigger>
      {!isDragging && (
        <HoverCard.Portal>
          <HoverCard.Content
            side="right"
            align="start"
            sideOffset={8}
            collisionPadding={12}
            className="z-40 w-80 rounded-xl border border-line bg-surface p-3 text-sm shadow-xl"
          >
            <Preview card={card} b={b} />
          </HoverCard.Content>
        </HoverCard.Portal>
      )}
    </HoverCard.Root>
  )
})

/** Static copy rendered in the drag overlay. */
export function CardGhost({ card, b }: { card: CardSummary; b: BoardHelpers }) {
  return (
    <div className="relative w-[272px] rotate-2 cursor-grabbing rounded-lg border border-line bg-surface px-3 py-2 shadow-xl">
      <TileBody card={card} b={b} />
    </div>
  )
}
