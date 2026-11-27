/**
 * Cards selected on the board (Ctrl/⌘/Shift-click, or "Select" in a card's menu), for changing several at once.
 * A tiny external store: each tile subscribes to its own "am I selected", so selecting one card re-renders one tile,
 * not the whole board.
 */
import { useSyncExternalStore } from 'react'

let ids: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export const selection = {
  has: (id: string) => ids.has(id),
  size: () => ids.size,
  toggle(id: string) {
    const next = new Set(ids)
    if (!next.delete(id)) next.add(id)
    ids = next
    emit()
  },
  set(next: Iterable<string>) {
    ids = new Set(next)
    emit()
  },
  clear() {
    if (ids.size === 0) return
    ids = new Set()
    emit()
  },
}

/** Is this card selected (re-renders only when that changes). */
export const useSelected = (id: string) => useSyncExternalStore(subscribe, () => ids.has(id))
/** Every selected id. */
export const useSelection = () => useSyncExternalStore(subscribe, () => ids)
