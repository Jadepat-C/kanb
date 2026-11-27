/** Profile → API: personal access tokens for scripts, and a link to the API reference. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, Copy, KeyRound, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { api } from '../lib/api'
import { copyText } from '../lib/clipboard'
import { fmtDate, fmtRelative } from '../lib/prefs'
import { ask } from './dialogs'
import { toast, toastError, toastSuccess } from './toast'
import { Button, Dialog, Field, Input } from './ui'

interface Token {
  id: string
  name: string
  prefix: string
  scope: 'read' | 'write'
  created_at: string
  last_used_at: string | null
  expires_at: string | null
}

export function ApiTokens() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['tokens'], queryFn: () => api.get<Token[]>('/me/tokens') })
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<string | null>(null)
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/me/tokens/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tokens'] }),
    onError: toastError,
  })
  const tokens = q.data ?? []
  return (
    <div className="space-y-4">
      <section className="space-y-3 rounded-xl border border-line bg-surface p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="font-semibold">{t('tokens.title')}</h2>
            <p className="mt-1 text-sm text-muted">{t('tokens.hint')}</p>
          </div>
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={15} /> {t('tokens.new')}
          </Button>
        </div>
        {created && (
          <div className="space-y-2 rounded-md border border-green-600/40 bg-green-500/10 p-3 text-sm">
            <p className="font-medium">{t('tokens.copyNow')}</p>
            <div className="flex gap-2">
              <Input value={created} readOnly className="font-mono text-xs" onFocus={(e) => e.target.select()} />
              <Button className="shrink-0" onClick={async () => toast((await copyText(created)) ? t('common.copied') : created)}>
                <Copy size={14} /> {t('common.copy')}
              </Button>
            </div>
          </div>
        )}
        {tokens.length === 0 ? (
          <p className="text-sm text-muted">{t('tokens.none')}</p>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {tokens.map((k) => {
              const expired = !!k.expires_at && new Date(k.expires_at) < new Date()
              return (
                <li key={k.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                  <KeyRound size={15} className="text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{k.name}</span>{' '}
                    <span className="rounded bg-black/5 px-1.5 py-px text-[11px] dark:bg-white/10">{t(`tokens.scope_${k.scope}`)}</span>
                    <span className="block text-xs text-muted">
                      <code>{k.prefix}…</code> · {t('tokens.created', { date: fmtDate(k.created_at) })} ·{' '}
                      {k.last_used_at ? t('tokens.used', { when: fmtRelative(k.last_used_at) }) : t('tokens.neverUsed')}
                      {k.expires_at && (
                        <span className={expired ? 'text-red-600' : undefined}> · {t(expired ? 'tokens.expired' : 'tokens.expires', { date: fmtDate(k.expires_at) })}</span>
                      )}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      const ok = await ask({ title: t('tokens.revokeTitle', { name: k.name }), message: t('tokens.revokeMsg'), confirmLabel: t('tokens.revoke'), danger: true })
                      if (ok) revoke.mutate(k.id)
                    }}
                  >
                    <Trash2 size={14} /> {t('tokens.revoke')}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
      <Link to="/help/api" className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline">
        <BookOpen size={15} /> {t('tokens.docs')}
      </Link>
      {creating && (
        <CreateToken
          onClose={() => setCreating(false)}
          onCreated={(tok) => {
            setCreating(false)
            setCreated(tok)
            qc.invalidateQueries({ queryKey: ['tokens'] })
            toastSuccess(t('tokens.createdToast'))
          }}
        />
      )}
    </div>
  )
}

function CreateToken({ onClose, onCreated }: { onClose: () => void; onCreated: (token: string) => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [scope, setScope] = useState<'read' | 'write'>('read')
  const [days, setDays] = useState('90')
  const m = useMutation({
    mutationFn: () => api.post<{ token: string }>('/me/tokens', { name, scope, expires_days: days ? Number(days) : null }),
    onSuccess: (r) => onCreated(r.token),
    onError: toastError,
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('tokens.new')}>
      <form
        className="space-y-3 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) m.mutate()
        }}
      >
        <Field label={t('common.name')} hint={t('tokens.nameHint')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={80} required />
        </Field>
        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-xs font-medium text-muted">{t('tokens.access')}</legend>
          {(['read', 'write'] as const).map((s) => (
            <label key={s} className="flex items-start gap-2 text-sm">
              <input type="radio" name="scope" checked={scope === s} onChange={() => setScope(s)} className="mt-1 accent-[var(--color-accent)]" />
              <span>
                {t(`tokens.scope_${s}`)}
                <span className="block text-xs text-muted">{t(`tokens.scope_${s}Hint`)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Field label={t('tokens.expiry')}>
          <select value={days} onChange={(e) => setDays(e.target.value)} className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm">
            {['30', '90', '365'].map((d) => (
              <option key={d} value={d}>
                {t('tokens.days', { count: Number(d) })}
              </option>
            ))}
            <option value="">{t('tokens.never')}</option>
          </select>
        </Field>
        <p className="text-xs text-muted">{t('tokens.limits')}</p>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!name.trim() || m.isPending}>
            {t('common.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
