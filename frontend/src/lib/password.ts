/** Uniform random integer in [0, n) from the OS CSPRNG (rejection sampling, so no modulo bias). */
function randomInt(n: number): number {
  const buf = new Uint32Array(1)
  const limit = Math.floor(0x100000000 / n) * n
  do crypto.getRandomValues(buf)
  while (buf[0] >= limit)
  return buf[0] % n
}

/** Random password: letters, digits and a few symbols, at least one of each, without look-alikes (0/O, 1/l/I). */
export function generatePassword(length = 14): string {
  const sets = ['abcdefghijkmnpqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789', '!@#$%*-_+?']
  const all = sets.join('')
  const chars = sets.map((s) => s[randomInt(s.length)])
  while (chars.length < length) chars.push(all[randomInt(all.length)])
  // Fisher–Yates shuffle so the guaranteed characters aren't always first
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}
