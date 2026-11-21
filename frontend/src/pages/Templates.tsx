import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { ArrowDown, ArrowUp, Copy, LayoutTemplate, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router'
import { TemplateEditor } from '../components/BoardSettings'
import { Stars } from '../components/CardTile'
import { ask } from '../components/dialogs'
import { toastError, toastSuccess } from '../components/toast'
import { Button, ColorPicker, Dialog, Field, Input, Spinner } from '../components/ui'
import { api } from '../lib/api'
import { useMe } from '../lib/auth'
import { useBoard } from '../lib/board'
import { fmtRelative } from '../lib/prefs'
import type { BoardTemplate, BoardTemplateData, CardTemplate } from '../lib/types'
import { CreateBoard } from './Boards'
import { SaveBoardTemplate } from '../components/SaveBoardTemplate'

/** Templates page: board templates (blueprints for new boards) and every board's card templates. */
export function TemplatesPage() {
  const { t } = useTranslation()
  const [sp, setSp] = useSearchParams()
  const tab = sp.get('tab') === 'cards' ? 'cards' : 'boards'
  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="mb-5 flex items-center gap-1 border-b border-line">
        {(['boards', 'cards'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setSp(k === 'boards' ? {} : { tab: k })}
            className={clsx(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium cursor-pointer',
              tab === k ? 'border-accent text-[var(--text)]' : 'border-transparent text-muted hover:text-[var(--text)]',
            )}
          >
            {t(k === 'boards' ? 'boardTemplates.title' : 'boardTemplates.cardTitle')}
          </button>
        ))}
      </div>
      {tab === 'boards' ? <BoardTemplates /> : <CardTemplates />}
    </div>
  )
}

// ---------- board templates ----------

function BoardTemplates() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: me } = useMe()
  const canMake = !!(me?.can_create_boards || me?.is_super_admin)
  const q = useQuery({ queryKey: ['board-templates'], queryFn: () => api.get<BoardTemplate[]>('/board-templates') })
  const [editing, setEditing] = useState<BoardTemplate | 'new' | null>(null)
  const [using, setUsing] = useState<BoardTemplate | null>(null)
  const [fromBoard, setFromBoard] = useState(false)
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/board-templates/${id}`),
    onSuccess: () => (qc.invalidateQueries({ queryKey: ['board-templates'] }), toastSuccess(t('toast.deleted'))),
    onError: toastError,
  })
  if (!q.data) return <Spinner />
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-sm text-muted">{t('boardTemplates.hint')}</p>
        {canMake && (
          <>
            <Button onClick={() => setFromBoard(true)}>
              <Copy size={14} /> {t('boardTemplates.fromBoard')}
            </Button>
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Plus size={14} /> {t('boardTemplates.new')}
            </Button>
          </>
        )}
      </div>
      {q.data.length === 0 && <p className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-muted">{t('boardTemplates.empty')}</p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {q.data.map((bt) => (
          <div key={bt.id} className="flex flex-col overflow-hidden rounded-xl border border-line bg-surface">
            <div className="h-1.5" style={{ background: bt.color }} />
            <div className="flex flex-1 flex-col gap-2 p-4">
              <div className="flex items-start gap-2">
                <LayoutTemplate size={16} className="mt-0.5 shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold [overflow-wrap:anywhere]">{bt.name}</div>
                  {bt.description && <p className="line-clamp-2 text-sm text-muted">{bt.description}</p>}
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {bt.data.lists.slice(0, 6).map((l, i) => (
                  <span key={i} className="rounded bg-black/5 px-1.5 py-px text-[11px] dark:bg-white/10">
                    {l.name}
                  </span>
                ))}
                {bt.data.lists.length > 6 && <span className="text-[11px] text-muted">+{bt.data.lists.length - 6}</span>}
              </div>
              <div className="text-xs text-muted">
                {[
                  t('boardTemplates.nStatuses', { count: bt.counts.statuses }),
                  t('boardTemplates.nLabels', { count: bt.counts.labels }),
                  t('boardTemplates.nCardTemplates', { count: bt.counts.card_templates }),
                  t('boardTemplates.nCards', { count: bt.counts.cards }),
                ].join(' · ')}
              </div>
              <div className="text-[11px] text-muted">
                {bt.author ?? '—'} · {fmtRelative(bt.updated_at)}
              </div>
              <div className="mt-auto flex items-center gap-1 pt-2">
                {canMake && (
                  <Button size="sm" variant="primary" onClick={() => setUsing(bt)}>
                    {t('boardTemplates.use')}
                  </Button>
                )}
                {bt.can_edit && (
                  <>
                    <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setEditing(bt)}>
                      <Pencil size={13} /> {t('common.edit')}
                    </Button>
                    <button
                      title={t('common.delete')}
                      className="rounded p-1.5 text-muted hover:text-red-600 cursor-pointer"
                      onClick={async () =>
                        (await ask({ title: t('common.delete'), message: t('boardTemplates.deleteMsg', { name: bt.name }), confirmLabel: t('common.delete'), danger: true })) &&
                        del.mutate(bt.id)
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      {editing && <BoardTemplateEditor template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {using && <CreateBoard open onOpenChange={(o) => !o && setUsing(null)} templateId={using.id} />}
      {fromBoard && <SaveBoardTemplate onClose={() => setFromBoard(false)} />}
    </div>
  )
}

const MAX_SHOWN = 8

function BoardTemplateEditor({ template, onClose }: { template: BoardTemplate | null; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [name, setName] = useState(template?.name ?? '')
  const [description, setDescription] = useState(template?.description ?? '')
  const [color, setColor] = useState<string | null>(template?.color ?? '#2f5bd3')
  const [d, setD] = useState<BoardTemplateData>(
    () =>
      template?.data ?? {
        lists: t('boards.defaultLists')
          .split(/[,，]/)
          .map((n) => ({ name: n.trim() })),
        statuses: [],
        labels: [],
        card_templates: [],
        cards: [],
      },
  )
  const [showAllCards, setShowAllCards] = useState(false)
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), description, color, data: d }
      return template ? api.patch(`/board-templates/${template.id}`, body) : api.post('/board-templates', body)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['board-templates'] })
      toastSuccess(t('common.saved'))
      onClose()
    },
    onError: toastError,
  })
  const move = <T,>(arr: T[], i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= arr.length) return arr
    const a = [...arr]
    ;[a[i], a[j]] = [a[j], a[i]]
    return a
  }
  // removing a column drops its cards and shifts the others' column index
  const removeList = (i: number) =>
    setD({
      ...d,
      lists: d.lists.filter((_, k) => k !== i),
      cards: d.cards.filter((c) => c.list !== i).map((c) => ({ ...c, list: c.list > i ? c.list - 1 : c.list })),
    })
  const moveList = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= d.lists.length) return
    setD({ ...d, lists: move(d.lists, i, dir), cards: d.cards.map((c) => ({ ...c, list: c.list === i ? j : c.list === j ? i : c.list })) })
  }
  const named = (key: 'statuses' | 'labels') => (
    <section className="min-w-0 space-y-1.5">
      <h3 className="text-sm font-semibold">{t(key === 'statuses' ? 'settings.statuses' : 'settings.labels')}</h3>
      {key === 'statuses' && d.statuses.length === 0 && <p className="text-xs text-muted">{t('boardTemplates.defaultStatuses')}</p>}
      {d[key].map((x, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            type="color"
            value={x.color}
            onChange={(e) => setD({ ...d, [key]: d[key].map((y, k) => (k === i ? { ...y, color: e.target.value } : y)) })}
            className="h-8 w-8 shrink-0 cursor-pointer rounded border border-line bg-transparent p-0.5"
          />
          <div className="min-w-0 flex-1">
            <Input value={x.name} onChange={(e) => setD({ ...d, [key]: d[key].map((y, k) => (k === i ? { ...y, name: e.target.value } : y)) })} className="h-8" />
          </div>
          {key === 'statuses' && (
            <label className="flex shrink-0 items-center gap-1 text-[11px] text-muted" title={t('settings.doneHint')}>
              <input
                type="checkbox"
                checked={!!d.statuses[i].done}
                onChange={(e) => setD({ ...d, statuses: d.statuses.map((y, k) => (k === i ? { ...y, done: e.target.checked } : y)) })}
                className="accent-[var(--color-accent)]"
              />
              {t('settings.done')}
            </label>
          )}
          <IconX onClick={() => setD({ ...d, [key]: d[key].filter((_, k) => k !== i) })} />
        </div>
      ))}
      <Button type="button" size="sm" variant="ghost" onClick={() => setD({ ...d, [key]: [...d[key], { name: '', color: key === 'labels' ? '#0ea5e9' : '#a1a1aa' }] })}>
        <Plus size={13} /> {t('common.add')}
      </Button>
    </section>
  )
  const shownCards = showAllCards ? d.cards : d.cards.slice(0, MAX_SHOWN)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={template ? t('boardTemplates.edit') : t('boardTemplates.new')} wide>
      <form
        className="space-y-5 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim() && d.lists.some((l) => l.name.trim())) save.mutate()
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('boardTemplates.name')}>
            <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </Field>
          <Field label={t('common.description')}>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
        <Field label={t('common.color')}>
          <ColorPicker value={color} onChange={setColor} />
        </Field>
        <div className="grid gap-5 md:grid-cols-[1.3fr_1fr_1fr]">
          <section className="min-w-0 space-y-1.5">
            <h3 className="text-sm font-semibold">{t('boardTemplates.columns')}</h3>
            {d.lists.map((l, i) => (
              <div key={i} className="flex items-center gap-1">
                <div className="min-w-0 flex-1">
                  <Input value={l.name} onChange={(e) => setD({ ...d, lists: d.lists.map((y, k) => (k === i ? { ...y, name: e.target.value } : y)) })} className="h-8" />
                </div>
                <div className="w-16 shrink-0">
                  <Input
                    type="number"
                    min={1}
                    title={t('board.wipLimit')}
                    placeholder="WIP"
                    value={l.wip_limit ?? ''}
                    onChange={(e) => setD({ ...d, lists: d.lists.map((y, k) => (k === i ? { ...y, wip_limit: e.target.value ? Number(e.target.value) : null } : y)) })}
                    className="h-8 !px-2 text-xs"
                  />
                </div>
                <button type="button" title={t('common.up')} onClick={() => moveList(i, -1)} className="rounded p-1 text-muted hover:text-[var(--text)] cursor-pointer">
                  <ArrowUp size={13} />
                </button>
                <button type="button" title={t('common.down')} onClick={() => moveList(i, 1)} className="rounded p-1 text-muted hover:text-[var(--text)] cursor-pointer">
                  <ArrowDown size={13} />
                </button>
                {d.lists.length > 1 && <IconX onClick={() => removeList(i)} />}
              </div>
            ))}
            <Button type="button" size="sm" variant="ghost" onClick={() => setD({ ...d, lists: [...d.lists, { name: '' }] })}>
              <Plus size={13} /> {t('common.add')}
            </Button>
          </section>
          {named('statuses')}
          {named('labels')}
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          <section className="space-y-1.5">
            <h3 className="text-sm font-semibold">{t('templates.cardTemplatesHeading', { count: d.card_templates.length })}</h3>
            {d.card_templates.length === 0 && <p className="text-xs text-muted">{t('boardTemplates.noCardTemplates')}</p>}
            {d.card_templates.map((ct, i) => (
              <div key={i} className="flex items-center gap-2 rounded-md border border-line px-2 py-1 text-sm">
                <LayoutTemplate size={13} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate">{ct.name}</span>
                <IconX onClick={() => setD({ ...d, card_templates: d.card_templates.filter((_, k) => k !== i) })} />
              </div>
            ))}
          </section>
          <section className="space-y-1.5">
            <h3 className="text-sm font-semibold">{t('boardTemplates.cardsHeading', { count: d.cards.length })}</h3>
            {d.cards.length === 0 && <p className="text-xs text-muted">{t('boardTemplates.noCards')}</p>}
            {shownCards.map((c, i) => (
              <div key={i} className="flex items-center gap-2 rounded-md border border-line px-2 py-1 text-sm">
                <span className="shrink-0 rounded bg-black/5 px-1 text-[10px] text-muted dark:bg-white/10">{d.lists[c.list]?.name}</span>
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                <IconX onClick={() => setD({ ...d, cards: d.cards.filter((_, k) => k !== i) })} />
              </div>
            ))}
            {d.cards.length > MAX_SHOWN && !showAllCards && (
              <button type="button" onClick={() => setShowAllCards(true)} className="text-xs text-accent hover:underline cursor-pointer">
                {t('boardTemplates.showAll', { count: d.cards.length })}
              </button>
            )}
            {d.cards.length > 0 && (
              <Button type="button" size="sm" variant="ghost" onClick={() => setD({ ...d, cards: [] })}>
                <Trash2 size={13} /> {t('boardTemplates.removeCards')}
              </Button>
            )}
          </section>
        </div>
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={save.isPending || !name.trim()}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function IconX({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation()
  return (
    <button type="button" title={t('common.remove')} onClick={onClick} className="shrink-0 rounded p-1 text-muted hover:text-red-600 cursor-pointer">
      <X size={14} />
    </button>
  )
}

// ---------- card templates (all boards) ----------

interface BoardCardTemplates {
  board_id: string
  board_name: string
  board_color: string
  can_manage: boolean
  templates: CardTemplate[]
}

function CardTemplates() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['card-templates'], queryFn: () => api.get<BoardCardTemplates[]>('/card-templates') })
  const [editing, setEditing] = useState<{ boardId: string; template: CardTemplate | null } | null>(null)
  const [copying, setCopying] = useState<CardTemplate | null>(null)
  const [onlyWith, setOnlyWith] = useState(true)
  const refresh = () => qc.invalidateQueries({ queryKey: ['card-templates'] })
  if (!q.data) return <Spinner />
  const groups = q.data.filter((g) => !onlyWith || g.templates.length > 0)
  const manageable = q.data.filter((g) => g.can_manage)
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1 text-sm text-muted">{t('boardTemplates.cardHint')}</p>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={onlyWith} onChange={(e) => setOnlyWith(e.target.checked)} className="accent-[var(--color-accent)]" />
          {t('boardTemplates.onlyWithTemplates')}
        </label>
      </div>
      {groups.length === 0 && <p className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-muted">{t('boardTemplates.noCardTemplatesAnywhere')}</p>}
      {groups.map((g) => (
        <section key={g.board_id} className="overflow-hidden rounded-xl border border-line bg-surface">
          <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: g.board_color }} />
            <Link to={`/b/${g.board_id}`} className="font-semibold hover:underline">
              {g.board_name}
            </Link>
            <span className="text-xs text-muted">({g.templates.length})</span>
            {g.can_manage && (
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setEditing({ boardId: g.board_id, template: null })}>
                <Plus size={13} /> {t('templates.new')}
              </Button>
            )}
          </div>
          {g.templates.length === 0 && <p className="px-4 py-3 text-sm text-muted">{t('templates.empty')}</p>}
          <div className="divide-y divide-[var(--border)]">
            {g.templates.map((tp) => (
              <div key={tp.id} className="flex items-center gap-3 px-4 py-2">
                <LayoutTemplate size={15} className="shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{tp.name}</div>
                  <div className="flex items-center gap-2 truncate text-xs text-muted">
                    <span className="truncate">{tp.title}</span>
                    {tp.priority > 0 && <Stars value={tp.priority} size={11} />}
                    {tp.due_in_days != null && <span>· {t('templates.dueIn', { count: tp.due_in_days })}</span>}
                  </div>
                </div>
                {manageable.some((m) => m.board_id !== g.board_id) && (
                  <Button size="sm" variant="ghost" onClick={() => setCopying(tp)} title={t('boardTemplates.copyTo')}>
                    <Copy size={13} /> <span className="hidden sm:inline">{t('boardTemplates.copyTo')}</span>
                  </Button>
                )}
                {g.can_manage && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setEditing({ boardId: g.board_id, template: tp })}>
                      <Pencil size={13} />
                    </Button>
                    <button
                      title={t('common.delete')}
                      className="rounded p-1.5 text-muted hover:text-red-600 cursor-pointer"
                      onClick={async () =>
                        (await ask({ title: t('common.delete'), message: t('templates.deleteMsg', { name: tp.name }), confirmLabel: t('common.delete'), danger: true })) &&
                        api.del(`/templates/${tp.id}`).then(() => (refresh(), toastSuccess(t('toast.deleted'))), toastError)
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
      {editing && <CardTemplateEdit boardId={editing.boardId} template={editing.template} onClose={() => (setEditing(null), refresh())} />}
      {copying && (
        <CopyTemplate
          template={copying}
          boards={manageable.filter((m) => !m.templates.some((x) => x.id === copying.id))}
          onClose={() => (setCopying(null), refresh())}
        />
      )}
    </div>
  )
}

/** The board's own template editor needs that board's statuses and labels. */
function CardTemplateEdit({ boardId, template, onClose }: { boardId: string; template: CardTemplate | null; onClose: () => void }) {
  const b = useBoard(boardId)
  if (!b.data) return null
  return <TemplateEditor b={b} boardId={boardId} template={template} onClose={onClose} />
}

function CopyTemplate({ template, boards, onClose }: { template: CardTemplate; boards: BoardCardTemplates[]; onClose: () => void }) {
  const { t } = useTranslation()
  const [board, setBoard] = useState(boards[0]?.board_id ?? '')
  const copy = useMutation({
    mutationFn: () => api.post(`/templates/${template.id}/copy`, { board_id: board }),
    onSuccess: () => {
      toastSuccess(t('boardTemplates.copied', { name: template.name, board: boards.find((b) => b.board_id === board)?.board_name }))
      onClose()
    },
    onError: toastError,
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('boardTemplates.copyTitle', { name: template.name })}>
      <form
        className="space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (board) copy.mutate()
        }}
      >
        <Field label={t('boardTemplates.board')}>
          <select value={board} onChange={(e) => setBoard(e.target.value)} className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm">
            {boards.map((b) => (
              <option key={b.board_id} value={b.board_id}>
                {b.board_name}
              </option>
            ))}
          </select>
        </Field>
        <p className="text-xs text-muted">{t('boardTemplates.copyHint')}</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!board || copy.isPending}>
            {t('boardTemplates.copy')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
