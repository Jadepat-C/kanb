import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { api } from './api'
import type { BoardDetail, CardSummary, Label, Member, Status } from './types'

export function useBoard(boardId: string) {
  const q = useQuery({ queryKey: ['board', boardId], queryFn: () => api.get<BoardDetail>(`/boards/${boardId}`) })
  const helpers = useMemo(() => {
    const d = q.data
    const labels = new Map<string, Label>((d?.labels ?? []).map((l) => [l.id, l]))
    const members = new Map<string, Member>((d?.members ?? []).map((m) => [m.user_id, m]))
    const statuses = new Map<string, Status>((d?.statuses ?? []).map((s) => [s.id, s]))
    const perms = new Set(d?.my_permissions ?? [])
    return { labels, members, statuses, can: (p: string) => perms.has(p) }
  }, [q.data])
  return { ...q, ...helpers }
}

export type BoardHelpers = ReturnType<typeof useBoard>

/** Sorted card ids per list (bytewise compare matches the server's COLLATE "C"). */
export function groupCards(cards: CardSummary[]): Record<string, string[]> {
  const out: Record<string, CardSummary[]> = {}
  for (const c of cards) (out[c.list_id] ??= []).push(c)
  const res: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(out)) {
    res[k] = v.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0)).map((c) => c.id)
  }
  return res
}

/** Live updates: the server pushes "something changed on this board"; we refetch what's affected. */
export function useBoardSocket(boardId: string) {
  const qc = useQueryClient()
  const [online, setOnline] = useState(false)
  useEffect(() => {
    let ws: WebSocket | null = null
    let retry = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/api/boards/${boardId}/ws`)
      ws.onopen = () => {
        retry = 0
        setOnline(true)
        qc.invalidateQueries({ queryKey: ['board', boardId] }) // catch up on anything missed
      }
      ws.onmessage = (m) => {
        try {
          const ev = JSON.parse(m.data) as { kind: string; card_id?: string | null }
          qc.invalidateQueries({ queryKey: ['board', boardId] })
          if (ev.card_id) {
            qc.invalidateQueries({ queryKey: ['card', ev.card_id] })
            qc.invalidateQueries({ queryKey: ['timeline', ev.card_id] })
          }
          if (ev.kind === 'board' || ev.kind === 'board_deleted') qc.invalidateQueries({ queryKey: ['boards'] })
        } catch {
          /* ignore */
        }
      }
      ws.onclose = () => {
        setOnline(false)
        if (stopped) return
        timer = setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++))
      }
    }
    connect()
    return () => {
      stopped = true
      clearTimeout(timer)
      ws?.close()
    }
  }, [boardId, qc])
  return online
}
