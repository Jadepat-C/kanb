import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import clsx from 'clsx'
import { CalendarCheck, CalendarClock, CheckSquare, CircleCheck, Link2, MessageSquare, Paperclip, Star } from 'lucide-react'
import { HoverCard } from 'radix-ui'
import { cloneElement, memo, useState, type ReactElement, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { BoardHelpers, Viewer } from '../lib/board'
import { fmtDate } from '../lib/prefs'
import { avatarUrl, label } from '../lib/user'
import type { CardSummary, Label, Member, Status } from '../lib/types'
import { useCalendarFeed } from './CalendarFeed'
import { Markdown } from './Markdown'
import { CardContextMenu } from './CardMenu'
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

/** A label name, tinted by its colour; mixed with the text colour so any colour stays readable in light and dark. */
export function LabelChip({ name, color, className }: { name: string; color: string; className?: string }) {
  return (
    <span
      className={clsx('rounded-sm font-medium leading-4', className ?? 'px-1.5 py-px text-[11px]')}
      style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color: `color-mix(in srgb, ${color} 55%, var(--text))` }}
    >
      {name}
    </span>
  )
}

function isOverdue(c: CardSummary) {
  return !c.done && !!c.due_at && new Date(c.due_at).getTime() < Date.now()
}

function TileBody({ card, b }: { card: CardSummary; b: BoardHelpers }) {
  const { t } = useTranslation()
  const labels = card.label_ids.map((id) => b.labels.get(id)).filter(Boolean)
  const status = card.status_id ? b.statuses.get(card.status_id) : undefined
  // only prerequisites that aren't finished yet still block this card
  const feedPicked = new Set((useCalendarFeed().data?.cards ?? []).map((c) => c.id))
  const openBlockers = (card.depends_on ?? []).filter((id) => !b.data?.cards.find((c) => c.id === id)?.done).length
  void t
  return (
    <>
      {card.color && <div className="absolute inset-y-0 left-0 w-1 rounded-l-md" style={{ background: card.color }} />}
      {labels.length > 0 && (
        <>
          {/* the label edge: one band per label across the top of the card, readable from across the board */}
          <div aria-hidden className="absolute -inset-x-px -top-px flex h-[4px] overflow-hidden rounded-t-md">
            {labels.map((l) => (
              <span key={l!.id} className="flex-1" style={{ background: l!.color }} />
            ))}
          </div>
          <div className="mb-1.5 mt-0.5 flex flex-wrap gap-1">
            {labels.map((l) => (
              <LabelChip key={l!.id} name={l!.name} color={l!.color} />
            ))}
          </div>
        </>
      )}
      <div className="flex items-start gap-1.5">
        <span className="min-w-0 flex-1 text-sm leading-snug [overflow-wrap:anywhere]">{card.title}</span>
        {status && <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: status.color }} title={status.name} />}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted">
        <span>#{card.number}</span>
        {card.priority > 0 && <Stars value={card.priority} size={11} />}
        {card.due_at && (
          <span className={clsx('inline-flex items-center gap-0.5', isOverdue(card) && 'rounded bg-red-500/15 px-1 text-red-600 dark:text-red-400')}>
            <CalendarClock size={11} />
            {fmtDate(card.due_at)}
          </span>
        )}
        {feedPicked.has(card.id) && (
          <span className="inline-flex items-center text-accent" title={t('feed.inFeed')}>
            <CalendarCheck size={11} />
          </span>
        )}
        {card.done && (
          <span className="inline-flex items-center gap-0.5 text-done" title={t('card.doneAt', { when: card.done_at ? fmtDate(card.done_at) : '' })}>
            <CircleCheck size={11} />
          </span>
        )}
        {openBlockers > 0 && (
          <span className="inline-flex items-center gap-0.5 text-amber-600" title={t('deps.waitsForN', { count: openBlockers })}>
            <Link2 size={11} />
            {openBlockers}
          </span>
        )}
        {card.checklist_total > 0 && (
          <span className={clsx('inline-flex items-center gap-0.5', card.checklist_done === card.checklist_total && 'text-done')}>
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
            return m ? <Avatar key={id} name={label(m)} color={m.avatar_color} src={avatarUrl(m.avatar_id)} size={20} /> : null
          })}
        </span>
      </div>
    </>
  )
}

/** What a hover preview shows; built from a board card or from a cross-board calendar item. */
export interface GlimpseInfo {
  number: number
  title: string
  done?: boolean
  status?: { name: string; color: string } | null
  labels: { name: string; color: string }[]
  start_at?: string | null
  due_at?: string | null
  people: string[]
  excerpt: string
  /** extra line, e.g. "Board · Column" */
  sub?: string
}

export interface GlimpseData {
  statuses: Map<string, Status>
  members: Map<string, Member>
  labels: Map<string, Label>
}

export function glimpseOf(card: CardSummary, d: GlimpseData, sub?: string): GlimpseInfo {
  const st = card.status_id ? d.statuses.get(card.status_id) : undefined
  return {
    number: card.number,
    title: card.title,
    done: card.done,
    status: st ? { name: st.name, color: st.color } : null,
    labels: card.label_ids.map((id) => d.labels.get(id)).filter((l): l is Label => !!l),
    start_at: card.start_at,
    due_at: card.due_at,
    people: card.assignee_ids.map((id) => d.members.get(id)).filter((m): m is Member => !!m).map((m) => label(m)),
    excerpt: card.excerpt,
    sub,
  }
}

/** Hover preview ("glimpse") of a card: rendered description excerpt + key facts. */
function Preview({ g }: { g: GlimpseInfo }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-muted">#{g.number}</span>
        <span className={clsx('font-semibold leading-snug', g.done && 'text-muted line-through')}>{g.title}</span>
      </div>
      {g.sub && <div className="text-xs text-muted">{g.sub}</div>}
      {g.labels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {g.labels.map((l, i) => (
            <LabelChip key={i} name={l.name} color={l.color} />
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
        {g.status && (
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ background: g.status.color }} />
            {g.status.name}
            {g.done && ' ✓'}
          </span>
        )}
        {g.start_at && <span>· {t('card.start')}: {fmtDate(g.start_at, true)}</span>}
        {g.due_at && <span>· {t('card.due')}: {fmtDate(g.due_at, true)}</span>}
        {g.people.length > 0 && <span>· {g.people.join(', ')}</span>}
      </div>
      {g.excerpt ? (
        <div className="max-h-64 overflow-hidden border-t border-line pt-2">
          <Markdown source={g.excerpt} compact />
        </div>
      ) : (
        <p className="text-xs italic text-muted">{t('card.noDescription')}</p>
      )}
    </div>
  )
}

/**
 * Hover preview around any element (Gantt bars and rows, calendar chips). `wrap` lets a context menu sit around the
 * trigger. Hidden while `suppress` is set (e.g. during a drag) and closed as soon as the element is pressed.
 */
export function CardGlimpse({
  info,
  children,
  wrap,
  suppress,
  side = 'right',
}: {
  info: GlimpseInfo
  children: ReactElement<{ onPointerDownCapture?: () => void }>
  wrap?: (trigger: ReactElement) => ReactNode
  suppress?: boolean
  side?: 'right' | 'bottom' | 'top' | 'left'
}) {
  const [open, setOpen] = useState(false)
  const trigger = <HoverCard.Trigger asChild>{cloneElement(children, { onPointerDownCapture: () => setOpen(false) })}</HoverCard.Trigger>
  return (
    <HoverCard.Root openDelay={650} closeDelay={80} open={open && !suppress} onOpenChange={(o) => setOpen(o && !document.querySelector('[role=dialog]'))}>
      {wrap ? wrap(trigger) : trigger}
      <HoverCard.Portal>
        <HoverCard.Content side={side} align="start" sideOffset={8} collisionPadding={12} className="z-40 w-80 rounded-xl border border-line bg-surface p-3 text-sm shadow-xl">
          <Preview g={info} />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  )
}

export const CardTile = memo(function CardTile({
  card,
  b,
  onOpen,
  disabled,
  onNew,
  viewers,
}: {
  viewers?: Viewer[]
  card: CardSummary
  b: BoardHelpers
  onOpen: (id: string) => void
  disabled: boolean
  onNew?: () => void
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
      <CardContextMenu card={{ ...card, board_id: b.data!.board.id }} b={b} onOpen={() => onOpen(card.id)} onNew={onNew}>
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
          onContextMenu={() => setPreview(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onOpen(card.id)
            else listeners?.onKeyDown?.(e)
          }}
          className={clsx(
            'relative cursor-pointer select-none rounded-md border border-line bg-surface px-3 py-2 shadow-sm outline-none transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-accent',
            card.color && 'pl-3.5',
            isDragging && 'opacity-40',
          )}
        >
          <TileBody card={card} b={b} />
          {!!viewers?.length && (
            <span className="absolute -right-1.5 -top-1.5 flex -space-x-1.5">
              {viewers.slice(0, 3).map((v) => (
                <span key={v.user_id} title={`${label(v)}${v.editing ? ' · ✎' : ''}`} className={clsx('rounded-full', v.editing && 'ring-2 ring-amber-500')}>
                  <Avatar name={label(v)} color={v.avatar_color} src={avatarUrl(v.avatar_id)} size={18} />
                </span>
              ))}
            </span>
          )}
        </div>
      </HoverCard.Trigger>
      </CardContextMenu>
      {!isDragging && (
        <HoverCard.Portal>
          <HoverCard.Content
            side="right"
            align="start"
            sideOffset={8}
            collisionPadding={12}
            className="z-40 w-80 rounded-xl border border-line bg-surface p-3 text-sm shadow-xl"
          >
            <Preview g={glimpseOf(card, b)} />
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
