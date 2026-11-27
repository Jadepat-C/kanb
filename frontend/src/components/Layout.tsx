import { useQueryClient } from '@tanstack/react-query'
import { CalendarDays, Check, LayoutGrid, LayoutTemplate, Languages, LogOut, Monitor, Moon, ShieldCheck, Sun, UserCog } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Outlet, useNavigate } from 'react-router'
import { api } from '../lib/api'
import { useMe, useUpdatePrefs } from '../lib/auth'
import type { Locale, Theme } from '../lib/types'
import { avatarUrl, label } from '../lib/user'
import { NotificationBell } from './NotificationBell'
import { TimerChip } from './TimeTracking'
import { SearchPalette } from './SearchPalette'
import { AnnouncementBanner } from '../pages/AdminTools'
import { Avatar, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from './ui'

export function Layout() {
  const { t, i18n } = useTranslation()
  const { data: me } = useMe()
  const prefs = useUpdatePrefs()
  const qc = useQueryClient()
  const nav = useNavigate()
  if (!me) return null

  const logout = async () => {
    await api.post('/auth/logout')
    qc.clear()
    qc.setQueryData(['me'], null)
    nav('/login')
  }

  return (
    <div className="flex h-full flex-col">
      {/* three columns so the search sits in the true centre of the screen whatever the sides hold */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 sm:px-4 md:grid md:grid-cols-[1fr_minmax(0,18rem)_1fr] xl:grid-cols-[1fr_minmax(0,28rem)_1fr]">
        <div className="flex min-w-0 items-center gap-3">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <img src="/favicon.svg" alt="" className="h-6 w-6" />
            <span className="hidden xl:inline">{t('app.name')}</span>
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <NavLink to="/" icon={<LayoutGrid size={15} />} text={t('nav.boards')} />
            <NavLink to="/calendar" icon={<CalendarDays size={15} />} text={t('nav.calendar')} />
            <NavLink to="/templates" icon={<LayoutTemplate size={15} />} text={t('nav.templates')} />
          </nav>
        </div>
        <div className="flex min-w-0 flex-1 justify-center">
          <SearchPalette />
        </div>
        <div className="flex items-center justify-end gap-2">
          <TimerChip />
          <NotificationBell />
          <Menu>
            <MenuTrigger className="cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent" title={label(me)}>
              <Avatar name={label(me)} color={me.avatar_color} src={avatarUrl(me.avatar_id)} size={28} />
            </MenuTrigger>
            <MenuContent>
              <MenuLabel>{label(me)}</MenuLabel>
              <MenuItem onSelect={() => nav('/profile')}>
                <UserCog size={14} />
                {t('nav.profile')}
              </MenuItem>
              {me.is_super_admin && (
                <MenuItem onSelect={() => nav('/admin')}>
                  <ShieldCheck size={14} />
                  {t('nav.admin')}
                </MenuItem>
              )}
              <MenuSeparator />
              <MenuLabel>{t('nav.language')}</MenuLabel>
              {(['en', 'th'] as Locale[]).map((l) => (
                <MenuItem key={l} onSelect={() => prefs.mutate({ locale: l })}>
                  <Languages size={14} />
                  {l === 'th' ? 'ไทย' : 'English'}
                  {i18n.language === l && <Check size={14} className="ml-auto text-accent" />}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuLabel>{t('nav.theme')}</MenuLabel>
              {(['light', 'dark', 'system'] as Theme[]).map((th) => (
                <MenuItem key={th} onSelect={() => prefs.mutate({ theme: th })}>
                  {th === 'light' ? <Sun size={14} /> : th === 'dark' ? <Moon size={14} /> : <Monitor size={14} />}
                  {t(`theme.${th}`)}
                  {me.theme === th && <Check size={14} className="ml-auto text-accent" />}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem onSelect={logout}>
                <LogOut size={14} />
                {t('auth.signOut')}
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </header>
      <AnnouncementBanner />
      <main className="min-h-0 flex-1">
        <Outlet />
      </main>
    </div>
  )
}

function NavLink({ to, icon, text }: { to: string; icon: ReactNode; text: string }) {
  return (
    <Link to={to} title={text} className="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-black/5 dark:hover:bg-white/10">
      {icon}
      <span className="hidden sm:inline md:hidden lg:inline">{text}</span>
    </Link>
  )
}
