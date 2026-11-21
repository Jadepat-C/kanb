import type { TFunction } from 'i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Pencil, Plus, Repeat, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api'
import type { BoardHelpers } from '../lib/board'
import { fmtDate } from '../lib/prefs'
import { avatarUrl, label } from '../lib/user'
import { TimeInput } from './DateInput'
import { ask } from './dialogs'
import { toastError, toastSuccess } from './toast'
import { Avatar, Button, Dialog, Field, Input, Toggle } from './ui'

export interface Recurrence {
  id: string
  template_id: string
  list_id: string
  freq: 'daily' | 'weekly' | 'monthly'
  every: number
  weekdays: number[]
  month_day: number | null
  at_time: string // "HH:MM:SS"
  assignee_ids: string[]
  enabled: boolean
  next_run_at: string | null
  last_run_at: string | null
}

function weekdayNames(locale: string, style: 'short' | 'long') {
  // 1 Jan 2024 was a Monday
  return [1, 2, 3, 4, 5, 6, 7].map((i) => new Date(2024, 0, i).toLocaleDateString(locale, { weekday: style }))
}

/** "Every 2 weeks on Mon, Fri at 09:00" */
export function describeRule(r: Pick<Recurrence, 'freq' | 'every' | 'weekdays' | 'month_day' | 'at_time'>, t: TFunction, locale: string) {
  const time = r.at_time.slice(0, 5)
  const days = weekdayNames(locale, 'short')
  if (r.freq === 'daily') return t('recurring.ruleDaily', { count: r.every, time })
  if (r.freq === 'weekly') return t('recurring.ruleWeekly', { count: r.every, days: r.weekdays.map((d) => days[d - 1]).join(', '), time })
  return t('recurring.ruleMonthly', { count: r.every, day: r.month_day, time })
}

/** Board settings → Templates: schedules that create cards from a template. */
export function RecurringCards({ b, boardId }: { b: BoardHelpers; boardId: string }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['recurrences', boardId], queryFn: () => api.get<Recurrence[]>(`/boards/${boardId}/recurrences`) })
  const [editing, setEditing] = useState<Recurrence | 'new' | null>(null)
  const can = b.can('templates.manage')
  const data = b.data!
  const refresh = () => qc.invalidateQueries({ queryKey: ['recurrences', boardId] })
  const locale = i18n.language === 'th' ? 'th-TH' : 'en-GB'
  const items = q.data ?? []
  return (
    <div className="space-y-2 border-t border-line pt-4">
      <div className="flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Repeat size={14} /> {t('recurring.title')}
        </h3>
        {can && data.templates.length > 0 && (
          <Button size="sm" className="ml-auto" onClick={() => setEditing('new')}>
            <Plus size={13} /> {t('recurring.new')}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted">{data.templates.length ? t('recurring.hint') : t('recurring.needTemplate')}</p>
      {items.length > 0 && (
        <div className="divide-y divide-[var(--border)] rounded-lg border border-line">
          {items.map((r) => {
            const tpl = data.templates.find((x) => x.id === r.template_id)
            const list = data.lists.find((l) => l.id === r.list_id)
            return (
              <div key={r.id} className={clsx('flex items-center gap-3 px-3 py-2', !r.enabled && 'opacity-60')}>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {tpl?.name ?? '—'} <span className="font-normal text-muted">→ {list?.name ?? '—'}</span>
                  </div>
                  <div className="text-xs text-muted">{describeRule(r, t, locale)}</div>
                  <div className="text-[11px] text-muted">
                    {r.enabled && r.next_run_at ? t('recurring.next', { when: fmtDate(r.next_run_at, true) }) : t('recurring.paused')}
                    {r.last_run_at && ` · ${t('recurring.last', { when: fmtDate(r.last_run_at, true) })}`}
                  </div>
                </div>
                <span className="flex -space-x-1.5">
                  {r.assignee_ids.map((id) => b.members.get(id)).filter(Boolean).slice(0, 3).map((m) => (
                    <Avatar key={m!.user_id} name={label(m!)} color={m!.avatar_color} src={avatarUrl(m!.avatar_id)} size={20} />
                  ))}
                </span>
                {can && (
                  <>
                    <Toggle checked={r.enabled} onChange={(v) => api.patch(`/recurrences/${r.id}`, { enabled: v }).then(refresh, toastError)} />
                    <button title={t('common.edit')} onClick={() => setEditing(r)} className="rounded p-1.5 text-muted hover:text-[var(--text)] cursor-pointer">
                      <Pencil size={14} />
                    </button>
                    <button
                      title={t('common.delete')}
                      onClick={async () =>
                        (await ask({ title: t('common.delete'), message: t('recurring.deleteMsg'), confirmLabel: t('common.delete'), danger: true })) &&
                        api.del(`/recurrences/${r.id}`).then(refresh, toastError)
                      }
                      className="rounded p-1.5 text-muted hover:text-red-600 cursor-pointer"
                    >
                      <Trash2 size={14} />
                    </button>
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
      {editing && <RuleDialog b={b} boardId={boardId} rule={editing === 'new' ? null : editing} onClose={() => (setEditing(null), refresh())} />}
    </div>
  )
}

function RuleDialog({ b, boardId, rule, onClose }: { b: BoardHelpers; boardId: string; rule: Recurrence | null; onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const data = b.data!
  const locale = i18n.language === 'th' ? 'th-TH' : 'en-GB'
  const [f, setF] = useState(() => ({
    template_id: rule?.template_id ?? data.templates[0]?.id ?? '',
    list_id: rule?.list_id ?? data.lists[0]?.id ?? '',
    freq: rule?.freq ?? ('weekly' as Recurrence['freq']),
    every: rule?.every ?? 1,
    weekdays: rule?.weekdays ?? [((new Date().getDay() + 6) % 7) + 1],
    month_day: rule?.month_day ?? new Date().getDate(),
    at_time: (rule?.at_time ?? '09:00').slice(0, 5),
    assignee_ids: rule?.assignee_ids ?? [],
  }))
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, month_day: f.freq === 'monthly' ? f.month_day : null }
      return rule ? api.patch(`/recurrences/${rule.id}`, body) : api.post(`/boards/${boardId}/recurrences`, body)
    },
    onSuccess: () => (toastSuccess(t('common.saved')), onClose()),
    onError: toastError,
  })
  const days = weekdayNames(locale, 'short')
  const sel = 'h-9 w-full rounded-md border border-line bg-surface px-2 text-sm'
  const unit = t(`recurring.unit_${f.freq}`, { count: f.every })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={rule ? t('recurring.edit') : t('recurring.new')}>
      <form
        className="space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('templates.template')}>
            <select value={f.template_id} onChange={(e) => setF({ ...f, template_id: e.target.value })} className={sel}>
              {data.templates.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('card.column')}>
            <select value={f.list_id} onChange={(e) => setF({ ...f, list_id: e.target.value })} className={sel}>
              {data.lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t('recurring.repeat')}>
            <select value={f.freq} onChange={(e) => setF({ ...f, freq: e.target.value as Recurrence['freq'] })} className={sel}>
              {(['daily', 'weekly', 'monthly'] as const).map((k) => (
                <option key={k} value={k}>
                  {t(`recurring.${k}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('recurring.every')}>
            <div className="flex items-center gap-2">
              <Input type="number" min={1} max={99} value={f.every} onChange={(e) => setF({ ...f, every: Math.max(1, Math.min(99, Number(e.target.value) || 1)) })} className="w-20" />
              <span className="text-sm text-muted">{unit}</span>
            </div>
          </Field>
          <Field label={t('recurring.at')}>
            <div className="w-24">
              <TimeInput value={f.at_time} onChange={(v) => setF({ ...f, at_time: v })} />
            </div>
          </Field>
        </div>
        {f.freq === 'weekly' && (
          <div>
            <div className="mb-1.5 text-xs font-medium text-muted">{t('recurring.on')}</div>
            <div className="flex flex-wrap gap-1">
              {days.map((d, i) => {
                const on = f.weekdays.includes(i + 1)
                return (
                  <button
                    type="button"
                    key={i}
                    onClick={() => setF({ ...f, weekdays: on ? f.weekdays.filter((x) => x !== i + 1) : [...f.weekdays, i + 1].sort() })}
                    className={clsx('min-w-11 rounded-md border px-2 py-1 text-xs cursor-pointer', on ? 'border-accent bg-accent text-white' : 'border-line hover:bg-black/5 dark:hover:bg-white/5')}
                  >
                    {d}
                  </button>
                )
              })}
            </div>
          </div>
        )}
        {f.freq === 'monthly' && (
          <Field label={t('recurring.onDay')} hint={t('recurring.onDayHint')}>
            <Input type="number" min={1} max={31} value={f.month_day} onChange={(e) => setF({ ...f, month_day: Math.max(1, Math.min(31, Number(e.target.value) || 1)) })} className="w-24" />
          </Field>
        )}
        <div>
          <div className="mb-1.5 text-xs font-medium text-muted">{t('recurring.assignees')}</div>
          <div className="flex flex-wrap gap-1">
            {data.members.map((m) => {
              const on = f.assignee_ids.includes(m.user_id)
              return (
                <button
                  type="button"
                  key={m.user_id}
                  onClick={() => setF({ ...f, assignee_ids: on ? f.assignee_ids.filter((x) => x !== m.user_id) : [...f.assignee_ids, m.user_id] })}
                  className={clsx('flex items-center gap-1 rounded-full border py-0.5 pl-0.5 pr-2 text-xs cursor-pointer', on ? 'border-accent bg-accent/10' : 'border-line')}
                >
                  <Avatar name={label(m)} color={m.avatar_color} src={avatarUrl(m.avatar_id)} size={18} />
                  {label(m)}
                </button>
              )
            })}
          </div>
        </div>
        <p className="rounded-md bg-black/[0.03] px-3 py-2 text-xs text-muted dark:bg-white/5">{describeRule({ ...f, at_time: f.at_time }, t, locale)}</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={save.isPending || !f.template_id || !f.list_id || (f.freq === 'weekly' && !f.weekdays.length)}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
