import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, Plus, Search } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'
import { toastError } from '../components/toast'
import { Avatar, Button, ColorPicker, Dialog, Field, Input, Spinner } from '../components/ui'
import { api } from '../lib/api'
import { useMe } from '../lib/auth'
import { fmtRelative } from '../lib/prefs'
import type { Board, BoardListItem } from '../lib/types'

export function Boards() {
  const { t } = useTranslation()
  const { data: me } = useMe()
  const [filter, setFilter] = useState('')
  const [owner, setOwner] = useState('')
  const [creating, setCreating] = useState(false)
  const { data, isLoading } = useQuery({ queryKey: ['boards'], queryFn: () => api.get<BoardListItem[]>('/boards') })

  // client-side substring filter (Thai-safe: no word splitting involved)
  const f = filter.trim().toLowerCase()
  const boards = (data ?? []).filter(
    (b) => (!f || `${b.name} ${b.description}`.toLowerCase().includes(f)) && (!owner || b.owners.some((o) => o.id === owner)),
  )
  const owners = useMemo(() => {
    const m = new Map<string, { id: string; display_name: string }>()
    for (const b of data ?? []) for (const o of b.owners) m.set(o.id, o)
    return [...m.values()].sort((a, b) => a.display_name.localeCompare(b.display_name))
  }, [data])

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{t('boards.title')}</h1>
        <select
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          className="ml-auto h-9 rounded-md border border-line bg-surface px-2 text-sm"
          aria-label={t('filter.owner')}
        >
          <option value="">{t('filter.allOwners')}</option>
          {owners.map((o) => (
            <option key={o.id} value={o.id}>
              {t('filter.ownedBy')}: {o.display_name}
            </option>
          ))}
        </select>
        <div className="relative w-full max-w-xs">
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
              <div className="mt-3 flex items-center gap-1.5 text-xs text-muted">
                <span className="flex -space-x-1.5">
                  {b.owners.slice(0, 3).map((o) => (
                    <Avatar key={o.id} name={o.display_name} color={o.avatar_color} size={20} />
                  ))}
                </span>
                <span className="truncate">{b.owners.map((o) => o.display_name).join(', ')}</span>
              </div>
              <div className="mt-2 flex gap-3 text-xs text-muted">
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
