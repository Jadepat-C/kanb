import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api'
import { templateDue, type BoardDetail, type BoardListItem, type CardSummary } from '../lib/types'
import { toastError, toastSuccess } from './toast'
import { Button, Dialog, Field, Input } from './ui'
import { DateInput, TimeInput } from './DateInput'

export interface NewCardPreset {
  boardId?: string
  listId?: string
  /** ISO timestamp; its local date/time pre-fill the fields */
  due?: string | null
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Create a card with a column and an optional due date. Without a fixed board it shows a board picker. */
export function NewCardDialog({
  preset,
  onClose,
  onCreated,
}: {
  preset: NewCardPreset
  onClose: () => void
  onCreated?: (card: CardSummary, boardId: string, open: boolean) => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [boardId, setBoardId] = useState(preset.boardId ?? '')
  const [listId, setListId] = useState(preset.listId ?? '')
  const [title, setTitle] = useState('')
  const d = preset.due ? new Date(preset.due) : null
  const [date, setDate] = useState(d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : '')
  const [time, setTime] = useState(d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '09:00')
  const [openAfter, setOpenAfter] = useState(false)
  const [templateId, setTemplateId] = useState('')
  const [busy, setBusy] = useState(false)

  const boards = useQuery({ queryKey: ['boards'], queryFn: () => api.get<BoardListItem[]>('/boards'), enabled: !preset.boardId })
  const board = useQuery({ queryKey: ['board', boardId], queryFn: () => api.get<BoardDetail>(`/boards/${boardId}`), enabled: !!boardId })
  const canCreate = board.data?.my_permissions.includes('cards.create') ?? false
  const lists = board.data?.lists ?? []

  // default column: the preset one, else the first unfolded one
  useEffect(() => {
    if (!lists.length) return
    if (!lists.some((l) => l.id === listId)) setListId((lists.find((l) => !l.folded) ?? lists[0]).id)
  }, [lists, listId])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if ((!title.trim() && !templateId) || !listId) return
    setBusy(true)
    try {
      const tpl = board.data?.templates.find((x) => x.id === templateId)
      const due_at = date ? new Date(`${date}T${time || '09:00'}`).toISOString() : tpl ? templateDue(tpl) : null
      const card = await api.post<CardSummary>(`/lists/${listId}/cards`, { title: title.trim(), due_at, template_id: tpl?.id })
      qc.invalidateQueries({ queryKey: ['board', boardId] })
      qc.invalidateQueries({ queryKey: ['calendar'] })
      toastSuccess(t('toast.cardCreated', { title: card.title }))
      onCreated?.(card, boardId, openAfter)
      onClose()
    } catch (err) {
      toastError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('menu.newCard')}>
      <form onSubmit={submit} className="space-y-3 p-5">
        {!preset.boardId && (
          <Field label={t('boards.title')}>
            <select value={boardId} onChange={(e) => setBoardId(e.target.value)} required className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm">
              <option value="">—</option>
              {(boards.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {!!board.data?.templates.length && (
          <Field label={t('templates.template')}>
            <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm">
              <option value="">{t('templates.none')}</option>
              {board.data.templates.map((tp) => (
                <option key={tp.id} value={tp.id}>
                  {tp.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={t('common.name')}>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={board.data?.templates.find((x) => x.id === templateId)?.title ?? t('board.cardTitle')}
            autoFocus
            required={!templateId}
          />
        </Field>
        <Field label={t('card.column')}>
          <select value={listId} onChange={(e) => setListId(e.target.value)} disabled={!lists.length} className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm">
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-[1fr_110px] gap-2">
          <Field label={t('card.due')}>
            <DateInput value={date} onChange={setDate} />
          </Field>
          <Field label={t('menu.time')}>
            <TimeInput value={time || '09:00'} onChange={setTime} disabled={!date} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={openAfter} onChange={(e) => setOpenAfter(e.target.checked)} className="accent-[var(--color-accent)]" />
          {t('menu.openAfter')}
        </label>
        {boardId && board.data && !canCreate && <p className="text-sm text-red-600">{t('errors.forbidden')}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={busy || (!title.trim() && !templateId) || !listId || !canCreate}>
            {t('common.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
