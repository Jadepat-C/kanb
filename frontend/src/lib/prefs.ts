import i18n from './i18n'
import type { Theme } from './types'

const media = window.matchMedia('(prefers-color-scheme: dark)')
let current: Theme = 'system'

function apply() {
  const dark = current === 'dark' || (current === 'system' && media.matches)
  document.documentElement.classList.toggle('dark', dark)
}
media.addEventListener('change', apply)

export function setTheme(t: Theme) {
  current = t
  try {
    localStorage.setItem('theme', t)
  } catch {
    /* ignore */
  }
  apply()
}

export function getTheme(): Theme {
  try {
    return (localStorage.getItem('theme') as Theme) || 'system'
  } catch {
    return 'system'
  }
}
current = getTheme()

export const isDark = () => document.documentElement.classList.contains('dark')

/** Thai UI shows Buddhist-era years (พ.ศ.), as Thai users expect; English uses Gregorian. */
const loc = () => (i18n.language === 'th' ? 'th-TH' : 'en-GB')

export function fmtDate(iso: string, withTime = false) {
  const d = new Date(iso)
  return d.toLocaleDateString(loc(), {
    day: 'numeric',
    month: 'short',
    year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  })
}

export function fmtRelative(iso: string) {
  const diff = (new Date(iso).getTime() - Date.now()) / 1000
  const rtf = new Intl.RelativeTimeFormat(loc(), { numeric: 'auto' })
  const abs = Math.abs(diff)
  if (abs < 60) return rtf.format(Math.round(diff), 'second')
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day')
  return fmtDate(iso, true)
}

export function fmtSize(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
