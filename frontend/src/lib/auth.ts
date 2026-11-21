import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { api, ApiError } from './api'
import { setLocale } from './i18n'
import { setTheme } from './prefs'
import type { Locale, Theme, User } from './types'

export function useMe() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.get<User>('/me')
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null
        throw e
      }
    },
    staleTime: 60_000,
  })
  useEffect(() => {
    const h = () => qc.setQueryData(['me'], null)
    window.addEventListener('kanban:unauthorized', h)
    return () => window.removeEventListener('kanban:unauthorized', h)
  }, [qc])
  // the server-side preference wins once signed in
  useEffect(() => {
    if (q.data) {
      setTheme(q.data.theme)
      setLocale(q.data.locale)
    }
  }, [q.data?.theme, q.data?.locale]) // eslint-disable-line react-hooks/exhaustive-deps
  return q
}

export function useUpdatePrefs() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (p: { theme?: Theme; locale?: Locale }) => {
      if (p.theme) setTheme(p.theme)
      if (p.locale) setLocale(p.locale)
      return api.patch<User>('/me', p)
    },
    onSuccess: (u) => qc.setQueryData(['me'], u),
  })
}
