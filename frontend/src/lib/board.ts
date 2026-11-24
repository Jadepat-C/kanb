import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import { useMe } from './auth'
import type { BoardDetail, CardSummary, Label, Member, Status } from './types'

/** Permissions that a role's "only cards they created" setting narrows to the member's own cards (as on the server). */
const OWN_SCOPED = new Set([
  'cards.edit',
  'cards.status',
  'cards.due',
  'cards.dependencies',
  'cards.assign',
  'cards.labels',
  'cards.move',
  'cards.archive',
  'cards.delete',
  'attachments.upload',
  'attachments.delete',
])

export function useBoard(boardId: string) {
  const q = useQuery({ queryKey: ['board', boardId], queryFn: () => api.get<BoardDetail>(`/boards/${boardId}`) })
  const me = useMe().data?.id
  const helpers = useMemo(() => {
    const d = q.data
    const labels = new Map<string, Label>((d?.labels ?? []).map((l) => [l.id, l]))
    const members = new Map<string, Member>((d?.members ?? []).map((m) => [m.user_id, m]))
    const statuses = new Map<string, Status>((d?.statuses ?? []).map((s) => [s.id, s]))
    const perms = new Set(d?.my_permissions ?? [])
    const own = !!d?.my_own_cards_only
    const createIn = d?.my_card_list_ids ? new Set(d.my_card_list_ids) : null
    const limited = (p: string) => own && OWN_SCOPED.has(p)
    return {
      labels,
      members,
      statuses,
      /** holds the permission at all (for some cards at least); use canCard for one card */
      can: (p: string) => perms.has(p),
      /** the permission on this card (roles limited to their own cards) */
      canCard: (p: string, card: { created_by: string | null } | null | undefined) =>
        perms.has(p) && (!limited(p) || (!!card && !!me && card.created_by === me)),
      /** the permission on every card, e.g. to sort a whole column */
      canAll: (p: string) => perms.has(p) && !limited(p),
      /** may add cards to this column */
      canCreateIn: (listId: string) => perms.has('cards.create') && (!createIn || createIn.has(listId)),
    }
  }, [q.data, me])
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

export interface Viewer {
  conn: string
  user_id: string
  display_name: string
  username: string
  avatar_color: string
  avatar_id: string | null
  card_id: string | null
  editing: boolean
}

export interface ChangeEvent {
  kind: string
  card_id: string | null
  actor_id: string | null
}

/**
 * Live updates + presence over one WebSocket per board.
 * - change events: refetch what's affected, and hand the event to `onChange` (for "X did Y" toasts)
 * - presence: who else is here, which card they have open, whether they're typing
 * Call `report({ card_id, editing })` whenever your own position changes; it's re-sent after reconnects.
 */
export function useBoardSocket(boardId: string, onChange?: (ev: ChangeEvent) => void) {
  const qc = useQueryClient()
  const [online, setOnline] = useState(false)
  const [viewers, setViewers] = useState<Viewer[]>([])
  const wsRef = useRef<WebSocket | null>(null)
  const mine = useRef<{ card_id: string | null; editing: boolean }>({ card_id: null, editing: false })
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    let ws: WebSocket | null = null
    let retry = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    // Coalesce board refreshes: every change would otherwise make every viewer re-download the whole board (and
    // cancel one already on its way). At most one refresh is in flight; changes arriving meanwhile, or in the same
    // short burst (a drag sends several), are folded into a single follow-up.
    let refreshing = false
    let again = false
    const refreshBoard = () => {
      if (refreshing) {
        again = true
        return
      }
      refreshing = true
      setTimeout(async () => {
        try {
          await qc.invalidateQueries({ queryKey: ['board', boardId] }, { cancelRefetch: false })
        } finally {
          refreshing = false
          if (again && !stopped) {
            again = false
            refreshBoard()
          }
        }
      }, 300)
    }
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/api/boards/${boardId}/ws`)
      wsRef.current = ws
      ws.onopen = () => {
        retry = 0
        setOnline(true)
        ws?.send(JSON.stringify(mine.current))
        qc.invalidateQueries({ queryKey: ['board', boardId] }) // catch up on anything missed
      }
      ws.onmessage = (m) => {
        try {
          const ev = JSON.parse(m.data)
          if (ev.type === 'presence') {
            setViewers(ev.viewers as Viewer[])
            return
          }
          onChangeRef.current?.(ev as ChangeEvent)
          refreshBoard()
          if (ev.card_id) {
            qc.invalidateQueries({ queryKey: ['card', ev.card_id] })
            qc.invalidateQueries({ queryKey: ['timeline', ev.card_id] })
          }
          if (ev.kind === 'list') qc.invalidateQueries({ queryKey: ['archived-lists', boardId] })
          if (ev.kind === 'board' || ev.kind === 'board_deleted') qc.invalidateQueries({ queryKey: ['boards'] })
        } catch {
          /* ignore */
        }
      }
      ws.onclose = () => {
        setOnline(false)
        setViewers([])
        if (stopped) return
        // the server also closes it when this session was signed out: checking /me then shows the sign-in page
        qc.invalidateQueries({ queryKey: ['me'] })
        timer = setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++))
      }
    }
    connect()
    return () => {
      stopped = true
      clearTimeout(timer)
      ws?.close()
      wsRef.current = null
    }
  }, [boardId, qc])

  const report = useCallback((p: { card_id: string | null; editing: boolean }) => {
    if (p.card_id === mine.current.card_id && p.editing === mine.current.editing) return
    mine.current = p
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(p))
  }, [])

  return { online, viewers, report }
}
