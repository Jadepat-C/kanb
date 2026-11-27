/**
 * A row of tabs that scrolls sideways when it doesn't fit: arrow buttons appear on the side(s) with more tabs, the
 * mouse wheel scrolls it sideways, phones swipe it, and the selected tab (aria-selected) is kept in view. No
 * scrollbar; the bottom line is a shadow, so nothing overflows downwards.
 */
import clsx from 'clsx'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

export function TabStrip({ children, selected, className }: { children: ReactNode; /** the selected tab's key: kept in view */ selected: string; className?: string }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState({ left: false, right: false })

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    // a pixel of slack: zoomed pages report fractional widths
    setMore({ left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 })
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    // the wheel scrolls the tabs sideways (only while they overflow; otherwise the page scrolls as usual)
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
      e.preventDefault()
      el.scrollBy({ left: e.deltaY })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      ro.disconnect()
      el.removeEventListener('wheel', onWheel)
    }
  }, [measure])

  // keep the selected tab visible (e.g. opened from a link to the last tab)
  useEffect(() => {
    const tab = ref.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    measure()
  }, [selected, measure])

  const page = (dir: 1 | -1) => {
    const el = ref.current
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.7, behavior: 'smooth' })
  }
  const arrow = (dir: 1 | -1) => (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden
      onClick={() => page(dir)}
      title={dir < 0 ? t('common.scrollLeft') : t('common.scrollRight')}
      className={clsx(
        'absolute inset-y-0 z-10 flex w-9 items-center text-muted hover:text-[var(--text)] cursor-pointer',
        dir < 0 ? 'left-0 justify-start bg-gradient-to-r' : 'right-0 justify-end bg-gradient-to-l',
        'from-[var(--bg)] from-55% to-transparent',
      )}
    >
      {dir < 0 ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
    </button>
  )
  return (
    <div className={clsx('relative', className)}>
      {more.left && arrow(-1)}
      <div
        ref={ref}
        role="tablist"
        onScroll={measure}
        className="flex items-center gap-1 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--border)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>
      {more.right && arrow(1)}
    </div>
  )
}
