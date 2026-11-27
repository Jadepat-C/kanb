import { useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Bell, CalendarDays, Camera, Code, KeyRound, Trash2, UserRound } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { CalendarFeed } from '../components/CalendarFeed'
import { ApiTokens } from '../components/ApiTokens'
import { NotificationPrefs } from '../components/ContactPoints'
import { TwoFactorSection } from '../components/TwoFactor'
import { SsoProfileSection, useMySso } from './Sso'
import { useDepartmentName } from '../lib/departments'
import { SessionList } from '../components/Sessions'
import { toast, toastError, toastSuccess } from '../components/toast'
import { Avatar, Button, ColorPicker, Field, Input, PasswordInput } from '../components/ui'
import { api, upload } from '../lib/api'
import { avatarUrl, label } from '../lib/user'
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
  const [next2, setNext2] = useState('')
  const mismatch = next2.length > 0 && next !== next2
  const save = useMutation({
    mutationFn: () =>
      api.patch<User>('/me', {
        display_name: name,
        email,
        avatar_color: color,
      }),
    onSuccess: (u) => (qc.setQueryData(['me'], u), toast(t('common.saved'))),
    onError: toastError,
  })
  const pw = useMutation({
    mutationFn: () => api.post('/me/password', { current_password: me?.has_password ? cur : undefined, new_password: next }),
    onSuccess: () => (setCur(''), setNext(''), setNext2(''), qc.invalidateQueries({ queryKey: ['me'] }), toast(t('profile.passwordChanged'))),
    onError: toastError,
  })
  const [sp, setSp] = useSearchParams()
  const sso = useMySso()
  const deptName = useDepartmentName()
  // single sign-on required: only super admins keep a password
  const passwordOff = !!sso.data?.required && !me?.is_super_admin
  const ssoName = sso.data?.providers.map((p) => p.label).join(' / ') || 'SSO'
  // old links pointed at #calendar-feed on the single long page
  const tab: Tab = TABS.find((k) => k === sp.get('tab')) ?? (location.hash === '#calendar-feed' ? 'calendar' : 'account')
  if (!me) return null
  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-6">
      <h1 className="mb-3 text-xl font-semibold">{t('profile.title')}</h1>
      <div role="tablist" className="mb-5 flex items-center gap-1 border-b border-line">
        {TABS.map((k) => {
          const Icon = {
            account: UserRound,
            security: KeyRound,
            notifications: Bell,
            calendar: CalendarDays,
            api: Code,
          }[k]
          return (
            <button
              key={k}
              role="tab"
              title={t(`profile.tab.${k}`)}
              aria-selected={tab === k}
              onClick={() => setSp(k === 'account' ? {} : { tab: k }, { replace: true })}
              className={clsx(
                '-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium cursor-pointer',
                tab === k ? 'border-accent text-[var(--text)]' : 'border-transparent text-muted hover:text-[var(--text)]',
              )}
            >
              <Icon size={15} />
              {/* on a phone only the open tab shows its name, so all four fit */}
              <span className={clsx(tab !== k && 'sr-only sm:not-sr-only')}>{t(`profile.tab.${k}`)}</span>
            </button>
          )
        })}
      </div>
      <div className="space-y-6">
        {tab === 'account' && (
          <section className="space-y-4 rounded-xl border border-line bg-surface p-5">
            <AvatarEditor me={me} name={name} color={color ?? me.avatar_color} />
            <Field label={t('admin.displayName')}>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label={t('admin.email')}>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            {deptName(me.department_id) && (
              <Field label={t('departments.one')} hint={t('departments.setByAdmin')}>
                <Input value={deptName(me.department_id)} readOnly disabled />
              </Field>
            )}
            <Field label={t('common.color')}>
              <ColorPicker value={color} onChange={setColor} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('nav.language')}>
                <select
                  value={me.locale}
                  onChange={(e) => prefs.mutate({ locale: e.target.value as Locale })}
                  className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm"
                >
                  <option value="en">English</option>
                  <option value="th">ไทย</option>
                </select>
              </Field>
              <Field label={t('nav.theme')}>
                <select
                  value={me.theme}
                  onChange={(e) => prefs.mutate({ theme: e.target.value as Theme })}
                  className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm"
                >
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
        )}
        {tab === 'security' && (
          <>
            <SsoProfileSection hasPassword={me.has_password} />
            {passwordOff ? (
              <section className="rounded-xl border border-line bg-surface p-5">
                <h2 className="font-semibold">{t('profile.changePassword')}</h2>
                <p className="mt-1 text-sm text-muted">{t('sso.passwordManaged', { label: ssoName })}</p>
              </section>
            ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (next === next2) pw.mutate()
              }}
              className="space-y-4 rounded-xl border border-line bg-surface p-5"
            >
              <h2 className="font-semibold">{t(me.has_password ? 'profile.changePassword' : 'sso.setPassword')}</h2>
              {me.has_password ? (
                <Field label={t('profile.currentPassword')}>
                  <PasswordInput value={cur} onChange={(e) => setCur(e.target.value)} required autoComplete="current-password" />
                </Field>
              ) : (
                <p className="text-sm text-muted">{t('sso.noPassword', { label: ssoName })}</p>
              )}
              <Field label={t('profile.newPassword')} hint={t('errors.password_too_short')}>
                <PasswordInput value={next} onChange={(e) => setNext(e.target.value)} required minLength={8} autoComplete="new-password" />
              </Field>
              <Field label={t('auth.confirmPassword')}>
                <PasswordInput value={next2} onChange={(e) => setNext2(e.target.value)} required minLength={8} autoComplete="new-password" />
              </Field>
              {mismatch && <p className="text-sm text-red-600">{t('auth.passwordsDiffer')}</p>}
              <Button variant="primary" disabled={pw.isPending || mismatch || next.length < 8 || next !== next2}>
                {t('common.save')}
              </Button>
            </form>
            )}
            <TwoFactorSection me={me} />
            <section className="space-y-3 rounded-xl border border-line bg-surface p-5">
              <h2 className="font-semibold">{t('devices.mine')}</h2>
              <p className="text-sm text-muted">{t('devices.mineHint')}</p>
              <SessionList />
            </section>
          </>
        )}
        {tab === 'notifications' && <NotificationPrefs me={me} />}
        {tab === 'calendar' && <CalendarFeed />}
        {tab === 'api' && <ApiTokens />}
      </div>
    </div>
  )
}

const TABS = ['account', 'security', 'notifications', 'calendar', 'api'] as const
type Tab = (typeof TABS)[number]

/** Profile picture: click or drop an image; the server crops it to a square and strips photo metadata. */
function AvatarEditor({ me, name, color }: { me: User; name: string; color: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  const send = async (file?: File | null) => {
    if (!file) return
    if (!file.type.startsWith('image/')) return toast(t('errors.not_an_image'), 'error')
    setBusy(true)
    try {
      const u = await upload<User>('/me/avatar', file, file.name)
      qc.setQueryData(['me'], u)
      qc.invalidateQueries({ queryKey: ['board'] })
      qc.invalidateQueries({ queryKey: ['boards'] })
      qc.invalidateQueries({ queryKey: ['users'] })
      toastSuccess(t('profile.pictureSaved'))
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }
  const remove = useMutation({
    mutationFn: () => api.del<User>('/me/avatar'),
    onSuccess: (u) => {
      qc.setQueryData(['me'], u)
      qc.invalidateQueries({ queryKey: ['board'] })
      qc.invalidateQueries({ queryKey: ['boards'] })
      qc.invalidateQueries({ queryKey: ['users'] })
      toastSuccess(t('profile.pictureRemoved'))
    },
    onError: toastError,
  })
  const preview = { ...me, display_name: name || me.display_name }
  return (
    <div className="flex items-center gap-4">
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          send(e.dataTransfer.files[0])
        }}
        className={'group relative shrink-0 rounded-full cursor-pointer ' + (over ? 'ring-2 ring-accent ring-offset-2' : '')}
        title={t('profile.changePicture')}
      >
        <Avatar name={label(preview)} color={color} src={avatarUrl(me.avatar_id)} size={72} />
        <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100">
          <Camera size={22} />
        </span>
        {busy && <span className="absolute inset-0 animate-pulse rounded-full bg-white/40" />}
      </button>
      <div className="min-w-0 space-y-1.5">
        <div className="truncate font-medium">{label(preview)}</div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={() => input.current?.click()} disabled={busy}>
            <Camera size={14} /> {me.avatar_id ? t('profile.changePicture') : t('profile.uploadPicture')}
          </Button>
          {me.avatar_id && (
            <Button type="button" size="sm" variant="ghost" onClick={() => remove.mutate()} disabled={busy}>
              <Trash2 size={14} /> {t('common.remove')}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted">{t('profile.pictureHint')}</p>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(e) => {
          send(e.target.files?.[0])
          e.target.value = ''
        }}
      />
    </div>
  )
}
