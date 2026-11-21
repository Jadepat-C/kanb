import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api'
import type { BoardListItem, BoardTemplate } from '../lib/types'
import { toastError, toastSuccess } from './toast'
import { Button, Dialog, Field, Input } from './ui'

/** "Save as board template": from Board settings (board fixed) or from the Templates page (pick a board). */
export function SaveBoardTemplate({ boardId, boardName, onClose }: { boardId?: string; boardName?: string; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const boards = useQuery({ queryKey: ['boards'], queryFn: () => api.get<BoardListItem[]>('/boards'), enabled: !boardId })
  const [board, setBoard] = useState(boardId ?? '')
  const picked = boardId ? boardName : boards.data?.find((b) => b.id === board)?.name
  const [name, setName] = useState('')
  const [withCards, setWithCards] = useState(false)
  const save = useMutation({
    mutationFn: () => api.post<BoardTemplate>(`/boards/${board}/save-as-template`, { name: name.trim() || picked, include_cards: withCards }),
    onSuccess: (bt) => {
      qc.invalidateQueries({ queryKey: ['board-templates'] })
      toastSuccess(t('boardTemplates.saved', { name: bt.name }))
      onClose()
    },
    onError: toastError,
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('boardTemplates.saveBoard')}>
      <form
        className="space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (board) save.mutate()
        }}
      >
        {!boardId && (
          <Field label={t('boardTemplates.board')}>
            <select value={board} onChange={(e) => setBoard(e.target.value)} className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm" required>
              <option value="">—</option>
              {(boards.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={t('boardTemplates.name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={picked ?? ''} autoFocus={!!boardId} />
        </Field>
        <p className="text-sm text-muted">{t('boardTemplates.saveIncludes')}</p>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={withCards} onChange={(e) => setWithCards(e.target.checked)} className="mt-1 accent-[var(--color-accent)]" />
          <span>
            {t('boardTemplates.includeCards')}
            <span className="block text-xs text-muted">{t('boardTemplates.includeCardsHint')}</span>
          </span>
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!board || save.isPending}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
