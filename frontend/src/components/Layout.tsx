import { useQueryClient } from '@tanstack/react-query'
import { CalendarDays, Check, LayoutGrid, Languages, LogOut, Monitor, Moon, ShieldCheck, Sun, UserCog } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, Outlet, useNavigate } from 'react-router'
import { api } from '../lib/api'
import { useMe, useUpdatePrefs } from '../lib/auth'
import type { Locale, Theme } from '../lib/types'
import { avatarUrl, label } from '../lib/user'
import { SearchPalette } from './SearchPalette'
import { Avatar, Button, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from './ui'

export function Layout() {
  const { t, i18n } = useTranslation()
  const { data: me } = useMe()
  const prefs = useUpdatePrefs()
  const qc = useQueryClient()
  const nav = useNavigate()
  if (!me) return null
  const theme = me.theme
  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor

  const logout = async () => {
    await api.post('/auth/logout')
    qc.clear()
    qc.setQueryData(['me'], null)
    nav('/login')
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 sm:px-4">
        <Link to="/" className="flex items-center gap-2 font-semibold">
          <img src="/favicon.svg" alt="" className="h-6 w-6" />
          <span className="hidden sm:inline">{t('app.name')}</span>
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          <Link to="/" className="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-black/5 dark:hover:bg-white/10">
            <LayoutGrid size={15} />
            <span className="hidden sm:inline">{t('nav.boards')}</span>
          </Link>
          <Link to="/calendar" className="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-black/5 dark:hover:bg-white/10">
            <CalendarDays size={15} />
            <span className="hidden sm:inline">{t('nav.calendar')}</span>
          </Link>
          {me.is_super_admin && (
            <Link to="/admin" className="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-black/5 dark:hover:bg-white/10">
              <ShieldCheck size={15} />
              <span className="hidden sm:inline">{t('nav.admin')}</span>
            </Link>
          )}
        </nav>
        <div className="flex flex-1 justify-center">
          <SearchPalette />
        </div>
        <Button
          variant="ghost"
          size="sm"
          title={t('nav.language')}
          onClick={() => prefs.mutate({ locale: (i18n.language === 'th' ? 'en' : 'th') as Locale })}
        >
          <Languages size={15} />
          {i18n.language === 'th' ? 'ไทย' : 'EN'}
        </Button>
        <Menu>
          <MenuTrigger asChild>
            <Button variant="ghost" size="sm" title={t('nav.theme')}>
              <ThemeIcon size={15} />
            </Button>
          </MenuTrigger>
          <MenuContent>
            {(['light', 'dark', 'system'] as Theme[]).map((th) => (
              <MenuItem key={th} onSelect={() => prefs.mutate({ theme: th })}>
                {th === 'light' ? <Sun size={14} /> : th === 'dark' ? <Moon size={14} /> : <Monitor size={14} />}
                {t(`theme.${th}`)}
                {theme === th && <Check size={14} className="ml-auto" />}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
        <Menu>
          <MenuTrigger className="cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent">
            <Avatar name={label(me)} color={me.avatar_color} src={avatarUrl(me.avatar_id)} size={28} />
          </MenuTrigger>
          <MenuContent>
            <MenuLabel>
              {label(me)}
            </MenuLabel>
            <MenuSeparator />
            <MenuItem onSelect={() => nav('/profile')}>
              <UserCog size={14} />
              {t('nav.profile')}
            </MenuItem>
            <MenuItem onSelect={logout}>
              <LogOut size={14} />
              {t('auth.signOut')}
            </MenuItem>
          </MenuContent>
        </Menu>
      </header>
      <main className="min-h-0 flex-1">
        <Outlet />
      </main>
    </div>
  )
}
