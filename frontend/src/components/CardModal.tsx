import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  Archive,
  CalendarCheck,
  ArrowRightLeft,
  CalendarClock,
  Check,
  Download,
  FileText,
  History,
  Image as ImageIcon,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  Tag,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react'
import { Dialog as RDialog } from 'radix-ui'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { api, fileUrl, upload } from '../lib/api'
import { useMe } from '../lib/auth'
import type { BoardHelpers, Viewer } from '../lib/board'
import { fmtDate, fmtRelative, fmtSize } from '../lib/prefs'
import { avatarUrl, label } from '../lib/user'
import type { Attachment, CardDetail, CardSummary, Label, TimelineItem } from '../lib/types'
import { CardContextMenu } from './CardMenu'
import { Stars } from './CardTile'
import { useCalendarPick } from './CalendarFeed'
import { DateTimeInput } from './DateInput'
import { ConfirmDialog } from './ConfirmDialog'
import { ask } from './dialogs'
import { FilePreview, previewKind } from './FilePreview'
import { LiveEditor, type LiveEditorHandle, type Uploader } from './editor/LiveEditor'
import { Markdown } from './Markdown'
import { toast, toastError, toastSuccess } from './toast'
import { Avatar, Button, ColorPicker, Input, Popover, Spinner } from './ui'

export function CardModal({
  cardId,
  b,
  onClose,
  viewers = [],
  onEditingChange,
}: {
  cardId: string
  b: BoardHelpers
  onClose: () => void
  /** other people who have this card open */
  viewers?: Viewer[]
  /** tells the board (and so everyone else) whether you're typing in this card */
  onEditingChange?: (editing: boolean) => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const boardId = b.data!.board.id
  const summary = b.data!.cards.find((c) => c.id === cardId)
  const q = useQuery({ queryKey: ['card', cardId], queryFn: () => api.get<CardDetail>(`/cards/${cardId}`), retry: false })
  const [uploads, setUploads] = useState<{ name: string; pct: number }[]>([])
  const [dragOver, setDragOver] = useState(false)
  const canEdit = b.canCard('cards.edit', summary)

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['card', cardId] })
    qc.invalidateQueries({ queryKey: ['timeline', cardId] })
    qc.invalidateQueries({ queryKey: ['board', boardId] })
  }
  const patch = useMutation({
    mutationFn: (p: Record<string, unknown>) => api.patch(`/cards/${cardId}`, p),
    onSuccess: refresh,
    onError: toastError,
  })

  const uploader: Uploader = (file, inline, onProgress) =>
    upload<Attachment>(`/cards/${cardId}/attachments${inline ? '?inline=true' : ''}`, file, file.name, onProgress).then((a) => {
      if (!inline) refresh()
      return a
    })

  const uploadFiles = async (files: File[]) => {
    let done = 0
    for (const f of files) {
      setUploads((u) => [...u, { name: f.name, pct: 0 }])
      try {
        await upload(`/cards/${cardId}/attachments`, f, f.name, (pct) => setUploads((u) => u.map((x) => (x.name === f.name ? { ...x, pct } : x))))
        done++
      } catch (e) {
        toastError(e)
      } finally {
        setUploads((u) => u.filter((x) => x.name !== f.name))
      }
    }
    refresh()
    // only the files that made it: a refused upload already showed its own error
    if (done) toastSuccess(t('toast.uploaded', { count: done }))
  }

  const card = q.data?.card

  // "editing" = focus is in one of the card's text fields
  const editingRef = useRef(false)
  const updateEditing = () => {
    const el = document.activeElement as HTMLElement | null
    const now = !!el?.closest('[role=dialog]') && !!el.closest('.cm-editor, textarea, input[type=text], input:not([type])')
    if (now !== editingRef.current) {
      editingRef.current = now
      onEditingChange?.(now)
    }
  }
  useEffect(() => () => onEditingChange?.(false), [onEditingChange])

  return (
    <RDialog.Root open onOpenChange={(o) => !o && onClose()}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <RDialog.Content
          aria-describedby={undefined}
          onPointerDownOutside={(e) => {
            // ignore clicks inside portaled popovers
            if ((e.target as HTMLElement).closest('[data-radix-popper-content-wrapper]')) e.preventDefault()
          }}
          onFocus={updateEditing}
          onBlur={() => setTimeout(updateEditing, 0)}
          // full screen on phones; a floating panel from small tablets up
          className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-surface outline-none sm:inset-auto sm:left-1/2 sm:top-[3dvh] sm:max-h-[94dvh] sm:w-[calc(100vw-16px)] sm:max-w-5xl sm:-translate-x-1/2 sm:rounded-xl sm:border sm:border-line sm:shadow-2xl"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files') && b.canCard('attachments.upload', summary)) {
              e.preventDefault()
              setDragOver(true)
            }
          }}
          onDragLeave={(e) => e.currentTarget === e.target && setDragOver(false)}
          onDrop={(e) => {
            setDragOver(false)
            // drops inside the markdown editor are handled (and prevented) by the editor itself
            if (e.defaultPrevented || !b.canCard('attachments.upload', summary)) return
            e.preventDefault()
            uploadFiles([...e.dataTransfer.files])
          }}
        >
          {!card ? (
            <div className="p-8">
              <RDialog.Title className="sr-only">card</RDialog.Title>
              {q.isError ? <p className="text-muted">{t('errors.not_found')}</p> : <Spinner />}
            </div>
          ) : (
            <>
              {/* the header stays in view while the panel scrolls, so close and "⋯" are always reachable */}
              <div className="sticky top-0 z-10 bg-surface">
                {card.color && <div className="h-1.5 sm:rounded-t-xl" style={{ background: card.color }} />}
                <div className="flex items-start gap-2 px-4 pb-2 pt-3 sm:gap-3 sm:px-5 sm:pt-4">
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 text-xs text-muted">
                      #{card.number} · {b.data!.lists.find((l) => l.id === card.list_id)?.name}
                    </div>
                    <Title value={card.title} disabled={!canEdit} onSave={(title) => patch.mutate({ title })} />
                  </div>
                  {viewers.length > 0 && (
                    <div className="flex shrink-0 items-center gap-1.5 self-center rounded-full bg-black/5 py-1 pl-1 pr-2.5 text-xs dark:bg-white/10">
                      <span className="flex -space-x-1.5">
                        {viewers.slice(0, 4).map((v) => (
                          <span key={v.user_id} title={label(v)} className={clsx('rounded-full', v.editing && 'ring-2 ring-amber-500')}>
                            <Avatar name={label(v)} color={v.avatar_color} src={avatarUrl(v.avatar_id)} size={22} />
                          </span>
                        ))}
                      </span>
                      <span className="text-muted">
                        {viewers.some((v) => v.editing)
                          ? `${viewers
                              .filter((v) => v.editing)
                              .map((v) => label(v))
                              .join(', ')} ${t('presence.editing')}`
                          : t('presence.here')}
                      </span>
                    </div>
                  )}
                  {summary && (
                    <CardContextMenu dropdown card={{ ...summary, board_id: boardId }} b={b} onOpen={() => {}} onGone={onClose}>
                      <button
                        className="rounded p-1.5 text-muted hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer"
                        aria-label={t('common.more')}
                        title={t('common.more')}
                      >
                        <MoreHorizontal size={18} />
                      </button>
                    </CardContextMenu>
                  )}
                  <RDialog.Close className="rounded p-1.5 text-muted hover:bg-black/5 dark:hover:bg-white/10" aria-label={t('common.close')}>
                    <X size={18} />
                  </RDialog.Close>
                </div>
              </div>

              <div className="grid gap-6 px-4 pb-6 sm:px-5 md:grid-cols-[1fr_240px]">
                <div className="min-w-0 space-y-6">
                  <Section icon={<FileText size={15} />} title={t('card.description')}>
                    <DescriptionEditor
                      mentions={b.data!.members}
                      cardId={cardId}
                      value={card.description}
                      canEdit={canEdit}
                      upload={uploader}
                      onSaved={() => {
                        qc.invalidateQueries({ queryKey: ['timeline', cardId] })
                        qc.invalidateQueries({ queryKey: ['board', boardId] })
                      }}
                    />
                  </Section>

                  <Attachments
                    items={q.data!.attachments}
                    uploads={uploads}
                    canUpload={b.canCard('attachments.upload', summary)}
                    canDeleteAny={b.canCard('attachments.delete', summary)}
                    b={b}
                    onUpload={uploadFiles}
                    onChanged={refresh}
                    dragOver={dragOver}
                  />

                  <Activity cardId={cardId} b={b} uploader={uploader} />
                </div>

                <Sidebar cardId={cardId} detail={q.data!} b={b} patch={(p) => patch.mutate(p)} onArchived={onClose} />
              </div>
            </>
          )}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}

function Section({ icon, title, action, children }: { icon: ReactNode; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-muted">{icon}</span>
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="ml-auto">{action}</div>
      </div>
      {children}
    </section>
  )
}

function Title({ value, onSave, disabled }: { value: string; onSave: (v: string) => void; disabled: boolean }) {
  const [editing, setEditing] = useState(false)
  if (!editing || disabled)
    return (
      <RDialog.Title
        onClick={() => !disabled && setEditing(true)}
        className={clsx('text-xl font-semibold leading-snug [overflow-wrap:anywhere]', !disabled && 'cursor-text')}
      >
        {value}
      </RDialog.Title>
    )
  return (
    <>
      <RDialog.Title className="sr-only">{value}</RDialog.Title>
      <textarea
        defaultValue={value}
        autoFocus
        rows={2}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => {
          const v = e.currentTarget.value.trim()
          if (v && v !== value) onSave(v)
          setEditing(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            e.currentTarget.blur()
          }
          if (e.key === 'Escape') {
            e.stopPropagation()
            setEditing(false)
          }
        }}
        className="w-full resize-none rounded-md border border-line bg-surface px-2 py-1 text-xl font-semibold outline-none focus:ring-2 focus:ring-accent/60"
      />
    </>
  )
}

function Attachments({
  items,
  uploads,
  canUpload,
  canDeleteAny,
  b,
  onUpload,
  onChanged,
  dragOver,
}: {
  items: Attachment[]
  uploads: { name: string; pct: number }[]
  canUpload: boolean
  canDeleteAny: boolean
  b: BoardHelpers
  onUpload: (f: File[]) => void
  onChanged: () => void
  dragOver: boolean
}) {
  const { t } = useTranslation()
  const { data: me } = useMe()
  const input = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<number | null>(null)
  const del = useMutation({ mutationFn: (id: string) => api.del(`/attachments/${id}`), onSuccess: onChanged, onError: toastError })
  if (!canUpload && items.length === 0) return null
  return (
    <Section
      icon={<Paperclip size={15} />}
      title={`${t('card.attachments')}${items.length ? ` (${items.length})` : ''}`}
      action={
        canUpload && (
          <>
            <input ref={input} type="file" multiple hidden onChange={(e) => (onUpload([...(e.target.files ?? [])]), (e.target.value = ''))} />
            <Button variant="ghost" size="sm" onClick={() => input.current?.click()}>
              <Upload size={13} /> {t('card.upload')}
            </Button>
          </>
        )
      }
    >
      <div className={clsx('space-y-1.5 rounded-lg', dragOver && 'outline-2 outline-dashed outline-accent p-2')}>
        {dragOver && <p className="text-center text-sm text-accent">{t('card.dropHere')}</p>}
        {items.map((a, idx) => {
          const canPreview = previewKind(a) !== 'none'
          const isImage = a.content_type.startsWith('image/') && a.content_type !== 'image/svg+xml'
          const m = a.uploaded_by ? b.members.get(a.uploaded_by) : undefined
          const uploader = a.uploaded_by_name ?? (m ? label(m) : undefined)
          return (
            <div key={a.id} className="group flex items-center gap-3 rounded-lg border border-line p-2">
              <button type="button" onClick={() => setPreview(idx)} className="shrink-0 cursor-pointer" title={t('preview.open')}>
                {isImage ? (
                  <img src={fileUrl(a.id)} alt="" loading="lazy" className="h-10 w-14 rounded object-cover" />
                ) : (
                  <span className="flex h-10 w-14 items-center justify-center rounded bg-black/5 text-[10px] font-semibold uppercase text-muted dark:bg-white/10">
                    {a.filename.split('.').pop()?.slice(0, 4) ?? <FileText size={16} />}
                  </span>
                )}
              </button>
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => setPreview(idx)}
                  className="block max-w-full cursor-pointer truncate text-left text-sm font-medium hover:underline"
                >
                  {a.filename}
                </button>
                <div className="text-xs text-muted">
                  {!canPreview && `${t('preview.downloadOnly')} · `}
                  {fmtSize(a.size)} · {fmtRelative(a.created_at)}
                  {uploader && ` · ${uploader}`}
                </div>
              </div>
              <a href={`${fileUrl(a.id)}?download=1`} className="rounded p-1 text-muted hover:bg-black/5 dark:hover:bg-white/10" title="download">
                <Download size={15} />
              </a>
              {(canDeleteAny || a.uploaded_by === me?.id) && (
                <button
                  onClick={async () =>
                    (await ask({
                      title: t('common.delete'),
                      message: t('card.deleteAttachmentMsg', { name: a.filename }),
                      confirmLabel: t('common.delete'),
                      danger: true,
                    })) && del.mutate(a.id)
                  }
                  className="rounded p-1 text-muted opacity-0 hover:bg-red-500/10 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100 touch:opacity-100 cursor-pointer"
                >
                  <Trash2 size={15} />
                </button>
              )}
            </div>
          )
        })}
        {preview !== null && items[preview] && <FilePreview items={items} index={preview} onIndex={setPreview} onClose={() => setPreview(null)} />}
        {uploads.map((u) => (
          <div key={u.name} className="rounded-lg border border-line p-2 text-sm text-muted">
            {t('card.uploading', { name: u.name, pct: u.pct })}
            <div className="mt-1 h-1 overflow-hidden rounded bg-black/5 dark:bg-white/10">
              <div className="h-full bg-accent transition-all" style={{ width: `${u.pct}%` }} />
            </div>
          </div>
        ))}
      </div>
    </Section>
  )
}

function Activity({ cardId, b, uploader }: { cardId: string; b: BoardHelpers; uploader: Uploader }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: me } = useMe()
  const q = useQuery({ queryKey: ['timeline', cardId], queryFn: () => api.get<TimelineItem[]>(`/cards/${cardId}/timeline`) })
  const [showEvents, setShowEvents] = useState(true)
  const [editing, setEditing] = useState<string | null>(null)
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['timeline', cardId] })
    qc.invalidateQueries({ queryKey: ['board', b.data!.board.id] })
  }
  const add = useMutation({ mutationFn: (body: string) => api.post(`/cards/${cardId}/comments`, { body }), onSuccess: refresh, onError: toastError })
  const edit = useMutation({
    mutationFn: (p: { id: string; body: string }) => api.patch(`/comments/${p.id}`, { body: p.body }),
    onSuccess: () => (setEditing(null), refresh()),
    onError: toastError,
  })
  const del = useMutation({ mutationFn: (id: string) => api.del(`/comments/${id}`), onSuccess: refresh, onError: toastError })
  const composer = useRef<LiveEditorHandle>(null)
  const [draft, setDraft] = useState('')
  const post = () => {
    const body = composer.current?.getValue() ?? ''
    if (!body.trim() || add.isPending) return
    add.mutate(body, {
      onSuccess: () => {
        composer.current?.setValue('')
        setDraft('')
      },
    })
  }
  // the server sends names (incl. "[Deleted User] Name (username)" for removed accounts); members are a fallback
  const memberLabel = (id: string | null) => {
    const m = id ? b.members.get(id) : undefined
    return m ? label(m) : undefined
  }
  const name = (id: string | null, server?: string | null) => server || memberLabel(id) || '—'
  const pic = (id: string | null, server?: string | null) => avatarUrl(server ?? (id ? b.members.get(id)?.avatar_id : null))
  const color = (id: string | null, server?: string | null) => server || (id && b.members.get(id)?.avatar_color) || '#a1a1aa'
  const items = (q.data ?? []).filter((i) => showEvents || i.type === 'comment')

  return (
    <Section
      icon={<History size={15} />}
      title={t('card.activity')}
      action={
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={showEvents} onChange={(e) => setShowEvents(e.target.checked)} className="accent-[var(--color-accent)]" />
          {t('card.activity')}
        </label>
      }
    >
      {b.can('comments.create') && me && (
        <div className="mb-4 flex gap-3">
          <Avatar name={label(me)} color={me.avatar_color} src={avatarUrl(me.avatar_id)} size={30} />
          <div className="min-w-0 flex-1 space-y-2">
            <LiveEditor
              mentions={b.data!.members}
              ref={composer}
              value=""
              upload={uploader}
              placeholder={t('card.commentPlaceholder')}
              onChange={(v) => setDraft(v)}
              onSubmit={post}
              minHeight={44}
            />
            {draft.trim() && (
              <div className="flex items-center gap-2">
                <Button variant="primary" size="sm" onClick={post} disabled={add.isPending}>
                  {t('card.post')}
                </Button>
                <span className="text-xs text-muted">Ctrl+Enter</span>
              </div>
            )}
          </div>
        </div>
      )}
      <ol className="space-y-3">
        {items.map((i) =>
          i.type === 'comment' ? (
            <li key={`c${i.id}`} className="flex gap-3">
              <Avatar name={name(i.author_id, i.author_name)} color={color(i.author_id, i.author_color)} src={pic(i.author_id, i.author_avatar)} size={30} />
              <div className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2">
                <div className="mb-1 flex items-center gap-2 text-xs">
                  <span className="font-semibold">{name(i.author_id, i.author_name)}</span>
                  <span className="text-muted" title={fmtDate(i.created_at, true)}>
                    {fmtRelative(i.created_at)}
                    {i.edited && ` · ${t('card.edited')}`}
                  </span>
                  <span className="ml-auto flex gap-1">
                    {i.author_id === me?.id && (
                      <button onClick={() => setEditing(i.id)} className="text-muted hover:text-[var(--text)] cursor-pointer">
                        <Pencil size={13} />
                      </button>
                    )}
                    {(i.author_id === me?.id || b.can('comments.moderate')) && (
                      <button
                        onClick={async () =>
                          (await ask({ title: t('common.delete'), message: t('card.deleteCommentMsg'), confirmLabel: t('common.delete'), danger: true })) &&
                          del.mutate(i.id)
                        }
                        className="text-muted hover:text-red-600 cursor-pointer"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </span>
                </div>
                {editing === i.id ? (
                  <CommentEdit
                    mentions={b.data!.members}
                    body={i.body}
                    upload={uploader}
                    onCancel={() => setEditing(null)}
                    onSave={(body) => edit.mutate({ id: i.id, body })}
                  />
                ) : (
                  <Markdown source={i.body} />
                )}
              </div>
            </li>
          ) : (
            <li key={`e${i.id}`} className="flex items-center gap-3 pl-1.5 text-xs text-muted">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-black/5 dark:bg-white/10">
                <EventIcon kind={i.kind} />
              </span>
              <span className="min-w-0">
                <span className="font-medium text-[var(--text)]">{name(i.actor_id, i.actor_name)}</span> <EventText kind={i.kind} data={i.data} />
                <span className="ml-1.5" title={fmtDate(i.created_at, true)}>
                  · {fmtRelative(i.created_at)}
                </span>
              </span>
            </li>
          ),
        )}
      </ol>
    </Section>
  )
}

function EventIcon({ kind }: { kind: string }) {
  const s = 11
  if (kind === 'moved') return <ArrowRightLeft size={s} />
  if (kind.startsWith('attachment')) return <Paperclip size={s} />
  if (kind === 'labels') return <Tag size={s} />
  if (kind === 'assignees') return <Users size={s} />
  if (kind === 'due') return <CalendarClock size={s} />
  if (kind === 'archived') return <Archive size={s} />
  if (kind === 'created') return <Plus size={s} />
  return <Pencil size={s} />
}

function EventText({ kind, data }: { kind: string; data: Record<string, unknown> }) {
  const { t } = useTranslation()
  const d = data as Record<string, string & string[]>
  switch (kind) {
    case 'status':
      return <>{t('event.status', { from: d.from ?? t('event.noStatus'), to: d.to ?? t('event.noStatus') })}</>
    case 'priority':
      return <>{t('event.priority', { from: '★'.repeat(Number(d.from)) || '0', to: '★'.repeat(Number(d.to)) || '0' })}</>
    case 'due':
      return <>{d.to ? t('event.due', { to: fmtDate(d.to, true) }) : t('event.dueCleared')}</>
    case 'start':
      return <>{d.to ? t('event.start', { to: fmtDate(d.to, true) }) : t('event.startCleared')}</>
    case 'labels':
    case 'dependencies':
    case 'assignees': {
      const parts = [
        d.added?.length ? t('event.added', { items: d.added.join(', ') }) : '',
        d.removed?.length ? t('event.removed', { items: d.removed.join(', ') }) : '',
      ].filter(Boolean)
      return <>{`${t(`event.${kind}`)}: ${parts.join('; ')}`}</>
    }
    default:
      return <>{t(`event.${kind}`, { ...d, defaultValue: kind })}</>
  }
}

function Sidebar({
  cardId,
  detail,
  b,
  patch,
  onArchived,
}: {
  cardId: string
  detail: CardDetail
  b: BoardHelpers
  patch: (p: Record<string, unknown>) => void
  onArchived: () => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const card = detail.card
  const data = b.data!
  const canEdit = b.canCard('cards.edit', card)
  const canStatus = b.canCard('cards.status', card)
  const canAssign = b.canCard('cards.assign', card)
  const canLabels = b.canCard('cards.labels', card)
  const canDue = b.canCard('cards.due', card)
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['card', cardId] })
    qc.invalidateQueries({ queryKey: ['timeline', cardId] })
    qc.invalidateQueries({ queryKey: ['board', data.board.id] })
  }
  const move = useMutation({
    mutationFn: (list_id: string) => api.post(`/cards/${cardId}/move`, { list_id, index: 1e9 }),
    onSuccess: refresh,
    onError: toastError,
  })
  const setIds = useMutation({
    mutationFn: (p: { kind: 'labels' | 'assignees'; ids: string[] }) => api.put(`/cards/${cardId}/${p.kind}`, { ids: p.ids }),
    onSuccess: refresh,
    onError: toastError,
  })
  const archive = useMutation({
    mutationFn: () => api.del(`/cards/${cardId}`),
    onSuccess: () => {
      refresh()
      toastSuccess(t('toast.archived', { title: card.title }))
      onArchived()
    },
    onError: toastError,
  })
  const toggle = (arr: string[], id: string) => (arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id])
  const [purging, setPurging] = useState(false)

  return (
    <aside className="space-y-4 text-sm">
      <Prop label={t('card.column')}>
        <select
          value={card.list_id}
          disabled={!b.canCard('cards.move', card)}
          onChange={(e) => move.mutate(e.target.value)}
          className="h-8 w-full rounded-md border border-line bg-surface px-2 text-sm"
        >
          {data.lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </Prop>

      <Prop label={t('card.status')}>
        <div className="flex flex-wrap gap-1">
          {data.statuses.map((s) => (
            <button
              key={s.id}
              disabled={!canStatus}
              onClick={() => patch({ status_id: card.status_id === s.id ? null : s.id })}
              className={clsx(
                'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs enabled:cursor-pointer',
                card.status_id === s.id ? 'font-semibold' : 'border-line text-muted enabled:hover:bg-black/5 dark:enabled:hover:bg-white/5',
              )}
              style={card.status_id === s.id ? { borderColor: s.color, background: `${s.color}22` } : undefined}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
              {s.name}
              {s.is_done && <Check size={12} className="text-done" />}
            </button>
          ))}
        </div>
        {card.done_at && data.statuses.find((s) => s.id === card.status_id)?.is_done && (
          <p className="mt-1 text-xs text-done">{t('card.doneAt', { when: fmtDate(card.done_at, true) })}</p>
        )}
      </Prop>

      <Prop label={t('card.priority')}>
        <Stars value={card.priority} size={18} onChange={canEdit ? (priority) => patch({ priority }) : undefined} />
      </Prop>

      <Prop label={t('card.assignees')}>
        <div className="flex flex-wrap items-center gap-1">
          {card.assignee_ids.map((id) => {
            const m = b.members.get(id)
            return m ? (
              <span key={id} className="flex items-center gap-1 rounded-full bg-black/5 py-0.5 pl-0.5 pr-2 text-xs dark:bg-white/10">
                <Avatar name={label(m)} color={m.avatar_color} src={avatarUrl(m.avatar_id)} size={20} />
                {label(m)}
              </span>
            ) : null
          })}
          {canAssign && (
            <Popover
              trigger={
                <button className="rounded-full p-1 text-muted hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer">
                  <Plus size={15} />
                </button>
              }
            >
              <div className="max-h-64 space-y-0.5 overflow-y-auto">
                {data.members.map((m) => (
                  <button
                    key={m.user_id}
                    onClick={() => setIds.mutate({ kind: 'assignees', ids: toggle(card.assignee_ids, m.user_id) })}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer"
                  >
                    <Avatar name={label(m)} color={m.avatar_color} src={avatarUrl(m.avatar_id)} size={22} />
                    <span className="flex-1 truncate">{label(m)}</span>
                    {card.assignee_ids.includes(m.user_id) && <Check size={14} />}
                  </button>
                ))}
              </div>
            </Popover>
          )}
        </div>
      </Prop>

      <Prop label={t('card.labels')}>
        <div className="flex flex-wrap items-center gap-1">
          {card.label_ids.map((id) => {
            const l = b.labels.get(id)
            return l ? (
              <span key={id} className="rounded px-2 py-0.5 text-xs font-medium text-white" style={{ background: l.color }}>
                {l.name}
              </span>
            ) : null
          })}
          {canLabels && (
            <Popover
              trigger={
                <button className="rounded-full p-1 text-muted hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer">
                  <Plus size={15} />
                </button>
              }
            >
              <LabelPicker
                labels={data.labels}
                selected={card.label_ids}
                canCreate={b.can('labels.manage')}
                boardId={data.board.id}
                onToggle={(id) => setIds.mutate({ kind: 'labels', ids: toggle(card.label_ids, id) })}
              />
            </Popover>
          )}
        </div>
      </Prop>

      <Prop label={t('card.start')}>
        <div className="flex gap-1">
          <div className="min-w-0 flex-1">
            <DateTimeInput value={card.start_at} disabled={!canDue} onChange={(iso) => patch({ start_at: iso })} />
          </div>
          {card.start_at && canDue && (
            <Button variant="ghost" size="sm" onClick={() => patch({ start_at: null })} title={t('common.clear')}>
              <X size={14} />
            </Button>
          )}
        </div>
      </Prop>

      <Prop label={t('card.due')}>
        <div className="flex gap-1">
          <div className="min-w-0 flex-1">
            <DateTimeInput value={card.due_at} disabled={!canDue} onChange={(iso) => patch({ due_at: iso })} />
          </div>
          {card.due_at && canDue && (
            <Button variant="ghost" size="sm" onClick={() => patch({ due_at: null })} title={t('common.clear')}>
              <X size={14} />
            </Button>
          )}
        </div>
      </Prop>

      <CalendarPickButton cardId={cardId} />

      <Dependencies cardId={cardId} b={b} />

      <Prop label={t('card.color')}>
        <ColorPicker value={card.color} allowNone onChange={(color) => canEdit && patch({ color })} />
      </Prop>

      <div className="space-y-0.5 border-t border-line pt-3 text-xs text-muted">
        <div>
          {t('card.created')}: {fmtDate(card.created_at, true)}
          {(card.created_by_name || (card.created_by && b.members.get(card.created_by))) &&
            ` · ${card.created_by_name || label(b.members.get(card.created_by!)!)}`}
        </div>
        <div>
          {t('card.updated')}: {fmtRelative(card.updated_at)}
        </div>
      </div>

      {(b.canCard('cards.archive', card) || b.canCard('cards.delete', card)) && (
        <div className="space-y-1.5">
          {b.canCard('cards.archive', card) && (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={async () =>
                (await ask({ title: t('card.archive'), message: t('card.archiveConfirm'), confirmLabel: t('card.archive') })) && archive.mutate()
              }
            >
              <Archive size={14} /> {t('card.archive')}
            </Button>
          )}
          {b.canCard('cards.delete', card) && (
            <Button variant="outline" size="sm" className="w-full text-red-600" onClick={() => setPurging(true)}>
              <Trash2 size={14} /> {t('archive.deleteForever')}
            </Button>
          )}
        </div>
      )}
      {purging && (
        <ConfirmDialog
          title={t('archive.deleteForever')}
          message={t('archive.purgeCardMsg', { title: `#${card.number} ${card.title}` })}
          confirmLabel={t('archive.deleteForever')}
          onConfirm={() =>
            api.del(`/cards/${cardId}/permanent`).then(() => {
              qc.invalidateQueries({ queryKey: ['board', data.board.id] })
              toastSuccess(t('toast.deleted'))
              onArchived()
            }, toastError)
          }
          onClose={() => setPurging(false)}
        />
      )}
      {detail.attachments.length === 0 && !b.canCard('attachments.upload', card) ? null : (
        <p className="flex items-center gap-1 text-[11px] text-muted">
          <ImageIcon size={12} /> {t('card.markdownHint')}
        </p>
      )}
    </aside>
  )
}

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted">{label}</div>
      {children}
    </div>
  )
}

function LabelPicker({
  labels,
  selected,
  canCreate,
  boardId,
  onToggle,
}: {
  labels: Label[]
  selected: string[]
  canCreate: boolean
  boardId: string
  onToggle: (id: string) => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [color, setColor] = useState<string | null>('#2f5bd3')
  const create = useMutation({
    mutationFn: () => api.post<Label>(`/boards/${boardId}/labels`, { name, color }),
    onSuccess: (l) => {
      setName('')
      qc.invalidateQueries({ queryKey: ['board', boardId] })
      onToggle(l.id)
    },
    onError: toastError,
  })
  return (
    <div className="space-y-2">
      <div className="max-h-56 space-y-0.5 overflow-y-auto">
        {labels.map((l) => (
          <button
            key={l.id}
            onClick={() => onToggle(l.id)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer"
          >
            <span className="h-3.5 w-3.5 rounded" style={{ background: l.color }} />
            <span className="flex-1 truncate">{l.name}</span>
            {selected.includes(l.id) && <Check size={14} />}
          </button>
        ))}
      </div>
      {canCreate && (
        <form
          className="space-y-2 border-t border-line pt-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) create.mutate()
            else toast(t('errors.name_required'), 'error')
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('settings.newLabel')} className="h-8" />
          <ColorPicker value={color} onChange={setColor} />
          <Button variant="primary" size="sm" className="w-full">
            <Plus size={14} /> {t('common.create')}
          </Button>
        </form>
      )}
    </div>
  )
}

/** Description: always-on live-preview editor with debounced autosave (the server folds consecutive edits into one log entry). */
function DescriptionEditor({
  mentions,
  cardId,
  value,
  canEdit,
  upload,
  onSaved,
}: {
  mentions: { username: string; display_name: string }[]
  cardId: string
  value: string
  canEdit: boolean
  upload: Uploader
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const [state, setState] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle')
  const latest = useRef(value)
  const saved = useRef(value)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const inflight = useRef<Promise<unknown> | null>(null)
  const onSavedRef = useRef(onSaved)
  onSavedRef.current = onSaved

  const save = useCallback(async (): Promise<void> => {
    clearTimeout(timer.current)
    if (inflight.current) await inflight.current.catch(() => {})
    const v = latest.current
    if (v === saved.current) {
      setState((s) => (s === 'dirty' || s === 'error' ? 'saved' : s))
      return
    }
    setState('saving')
    const p = api.patch(`/cards/${cardId}`, { description: v })
    inflight.current = p
    try {
      await p
      saved.current = v
      setState(latest.current === v ? 'saved' : 'dirty')
      onSavedRef.current()
    } catch (e) {
      setState('error')
      // retry network/server hiccups; a 4xx (no permission, card archived) won't fix itself
      const status = (e as { status?: number }).status ?? 0
      if (status === 0 || status >= 500) timer.current = setTimeout(save, 5000)
      else toastError(e)
    } finally {
      inflight.current = null
    }
  }, [cardId])

  // someone else changed it while we have no unsaved edits -> follow the server
  useEffect(() => {
    if (latest.current === saved.current) {
      latest.current = value
      saved.current = value
    }
  }, [value])

  // flush on close / navigation; warn before leaving the page with unsaved text
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (latest.current !== saved.current) e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => {
      window.removeEventListener('beforeunload', warn)
      clearTimeout(timer.current)
      if (latest.current !== saved.current) {
        api.patch(`/cards/${cardId}`, { description: latest.current }).then(() => onSavedRef.current(), toastError)
      }
    }
  }, [cardId])

  if (!canEdit && !value.trim()) return <p className="text-sm italic text-muted">{t('card.noDescription').split('.')[0]}</p>

  const indicator =
    state === 'saving'
      ? t('editor.saving')
      : state === 'saved'
        ? `✓ ${t('editor.saved')}`
        : state === 'dirty'
          ? t('editor.unsaved')
          : state === 'error'
            ? t('editor.saveFailed')
            : ''

  return (
    <LiveEditor
      mentions={mentions}
      value={value}
      readOnly={!canEdit}
      upload={upload}
      toolbar
      toolbarExtra={<span className={state === 'error' ? 'text-red-600' : undefined}>{indicator}</span>}
      placeholder={t('editor.placeholder')}
      minHeight={120}
      onChange={(v) => {
        latest.current = v
        setState('dirty')
        clearTimeout(timer.current)
        timer.current = setTimeout(save, 1200)
      }}
      onBlur={() => void save()}
      onSubmit={() => void save()}
    />
  )
}

function CommentEdit({
  body,
  upload,
  onSave,
  onCancel,
  mentions,
}: {
  body: string
  upload: Uploader
  onSave: (b: string) => void
  onCancel: () => void
  mentions: { username: string; display_name: string }[]
}) {
  const { t } = useTranslation()
  const ref = useRef<LiveEditorHandle>(null)
  const save = () => {
    const v = ref.current?.getValue() ?? ''
    if (v.trim()) onSave(v)
  }
  return (
    <div className="space-y-2">
      <LiveEditor ref={ref} mentions={mentions} value={body} upload={upload} autoFocus onSubmit={save} onEscape={() => (onCancel(), true)} minHeight={44} />
      <div className="flex gap-2">
        <Button variant="primary" size="sm" onClick={save}>
          {t('common.save')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  )
}

/** "Waits for" (this card can't start until those finish) and "Blocking" (cards waiting for this one). */
function Dependencies({ cardId, b }: { cardId: string; b: BoardHelpers }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [, setSp] = useSearchParams()
  const [q, setQ] = useState('')
  const data = b.data!
  const byId = new Map(data.cards.map((c) => [c.id, c]))
  const me = byId.get(cardId)
  const waits = (me?.depends_on ?? []).map((id) => byId.get(id)).filter((c): c is CardSummary => !!c)
  const blocking = data.cards.filter((c) => c.depends_on.includes(cardId))
  const can = b.canCard('cards.dependencies', me)
  if (!me || (!can && waits.length === 0 && blocking.length === 0)) return null
  // everything that (directly or indirectly) waits for this card: picking one of those would make a loop
  const downstream = new Set<string>([cardId])
  for (let grew = true; grew;) {
    grew = false
    for (const c of data.cards) if (!downstream.has(c.id) && c.depends_on.some((d) => downstream.has(d))) (downstream.add(c.id), (grew = true))
  }
  const candidates = data.cards
    .filter((c) => !downstream.has(c.id) && !me.depends_on.includes(c.id))
    .filter((c) => !q.trim() || `#${c.number} ${c.title}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((x, y) => x.number - y.number)
    .slice(0, 50)
  const put = (target: string, ids: string[]) =>
    api.put(`/cards/${target}/dependencies`, { ids }).then(() => {
      qc.invalidateQueries({ queryKey: ['board', data.board.id] })
      qc.invalidateQueries({ queryKey: ['timeline', target] })
    }, toastError)
  const open = (id: string) => setSp((sp) => (sp.set('card', id), sp))
  const chip = (c: CardSummary, onRemove?: () => void) => (
    <span key={c.id} className="flex max-w-full items-center gap-1 rounded-md border border-line py-0.5 pl-1.5 pr-0.5 text-xs">
      <button onClick={() => open(c.id)} className="min-w-0 truncate hover:underline cursor-pointer" title={`#${c.number} ${c.title}`}>
        {c.done && <span className="text-done">✓ </span>}
        <span className="text-muted">#{c.number}</span> <span className={c.done ? 'text-muted line-through' : ''}>{c.title}</span>
      </button>
      {onRemove && (
        <button onClick={onRemove} title={t('common.remove')} className="shrink-0 rounded p-0.5 text-muted hover:text-red-600 cursor-pointer">
          <X size={12} />
        </button>
      )}
    </span>
  )
  return (
    <>
      <Prop label={t('deps.waitsFor')}>
        <div className="flex flex-wrap items-center gap-1">
          {waits.map((c) =>
            chip(
              c,
              can
                ? () =>
                    put(
                      cardId,
                      me.depends_on.filter((x) => x !== c.id),
                    )
                : undefined,
            ),
          )}
          {waits.length === 0 && <span className="text-xs text-muted">{t('deps.none')}</span>}
          {can && (
            <Popover
              trigger={
                <button className="rounded-md border border-dashed border-line px-1.5 py-0.5 text-xs text-muted hover:text-[var(--text)] cursor-pointer">
                  <Plus size={12} className="inline" /> {t('deps.add')}
                </button>
              }
            >
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('deps.search')} className="mb-1 h-8 text-xs" autoFocus />
              <div className="max-h-60 overflow-y-auto">
                {candidates.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => (put(cardId, [...me.depends_on, c.id]), setQ(''))}
                    className="block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer"
                  >
                    <span className="text-muted">#{c.number}</span> {c.title}
                  </button>
                ))}
                {candidates.length === 0 && <p className="p-2 text-xs text-muted">{t('search.noResults')}</p>}
              </div>
              <p className="mt-1 border-t border-line pt-1 text-[10px] text-muted">{t('deps.loopHint')}</p>
            </Popover>
          )}
        </div>
      </Prop>
      {blocking.length > 0 && (
        <Prop label={t('deps.blocking')}>
          <div className="flex flex-wrap gap-1">
            {blocking.map((c) =>
              chip(
                c,
                can
                  ? () =>
                      put(
                        c.id,
                        c.depends_on.filter((x) => x !== cardId),
                      )
                  : undefined,
              ),
            )}
          </div>
        </Prop>
      )}
    </>
  )
}

function CalendarPickButton({ cardId }: { cardId: string }) {
  const { t } = useTranslation()
  const { picked, toggle } = useCalendarPick()
  const on = picked.has(cardId)
  return (
    <button
      onClick={() => toggle(cardId)}
      className={clsx(
        'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs cursor-pointer',
        on ? 'border-accent bg-accent/10 font-medium' : 'border-line text-muted hover:bg-black/5 dark:hover:bg-white/5',
      )}
    >
      <CalendarCheck size={13} /> {on ? t('feed.inFeed') : t('feed.addCard')}
    </button>
  )
}
