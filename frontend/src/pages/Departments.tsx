/** Admin → Departments: create, rename, colour and delete departments, and choose who is in each. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, Plus, Trash2, UserMinus, UserPlus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ask } from '../components/dialogs'
import { toastError, toastSuccess } from '../components/toast'
import { Avatar, Button, ColorPicker, Input, Menu, MenuContent, MenuItem, MenuTrigger, Spinner } from '../components/ui'
import { api } from '../lib/api'
import { useDepartments, type Department } from '../lib/departments'
import type { User } from '../lib/types'
import { avatarUrl, label } from '../lib/user'

export function DepartmentsTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const deps = useDepartments()
  const users = useQuery({ queryKey: ['admin-users'], queryFn: () => api.get<User[]>('/admin/users') })
  const [name, setName] = useState('')
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['departments'] })
    qc.invalidateQueries({ queryKey: ['admin-users'] })
    qc.invalidateQueries({ queryKey: ['users'] })
  }
  const create = useMutation({
    mutationFn: () => api.post('/admin/departments', { name }),
    onSuccess: () => (setName(''), refresh(), toastSuccess(t('departments.created', { name }))),
    onError: toastError,
  })
  if (!deps.data || !users.data) return <Spinner />
  const active = users.data.filter((u) => u.is_active)
  const without = active.filter((u) => !u.department_id).length
  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-muted">{t('departments.hint')}</p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) create.mutate()
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('departments.newPlaceholder')} maxLength={80} className="max-w-xs" />
        <Button variant="primary" disabled={!name.trim() || create.isPending}>
          <Plus size={15} /> {t('departments.add')}
        </Button>
      </form>
      {deps.data.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-muted">{t('departments.empty')}</p>
      ) : (
        <div className="space-y-3">
          {deps.data.map((d) => (
            <DepartmentRow key={d.id} d={d} people={active.filter((u) => u.department_id === d.id)} everyone={active} onChanged={refresh} />
          ))}
        </div>
      )}
      {deps.data.length > 0 && <p className="text-xs text-muted">{t('departments.without', { count: without })}</p>}
    </div>
  )
}

function DepartmentRow({ d, people, everyone, onChanged }: { d: Department; people: User[]; everyone: User[]; onChanged: () => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState(d.name)
  const [filter, setFilter] = useState('')
  const patch = useMutation({
    mutationFn: (p: { name?: string; color?: string }) => api.patch(`/admin/departments/${d.id}`, p),
    onSuccess: onChanged,
    onError: (e) => (setName(d.name), toastError(e)),
  })
  const members = useMutation({
    mutationFn: (p: { add?: string[]; remove?: string[] }) => api.put(`/admin/departments/${d.id}/members`, p),
    onSuccess: onChanged,
    onError: toastError,
  })
  const remove = useMutation({
    mutationFn: () => api.del(`/admin/departments/${d.id}`),
    onSuccess: () => (onChanged(), toastSuccess(t('departments.deleted', { name: d.name }))),
    onError: toastError,
  })
  const others = everyone
    .filter((u) => u.department_id !== d.id)
    .filter((u) => !filter.trim() || `${u.display_name} ${u.username}`.toLowerCase().includes(filter.trim().toLowerCase()))
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Building2 size={16} style={{ color: d.color }} />
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name.trim() !== d.name && patch.mutate({ name: name.trim() })}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          className="h-8 max-w-60 font-medium"
          aria-label={t('common.name')}
        />
        <span className="text-xs text-muted">{t('departments.members', { count: people.length })}</span>
        <div className="ml-auto flex items-center gap-1">
          <Menu>
            <MenuTrigger asChild>
              <Button size="sm">
                <UserPlus size={14} /> {t('departments.addPeople')}
              </Button>
            </MenuTrigger>
            <MenuContent>
              <div className="p-1">
                <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('admin.search')} className="h-8" onKeyDown={(e) => e.stopPropagation()} />
              </div>
              {others.length === 0 && <p className="px-2 py-1.5 text-xs text-muted">{t('search.noResults')}</p>}
              {others.slice(0, 50).map((u) => (
                <MenuItem key={u.id} onSelect={() => members.mutate({ add: [u.id] })}>
                  <Avatar name={label(u)} color={u.avatar_color} src={avatarUrl(u.avatar_id)} size={20} />
                  <span className="truncate">{label(u)}</span>
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
          <button
            className="rounded-md p-1.5 text-muted hover:bg-red-500/10 hover:text-red-600 cursor-pointer"
            title={t('common.delete')}
            aria-label={t('common.delete')}
            onClick={async () => {
              const ok = await ask({
                title: t('departments.deleteTitle', { name: d.name }),
                message: t('departments.deleteMsg', { count: people.length }),
                confirmLabel: t('common.delete'),
                danger: true,
              })
              if (ok) remove.mutate()
            }}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
      <div className="mt-3">
        <ColorPicker value={d.color} onChange={(c) => c && patch.mutate({ color: c })} />
      </div>
      {people.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {people.map((u) => (
            <li key={u.id} className="flex items-center gap-1.5 rounded-full border border-line py-0.5 pl-0.5 pr-1 text-xs">
              <Avatar name={label(u)} color={u.avatar_color} src={avatarUrl(u.avatar_id)} size={20} />
              {u.display_name}
              <button
                className="rounded-full p-0.5 text-muted hover:bg-black/5 hover:text-red-600 dark:hover:bg-white/10 cursor-pointer"
                title={t('departments.removePerson', { name: u.display_name })}
                aria-label={t('departments.removePerson', { name: u.display_name })}
                onClick={() => members.mutate({ remove: [u.id] })}
              >
                <UserMinus size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
