/** How a person is shown everywhere on one line: "Display Name · @username". */
export function label(u: { display_name: string; username?: string | null }): string {
  return u.username ? `${u.display_name} · @${u.username}` : u.display_name
}

/** URL of an uploaded profile picture (undefined = show initials). */
export function avatarUrl(avatarId?: string | null): string | undefined {
  return avatarId ? `/api/avatars/${avatarId}` : undefined
}
