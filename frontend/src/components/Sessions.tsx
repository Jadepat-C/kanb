/** Signed-in devices of one account, with "Sign out" per device and "Sign out everywhere" (admin page and Profile). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LogOut } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api'
import { fmtDate, fmtRelative } from '../lib/prefs'
import { ask } from './dialogs'
import { toastError, toastSuccess } from './toast'
import { Button, Spinner } from './ui'

interface Session {
  id: string
  created_at: string
  last_seen_at: string
  device: string
  ip: string | null
  current: boolean
}

/**
 * `userId` = an admin looking at someone's devices; without it, your own (where "Sign out everywhere" keeps this
 * browser signed in).
 */
export function SessionList({ userId, name }: { userId?: string; name?: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const base = userId ? `/admin/users/${userId}/sessions` : '/me/sessions'
  const key = ['sessions', userId ?? 'me']
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Session[]>(base) })
  const done = (n: number) => {
    qc.invalidateQueries({ queryKey: key })
    qc.invalidateQueries({ queryKey: ['admin-audit'] })
    toastSuccess(t('devices.signedOut', { count: n }))
  }
  const all = useMutation({ mutationFn: () => api.del<{ signed_out: number }>(base), onSuccess: (r) => done(r.signed_out), onError: toastError })
  const one = useMutation({
    mutationFn: (id: string) => api.del(userId ? `/admin/sessions/${id}` : `/me/sessions/${id}`),
    onSuccess: () => done(1),
    onError: toastError,
  })
  const others = (q.data ?? []).filter((s) => !s.current).length
  return (
    <div className="space-y-3">
      {q.isLoading ? (
        <Spinner />
      ) : !q.data?.length ? (
        <p className="text-sm text-muted">{t('devices.none')}</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-lg border border-line">
          {q.data.map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {s.device}
                  {s.current && <span className="ml-1.5 text-xs font-normal text-muted">({t('devices.thisOne')})</span>}
                </div>
                <div className="text-xs text-muted">
                  {t('devices.lastActive', { when: fmtRelative(s.last_seen_at) })} · {t('devices.since', { when: fmtDate(s.created_at) })}
                  {s.ip && <span className="font-mono"> · {s.ip}</span>}
                </div>
              </div>
              {!s.current && (
                <Button size="sm" onClick={() => one.mutate(s.id)} disabled={one.isPending}>
                  {t('devices.signOut')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Button
        variant="danger"
        disabled={!others || all.isPending}
        onClick={async () => {
          const message = userId ? t('devices.signOutAllMsg', { name }) : t('devices.signOutOthersMsg')
          const label = userId ? t('devices.signOutAll') : t('devices.signOutOthers')
          if (await ask({ title: label, message, confirmLabel: label, danger: true })) all.mutate()
        }}
      >
        <LogOut size={14} /> {userId ? t('devices.signOutAll') : t('devices.signOutOthers')}
      </Button>
    </div>
  )
}
