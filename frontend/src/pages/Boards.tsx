import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, Plus, Search } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'
import { toastError } from '../components/toast'
import { Button, ColorPicker, Dialog, Field, Input, Spinner } from '../components/ui'
import { api } from '../lib/api'
import { useMe } from '../lib/auth'
import { fmtRelative } from '../lib/prefs'
import type { Board, BoardListItem } from '../lib/types'

export function Boards() {
  const { t } = useTranslation()
  const { data: me } = useMe()
  const [filter, setFilter] = useState('')
  const [creating, setCreating] = useState(false)
  const { data, isLoading } = useQuery({ queryKey: ['boards'], queryFn: () => api.get<BoardListItem[]>('/boards') })

  // client-side substring filter (Thai-safe: no word splitting involved)
  const f = filter.trim().toLowerCase()
  const boards = (data ?? []).filter((b) => !f || `${b.name} ${b.description}`.toLowerCase().includes(f))

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{t('boards.title')}</h1>
        <div className="relative ml-auto w-full max-w-xs">
          <Search size={15} className="absolute left-2.5 top-2.5 text-muted" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('search.filterBoards')} className="pl-8" />
        </div>
        {(me?.can_create_boards || me?.is_super_admin) && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> {t('boards.new')}
          </Button>
        )}
      </div>
      {isLoading ? (
        <Spinner />
      ) : boards.length === 0 ? (
        <p className="text-muted">{t('boards.empty')}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {boards.map((b) => (
            <Link
              key={b.id}
              to={`/b/${b.id}`}
              className="group relative overflow-hidden rounded-xl border border-line bg-surface p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
            >
              <div className="absolute inset-x-0 top-0 h-1" style={{ background: b.color }} />
              <div className="flex items-start gap-2">
                <h2 className="font-semibold group-hover:text-accent">{b.name}</h2>
                {!b.is_member && (
                  <span title={t('boards.notMember')} className="ml-auto text-muted">
                    <Eye size={15} />
                  </span>
                )}
              </div>
              {b.description && <p className="mt-1 line-clamp-2 text-sm text-muted">{b.description}</p>}
              <div className="mt-3 flex gap-3 text-xs text-muted">
                <span>{t('boards.cards', { count: b.card_count })}</span>
                <span>{t('boards.members', { count: b.member_count })}</span>
                <span className="ml-auto">{fmtRelative(b.updated_at)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
      <CreateBoard open={creating} onOpenChange={setCreating} />
    </div>
  )
}

function CreateBoard({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const nav = useNavigate()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState<string | null>('#6366f1')
  const [lists, setLists] = useState(t('boards.defaultLists'))
  const m = useMutation({
    mutationFn: () =>
      api.post<Board>('/boards', {
        name,
        description,
        color,
        lists: lists.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      }),
    onSuccess: (b) => {
      qc.invalidateQueries({ queryKey: ['boards'] })
      onOpenChange(false)
      nav(`/b/${b.id}`)
    },
    onError: toastError,
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    m.mutate()
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('boards.new')}>
      <form onSubmit={submit} className="space-y-4 p-5">
        <Field label={t('common.name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('boards.namePlaceholder')} autoFocus required />
        </Field>
        <Field label={t('common.description')}>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label={t('boards.listsLabel')}>
          <Input value={lists} onChange={(e) => setLists(e.target.value)} />
        </Field>
        <Field label={t('common.color')}>
          <ColorPicker value={color} onChange={setColor} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={m.isPending}>
            {t('common.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
