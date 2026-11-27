/** Durations for time tracking. */

/** 90 → "1h 30m", 45 → "45m", 120 → "2h". */
export function fmtMinutes(m: number): string {
  const h = Math.floor(m / 60)
  const r = Math.round(m % 60)
  if (!h) return `${r}m`
  return r ? `${h}h ${r}m` : `${h}h`
}

/** Seconds → "1:02:03" (or "2:03" under an hour). */
export function clock(secs: number): string {
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  const p = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`
}

/**
 * What people type for a duration → minutes, or null when it isn't one:
 * "1h 30m", "1h30", "2h", "45m", "45 min", "1.5" (hours), "1,5", "1:30", "90m". Thai "ชม." / "นาที" work too.
 */
export function parseDuration(text: string, max = 7 * 24 * 60): number | null {
  const check = (n: number) => (n >= 1 && n <= max ? n : null)
  const s = text.trim().toLowerCase().replace(/ชั่วโมง|ชม\.?/g, 'h').replace(/นาที|น\./g, 'm').replace(',', '.')
  if (!s) return null
  let m: RegExpMatchArray | null
  if ((m = s.match(/^(\d+):([0-5]?\d)$/))) return check(Number(m[1]) * 60 + Number(m[2]))
  if ((m = s.match(/^(\d+(?:\.\d+)?)$/))) return check(Math.round(Number(m[1]) * 60))
  m = s.match(/^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?|s)?)?)?$/)
  if (m && (m[1] || m[2])) return check(Math.round(Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)))
  // "1h30" (minutes without the unit)
  if ((m = s.match(/^(\d+)\s*h\s*(\d+)$/))) return check(Number(m[1]) * 60 + Number(m[2]))
  return null
}
