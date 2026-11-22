import { useQuery } from '@tanstack/react-query'
import { Command } from 'cmdk'
import { Search, SquareKanban } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { api } from '../lib/api'
import type { SearchResult } from '../lib/types'
import { Dialog } from './ui'

function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = useState(v)
  useEffect(() => {
    const h = setTimeout(() => setD(v), ms)
    return () => clearTimeout(h)
  }, [v, ms])
  return d
}

/** Ctrl/Cmd+K: server-side search over every board the user can see (title, description, #number). */
export function SearchPalette() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const dq = useDebounced(q.trim(), 200)
  const nav = useNavigate()

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      // inside the Markdown editor Ctrl+K means "insert link" (it marks the event as handled)
      if (e.defaultPrevented || (e.target as HTMLElement | null)?.closest?.('.cm-editor')) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const { data, isFetching } = useQuery({
    queryKey: ['search', dq],
    queryFn: () => api.get<SearchResult>(`/search?q=${encodeURIComponent(dq)}`),
    enabled: open && dq.length > 0,
    placeholderData: (p) => p,
  })

  const go = (path: string) => {
    setOpen(false)
    setQ('')
    nav(path)
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex h-8 w-full max-w-md items-center gap-2 rounded-md border border-line bg-surface-2 px-3 text-sm text-muted hover:border-accent/50 cursor-pointer"
      >
        <Search size={15} />
        <span className="truncate">{t('search.placeholder')}</span>
        <kbd className="ml-auto hidden rounded border border-line px-1.5 text-[10px] sm:inline">Ctrl K</kbd>
      </button>
      <Dialog open={open} onOpenChange={setOpen} wide>
        <Command shouldFilter={false} className="flex flex-col" label={t('search.hint')}>
          <div className="flex items-center gap-2 border-b border-line px-4">
            <Search size={18} className="text-muted" />
            <Command.Input
              value={q}
              onValueChange={setQ}
              autoFocus
              placeholder={t('search.placeholder')}
              className="h-12 flex-1 bg-transparent text-base outline-none"
            />
            {isFetching && <span className="text-xs text-muted">…</span>}
          </div>
          <Command.List className="max-h-[60dvh] overflow-y-auto p-2">
            {dq && data && data.boards.length === 0 && data.cards.length === 0 && (
              <Command.Empty className="p-6 text-center text-sm text-muted">{t('search.noResults')}</Command.Empty>
            )}
            {data && data.boards.length > 0 && (
              <Command.Group heading={t('search.boards')} className="mb-2 text-xs text-muted [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1">
                {data.boards.map((b) => (
                  <Command.Item
                    key={b.id}
                    value={`b-${b.id}`}
                    onSelect={() => go(`/b/${b.id}`)}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm text-[var(--text)]"
                  >
                    <SquareKanban size={16} style={{ color: b.color }} />
                    {b.name}
                  </Command.Item>
                ))}
              </Command.Group>
            )}
            {data && data.cards.length > 0 && (
              <Command.Group heading={t('search.cards')} className="text-xs text-muted [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1">
                {data.cards.map((c) => (
                  <Command.Item
                    key={c.id}
                    value={`c-${c.id}`}
                    onSelect={() => go(`/b/${c.board_id}?card=${c.id}`)}
                    className="cursor-pointer rounded-md px-2 py-2 text-sm text-[var(--text)]"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted">#{c.number}</span>
                      <span className="font-medium">{c.title}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted">
                        {c.board_name} · {c.list_name}
                      </span>
                    </div>
                    {c.snippet && <div className="mt-0.5 line-clamp-1 text-xs text-muted">{c.snippet.replace(/\s+/g, ' ')}</div>}
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </Dialog>
    </>
  )
}
