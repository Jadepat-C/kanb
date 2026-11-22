import { KeyboardSensor, PointerSensor, TouchSensor, useSensor, useSensors, type KeyboardSensorOptions, type PointerSensorOptions } from '@dnd-kit/core'
import { useEffect, useState, type PointerEvent } from 'react'

/** Mouse and pen only: touch is handled by the TouchSensor below, which waits for a press-and-hold. */
class MousePenSensor extends PointerSensor {
  static activators = [
    {
      eventName: 'onPointerDown' as const,
      handler: (e: PointerEvent, opts: PointerSensorOptions) => e.nativeEvent.pointerType !== 'touch' && PointerSensor.activators[0].handler(e, opts),
    },
  ]
}

/**
 * Drag sensors shared by the board, the calendars and the board list. With a mouse a drag starts after a few pixels;
 * on a touch screen you press and hold a moment first, so a normal swipe still scrolls the page.
 */
export function useDragSensors(distance = 6, keyboard?: KeyboardSensorOptions) {
  return useSensors(
    useSensor(MousePenSensor, { activationConstraint: { distance } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, keyboard ?? {}),
  )
}

/** True on phones and tablets without a mouse: no hover, no right-click. */
export const touchOnly = () => typeof matchMedia !== 'undefined' && matchMedia('(hover: none)').matches

/** Live result of a CSS media query, e.g. useMedia('(max-width: 639px)'). */
export function useMedia(query: string) {
  const [match, setMatch] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(query).matches)
  useEffect(() => {
    const m = matchMedia(query)
    const on = () => setMatch(m.matches)
    on()
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [query])
  return match
}
