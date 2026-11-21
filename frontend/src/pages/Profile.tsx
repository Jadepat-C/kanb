import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast, toastError } from '../components/toast'
import { Avatar, Button, ColorPicker, Field, Input } from '../components/ui'
import { api } from '../lib/api'
import { useMe, useUpdatePrefs } from '../lib/auth'
import type { Locale, Theme, User } from '../lib/types'

export function Profile() {
  const { t } = useTranslation()
  const { data: me } = useMe()
  const qc = useQueryClient()
  const prefs = useUpdatePrefs()
  const [name, setName] = useState(me?.display_name ?? '')
  const [email, setEmail] = useState(me?.email ?? '')
  const [color, setColor] = useState<string | null>(me?.avatar_color ?? null)
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const save = useMutation({
    mutationFn: () => api.patch<User>('/me', { display_name: name, email, avatar_color: color }),
    onSuccess: (u) => (qc.setQueryData(['me'], u), toast(t('common.saved'))),
    onError: toastError,
  })
  const pw = useMutation({
    mutationFn: () => api.post('/me/password', { current_password: cur, new_password: next }),
    onSuccess: () => (setCur(''), setNext(''), toast(t('profile.passwordChanged'))),
    onError: toastError,
  })
  if (!me) return null
  return (
    <div className="mx-auto max-w-xl space-y-8 p-4 sm:p-6">
      <h1 className="text-xl font-semibold">{t('profile.title')}</h1>
      <section className="space-y-4 rounded-xl border border-line bg-surface p-5">
        <div className="flex items-center gap-3">
          <Avatar name={name || me.username} color={color ?? me.avatar_color} size={44} />
          <div className="text-sm text-muted">@{me.username}</div>
        </div>
        <Field label={t('admin.displayName')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('admin.email')}>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={t('common.color')}>
          <ColorPicker value={color} onChange={setColor} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('nav.language')}>
            <select value={me.locale} onChange={(e) => prefs.mutate({ locale: e.target.value as Locale })} className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm">
              <option value="en">English</option>
              <option value="th">ไทย</option>
            </select>
          </Field>
          <Field label={t('nav.theme')}>
            <select value={me.theme} onChange={(e) => prefs.mutate({ theme: e.target.value as Theme })} className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm">
              {(['light', 'dark', 'system'] as Theme[]).map((th) => (
                <option key={th} value={th}>
                  {t(`theme.${th}`)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>
          {t('common.save')}
        </Button>
      </section>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          pw.mutate()
        }}
        className="space-y-4 rounded-xl border border-line bg-surface p-5"
      >
        <h2 className="font-semibold">{t('profile.changePassword')}</h2>
        <Field label={t('profile.currentPassword')}>
          <Input type="password" value={cur} onChange={(e) => setCur(e.target.value)} required autoComplete="current-password" />
        </Field>
        <Field label={t('profile.newPassword')} hint={t('errors.password_too_short')}>
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={8} autoComplete="new-password" />
        </Field>
        <Button variant="primary" disabled={pw.isPending}>
          {t('common.save')}
        </Button>
      </form>
    </div>
  )
}
