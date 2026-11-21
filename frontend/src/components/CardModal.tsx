import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  Archive,
  ArrowRightLeft,
  CalendarClock,
  Check,
  Download,
  FileText,
  History,
  Image as ImageIcon,
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
import { api, fileUrl, upload } from '../lib/api'
import { useMe } from '../lib/auth'
import type { BoardHelpers } from '../lib/board'
import { fmtDate, fmtRelative, fmtSize } from '../lib/prefs'
import type { Attachment, CardDetail, Label, TimelineItem } from '../lib/types'
import { Stars } from './CardTile'
import { LiveEditor, type LiveEditorHandle, type Uploader } from './editor/LiveEditor'
import { Markdown } from './Markdown'
import { toast, toastError } from './toast'
import { Avatar, Button, ColorPicker, Input, Popover, Spinner } from './ui'

export function CardModal({ cardId, b, onClose }: { cardId: string; b: BoardHelpers; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const boardId = b.data!.board.id
  const q = useQuery({ queryKey: ['card', cardId], queryFn: () => api.get<CardDetail>(`/cards/${cardId}`), retry: false })
  const [uploads, setUploads] = useState<{ name: string; pct: number }[]>([])
  const [dragOver, setDragOver] = useState(false)
  const canEdit = b.can('cards.edit')

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
    for (const f of files) {
      setUploads((u) => [...u, { name: f.name, pct: 0 }])
      try {
        await upload(`/cards/${cardId}/attachments`, f, f.name, (pct) =>
          setUploads((u) => u.map((x) => (x.name === f.name ? { ...x, pct } : x))),
        )
      } catch (e) {
        toastError(e)
      } finally {
        setUploads((u) => u.filter((x) => x.name !== f.name))
      }
    }
    refresh()
  }

  const card = q.data?.card

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
          className="fixed left-1/2 top-[3vh] z-50 max-h-[94vh] w-[calc(100vw-16px)] max-w-5xl -translate-x-1/2 overflow-y-auto rounded-xl border border-line bg-surface shadow-2xl outline-none"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files') && b.can('attachments.upload')) {
              e.preventDefault()
              setDragOver(true)
            }
          }}
          onDragLeave={(e) => e.currentTarget === e.target && setDragOver(false)}
          onDrop={(e) => {
            setDragOver(false)
            // drops inside the markdown editor are handled (and prevented) by the editor itself
            if (e.defaultPrevented || !b.can('attachments.upload')) return
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
              {card.color && <div className="h-1.5 rounded-t-xl" style={{ background: card.color }} />}
              <div className="flex items-start gap-3 px-5 pb-2 pt-4">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 text-xs text-muted">
                    #{card.number} · {b.data!.lists.find((l) => l.id === card.list_id)?.name}
                  </div>
                  <Title value={card.title} disabled={!canEdit} onSave={(title) => patch.mutate({ title })} />
                </div>
                <RDialog.Close className="rounded p-1.5 text-muted hover:bg-black/5 dark:hover:bg-white/10" aria-label={t('common.close')}>
                  <X size={18} />
                </RDialog.Close>
              </div>

              <div className="grid gap-6 px-5 pb-6 md:grid-cols-[1fr_240px]">
                <div className="min-w-0 space-y-6">
                  <Section icon={<FileText size={15} />} title={t('card.description')}>
                    <DescriptionEditor
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
                    canUpload={b.can('attachments.upload')}
                    canDeleteAny={b.can('attachments.delete')}
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
        {items.map((a) => {
          const isImage = a.content_type.startsWith('image/') && a.content_type !== 'image/svg+xml'
          const uploader = a.uploaded_by ? b.members.get(a.uploaded_by)?.display_name : undefined
          return (
            <div key={a.id} className="group flex items-center gap-3 rounded-lg border border-line p-2">
              <a href={fileUrl(a.id)} target="_blank" rel="noopener" className="shrink-0">
                {isImage ? (
                  <img src={fileUrl(a.id)} alt="" loading="lazy" className="h-10 w-14 rounded object-cover" />
                ) : (
                  <span className="flex h-10 w-14 items-center justify-center rounded bg-black/5 text-[10px] font-semibold uppercase text-muted dark:bg-white/10">
                    {a.filename.split('.').pop()?.slice(0, 4) ?? <FileText size={16} />}
                  </span>
                )}
              </a>
              <div className="min-w-0 flex-1">
                <a href={`${fileUrl(a.id)}?download=1`} className="block truncate text-sm font-medium hover:underline">
                  {a.filename}
                </a>
                <div className="text-xs text-muted">
                  {fmtSize(a.size)} · {fmtRelative(a.created_at)}
                  {uploader && ` · ${uploader}`}
                </div>
              </div>
              <a href={`${fileUrl(a.id)}?download=1`} className="rounded p-1 text-muted hover:bg-black/5 dark:hover:bg-white/10" title="download">
                <Download size={15} />
              </a>
              {(canDeleteAny || a.uploaded_by === me?.id) && (
                <button
                  onClick={() => confirm(t('common.confirmDelete')) && del.mutate(a.id)}
                  className="rounded p-1 text-muted opacity-0 hover:bg-red-500/10 hover:text-red-600 group-hover:opacity-100 cursor-pointer"
                >
                  <Trash2 size={15} />
                </button>
              )}
            </div>
          )
        })}
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
  const name = (id: string | null) => (id && b.members.get(id)?.display_name) || '—'
  const color = (id: string | null) => (id && b.members.get(id)?.avatar_color) || '#a1a1aa'
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
          <Avatar name={me.display_name} color={me.avatar_color} size={30} />
          <div className="min-w-0 flex-1 space-y-2">
            <LiveEditor
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
              <Avatar name={name(i.author_id)} color={color(i.author_id)} size={30} />
              <div className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2">
                <div className="mb-1 flex items-center gap-2 text-xs">
                  <span className="font-semibold">{name(i.author_id)}</span>
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
                      <button onClick={() => confirm(t('common.confirmDelete')) && del.mutate(i.id)} className="text-muted hover:text-red-600 cursor-pointer">
                        <Trash2 size={13} />
                      </button>
                    )}
                  </span>
                </div>
                {editing === i.id ? (
                  <CommentEdit body={i.body} upload={uploader} onCancel={() => setEditing(null)} onSave={(body) => edit.mutate({ id: i.id, body })} />
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
                <span className="font-medium text-[var(--text)]">{name(i.actor_id)}</span> <EventText kind={i.kind} data={i.data} />
                <span className="ml-1.5" title={fmtDate(i.created_at, true)}>· {fmtRelative(i.created_at)}</span>
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
    case 'labels':
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
  const canEdit = b.can('cards.edit')
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
      onArchived()
    },
    onError: toastError,
  })
  const toggle = (arr: string[], id: string) => (arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id])
  const dueLocal = card.due_at ? toLocalInput(card.due_at) : ''

  return (
    <aside className="space-y-4 text-sm">
      <Prop label={t('card.column')}>
        <select
          value={card.list_id}
          disabled={!b.can('cards.move')}
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
              disabled={!canEdit}
              onClick={() => patch({ status_id: card.status_id === s.id ? null : s.id })}
              className={clsx(
                'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs enabled:cursor-pointer',
                card.status_id === s.id ? 'font-semibold' : 'border-line text-muted enabled:hover:bg-black/5 dark:enabled:hover:bg-white/5',
              )}
              style={card.status_id === s.id ? { borderColor: s.color, background: `${s.color}22` } : undefined}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
              {s.name}
            </button>
          ))}
        </div>
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
                <Avatar name={m.display_name} color={m.avatar_color} size={20} />
                {m.display_name}
              </span>
            ) : null
          })}
          {canEdit && (
            <Popover trigger={<button className="rounded-full p-1 text-muted hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer"><Plus size={15} /></button>}>
              <div className="max-h-64 space-y-0.5 overflow-y-auto">
                {data.members.map((m) => (
                  <button
                    key={m.user_id}
                    onClick={() => setIds.mutate({ kind: 'assignees', ids: toggle(card.assignee_ids, m.user_id) })}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer"
                  >
                    <Avatar name={m.display_name} color={m.avatar_color} size={22} />
                    <span className="flex-1 truncate">{m.display_name}</span>
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
          {canEdit && (
            <Popover trigger={<button className="rounded-full p-1 text-muted hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer"><Plus size={15} /></button>}>
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

      <Prop label={t('card.due')}>
        <div className="flex gap-1">
          <Input
            type="datetime-local"
            disabled={!canEdit}
            defaultValue={dueLocal}
            key={dueLocal}
            onBlur={(e) => {
              const v = e.currentTarget.value
              const iso = v ? new Date(v).toISOString() : null
              if ((iso ?? '') !== (card.due_at ? new Date(card.due_at).toISOString() : '')) patch({ due_at: iso })
            }}
            className="h-8 text-xs"
          />
          {card.due_at && canEdit && (
            <Button variant="ghost" size="sm" onClick={() => patch({ due_at: null })} title={t('common.clear')}>
              <X size={14} />
            </Button>
          )}
        </div>
      </Prop>

      <Prop label={t('card.color')}>
        <ColorPicker value={card.color} allowNone onChange={(color) => canEdit && patch({ color })} />
      </Prop>

      <div className="space-y-0.5 border-t border-line pt-3 text-xs text-muted">
        <div>
          {t('card.created')}: {fmtDate(card.created_at, true)}
          {card.created_by && b.members.get(card.created_by) && ` · ${b.members.get(card.created_by)!.display_name}`}
        </div>
        <div>
          {t('card.updated')}: {fmtRelative(card.updated_at)}
        </div>
      </div>

      {b.can('cards.delete') && (
        <Button variant="outline" size="sm" className="w-full text-red-600" onClick={() => confirm(t('card.archiveConfirm')) && archive.mutate()}>
          <Archive size={14} /> {t('card.archive')}
        </Button>
      )}
      {detail.attachments.length === 0 && !b.can('attachments.upload') ? null : (
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
  const [color, setColor] = useState<string | null>('#6366f1')
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

function toLocalInput(iso: string) {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Description: always-on live-preview editor with debounced autosave (the server folds consecutive edits into one log entry). */
function DescriptionEditor({
  cardId,
  value,
  canEdit,
  upload,
  onSaved,
}: {
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
    state === 'saving' ? t('editor.saving') : state === 'saved' ? `✓ ${t('editor.saved')}` : state === 'dirty' ? t('editor.unsaved') : state === 'error' ? t('editor.saveFailed') : ''

  return (
    <LiveEditor
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

function CommentEdit({ body, upload, onSave, onCancel }: { body: string; upload: Uploader; onSave: (b: string) => void; onCancel: () => void }) {
  const { t } = useTranslation()
  const ref = useRef<LiveEditorHandle>(null)
  const save = () => {
    const v = ref.current?.getValue() ?? ''
    if (v.trim()) onSave(v)
  }
  return (
    <div className="space-y-2">
      <LiveEditor ref={ref} value={body} upload={upload} autoFocus onSubmit={save} onEscape={() => (onCancel(), true)} minHeight={44} />
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
