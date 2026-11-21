import clsx from 'clsx'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { Popover as RPopover } from 'radix-ui'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { yearOffset } from '../lib/prefs'

/**
 * Date and time fields that always use dd/mm/yyyy and a 24-hour clock, whatever the browser's language
 * (the browser's own <input type="date"> follows the browser locale, e.g. mm/dd/yyyy in US English).
 * Values: date "YYYY-MM-DD", time "HH:mm". Thai shows and accepts the Buddhist-era year (2569 = 2026).
 */

const pad = (n: number) => String(n).padStart(2, '0')
export const toYmd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const fromYmd = (s: string) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** "YYYY-MM-DD" → "dd/mm/yyyy" (Buddhist year in Thai). */
export function showYmd(ymd: string) {
  if (!ymd) return ''
  const [y, m, d] = ymd.split('-').map(Number)
  return `${pad(d)}/${pad(m)}/${y + yearOffset()}`
}

/** "21/11/2026", "21/11/26", "21-11-2569", "211126" → "YYYY-MM-DD" (null if not a real date). */
export function parseDmy(text: string): string | null {
  const t = text.trim()
  let m = t.match(/^(\d{1,2})\D+(\d{1,2})\D+(\d{2,4})$/)
  if (!m && /^\d{6}$|^\d{8}$/.test(t)) m = [t, t.slice(0, 2), t.slice(2, 4), t.slice(4)] as unknown as RegExpMatchArray
  if (!m) return null
  let [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (y < 100) y += 2000
  if (y > 2400) y -= 543 // Buddhist era
  const date = new Date(y, mo - 1, d)
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null
  return toYmd(date)
}

/** "9", "930", "9:30", "09.30", "21:05" → "HH:mm" (null if invalid). */
export function parseTime(text: string): string | null {
  const t = text.trim().replace('.', ':')
  const m = t.match(/^(\d{1,2})(?::?(\d{2}))?$/)
  if (!m) return null
  const [h, mi] = [Number(m[1]), Number(m[2] ?? 0)]
  if (h > 23 || mi > 59) return null
  return `${pad(h)}:${pad(mi)}`
}

const field =
  'h-9 w-full rounded-md border border-line bg-surface px-2.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/30 disabled:opacity-60'

export function DateInput({
  value,
  onChange,
  disabled,
  className,
  placeholder,
  ariaLabel,
}: {
  value: string
  onChange: (ymd: string) => void
  disabled?: boolean
  className?: string
  placeholder?: string
  ariaLabel?: string
}) {
  const { t, i18n } = useTranslation()
  const [text, setText] = useState(showYmd(value))
  const [open, setOpen] = useState(false)
  const [month, setMonth] = useState(() => (value ? fromYmd(value) : new Date()))
  useEffect(() => setText(showYmd(value)), [value, i18n.language])
  const commit = () => {
    if (!text.trim()) return value && onChange('')
    const ymd = parseDmy(text)
    if (ymd) {
      setText(showYmd(ymd))
      if (ymd !== value) onChange(ymd)
    } else setText(showYmd(value)) // not a date: put the old one back
  }
  const loc = i18n.language === 'th' ? 'th-TH' : 'en-GB'
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const start = new Date(first)
  start.setDate(1 - ((first.getDay() + 6) % 7)) // weeks start on Monday
  const cells = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
  const today = toYmd(new Date())
  return (
    <RPopover.Root open={open} onOpenChange={(o) => (setOpen(o), o && setMonth(value ? fromYmd(value) : new Date()))}>
      <div className={clsx('relative', className)}>
        <input
          value={text}
          disabled={disabled}
          aria-label={ariaLabel}
          placeholder={placeholder ?? t('date.placeholder')}
          inputMode="numeric"
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), commit())}
          className={clsx(field, 'pr-8 tabular-nums')}
        />
        <RPopover.Trigger asChild disabled={disabled}>
          <button type="button" aria-label={t('date.pick')} className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:text-[var(--text)] disabled:opacity-40 cursor-pointer">
            <CalendarDays size={15} />
          </button>
        </RPopover.Trigger>
      </div>
      <RPopover.Portal>
        <RPopover.Content align="start" sideOffset={4} collisionPadding={8} className="z-[60] w-64 rounded-lg border border-line bg-surface p-2 text-sm shadow-lg outline-none">
          <div className="mb-1 flex items-center">
            <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} className="rounded p-1 hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer" aria-label={t('gantt.earlier')}>
              <ChevronLeft size={15} />
            </button>
            <span className="flex-1 text-center font-medium">{month.toLocaleDateString(loc, { month: 'long', year: 'numeric' })}</span>
            <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} className="rounded p-1 hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer" aria-label={t('gantt.later')}>
              <ChevronRight size={15} />
            </button>
          </div>
          <div className="grid grid-cols-7 text-center text-[10px] text-muted">
            {cells.slice(0, 7).map((d) => (
              <span key={d.getDay()}>{d.toLocaleDateString(loc, { weekday: 'narrow' })}</span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {cells.map((d) => {
              const ymd = toYmd(d)
              return (
                <button
                  type="button"
                  key={ymd}
                  onClick={() => (onChange(ymd), setText(showYmd(ymd)), setOpen(false))}
                  className={clsx(
                    'h-8 rounded text-xs tabular-nums cursor-pointer',
                    d.getMonth() !== month.getMonth() && 'text-muted/60',
                    ymd === value ? 'bg-accent font-semibold text-white' : 'hover:bg-black/5 dark:hover:bg-white/10',
                    ymd === today && ymd !== value && 'ring-1 ring-accent',
                  )}
                >
                  {d.getDate()}
                </button>
              )
            })}
          </div>
          <div className="mt-1 flex justify-between border-t border-line pt-1 text-xs">
            <button type="button" className="rounded px-2 py-1 text-accent hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer" onClick={() => (onChange(today), setText(showYmd(today)), setOpen(false))}>
              {t('gantt.today')}
            </button>
            {value && (
              <button type="button" className="rounded px-2 py-1 text-muted hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer" onClick={() => (onChange(''), setText(''), setOpen(false))}>
                {t('common.clear')}
              </button>
            )}
          </div>
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  )
}

/** 24-hour time, typed: "9", "930", "9:30" all work. */
export function TimeInput({ value, onChange, disabled, className }: { value: string; onChange: (hhmm: string) => void; disabled?: boolean; className?: string }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const commit = () => {
    const v = parseTime(text)
    if (v) {
      setText(v)
      if (v !== value) onChange(v)
    } else setText(value)
  }
  return (
    <input
      value={text}
      disabled={disabled}
      placeholder="HH:mm"
      inputMode="numeric"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), commit())}
      className={clsx(field, 'tabular-nums', className)}
    />
  )
}

/** Date + time for an ISO timestamp (null = no date). A new date gets `defaultTime`. */
export function DateTimeInput({
  value,
  onChange,
  disabled,
  defaultTime = '09:00',
}: {
  value: string | null
  onChange: (iso: string | null) => void
  disabled?: boolean
  defaultTime?: string
}) {
  const d = value ? new Date(value) : null
  const ymd = d ? toYmd(d) : ''
  const hhmm = d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : ''
  const emit = (date: string, time: string) => {
    if (!date) return onChange(null)
    const [h, m] = (time || defaultTime).split(':').map(Number)
    const x = fromYmd(date)
    x.setHours(h, m, 0, 0)
    onChange(x.toISOString())
  }
  return (
    <div className="flex gap-1">
      <DateInput value={ymd} onChange={(v) => emit(v, hhmm)} disabled={disabled} className="min-w-0 flex-1" />
      <div className="w-[4.25rem] shrink-0">
        <TimeInput value={hhmm} onChange={(v) => emit(ymd, v)} disabled={disabled || !ymd} />
      </div>
    </div>
  )
}
