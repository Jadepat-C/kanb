export type Theme = 'light' | 'dark' | 'system'
export type Locale = 'en' | 'th'

export interface User {
  id: string
  username: string
  display_name: string
  email: string | null
  is_super_admin: boolean
  can_create_boards: boolean
  is_active: boolean
  locale: Locale
  theme: Theme
  avatar_color: string
  must_change_password: boolean
  /** last time the account used Kanb (null = not recorded yet, not "never") */
  last_seen_at: string | null
  /** an admin requires two-factor sign-in for everyone */
  require_2fa: boolean
  avatar_id: string | null
  notify_email: boolean
  /** what to notify about (see NOTIFY_KINDS) */
  notify_events: string[]
  totp_enabled: boolean
  created_at: string
}

export interface UserBrief {
  id: string
  username: string
  display_name: string
  avatar_color: string
  avatar_id: string | null
}

export interface BoardTemplateData {
  lists: { name: string; color?: string | null; wip_limit?: number | null }[]
  statuses: { name: string; color: string; done?: boolean }[]
  labels: { name: string; color: string }[]
  card_templates: { name: string; title: string; description?: string; priority?: number; status?: string | null; labels?: string[]; due_in_days?: number | null }[]
  cards: { list: number; title: string; description?: string; priority?: number; status?: string | null; labels?: string[]; color?: string | null }[]
}

export interface BoardTemplate {
  id: string
  name: string
  description: string
  color: string
  author: string | null
  updated_at: string
  can_edit: boolean
  counts: { lists: number; statuses: number; labels: number; card_templates: number; cards: number }
  data: BoardTemplateData
}

export interface BoardListItem {
  id: string
  name: string
  description: string
  color: string
  updated_at: string
  is_member: boolean
  card_count: number
  done_count: number
  member_count: number
  owners: { id: string; display_name: string; username: string; avatar_color: string; avatar_id: string | null }[]
  archived_at: string | null
  can_manage: boolean
  can_archive: boolean
  can_delete: boolean
}

export interface Board {
  id: string
  name: string
  description: string
  color: string
  created_at: string
  updated_at: string
}

export interface List {
  id: string
  name: string
  position: string
  color: string | null
  folded: boolean
  wip_limit: number | null
}

export interface Status {
  id: string
  name: string
  color: string
  position: number
  /** cards with this status count as finished */
  is_done: boolean
}

export interface CardSummary {
  id: string
  list_id: string
  number: number
  title: string
  position: string
  priority: number
  status_id: string | null
  color: string | null
  start_at: string | null
  due_at: string | null
  /** "due soon" reminder in minutes before the due date (null = 1 day, 0 = none) */
  remind_minutes: number | null
  /** status counts as done */
  done: boolean
  done_at: string | null
  updated_at: string
  label_ids: string[]
  assignee_ids: string[]
  /** cards this one waits for (finish-to-start) */
  depends_on: string[]
  comment_count: number
  attachment_count: number
  /** who made it (for roles limited to their own cards) */
  created_by: string | null
  excerpt: string
  checklist_total: number
  checklist_done: number
}

export interface Label {
  id: string
  name: string
  color: string
}

export interface Member {
  user_id: string
  username: string
  display_name: string
  avatar_color: string
  avatar_id: string | null
  role_id: string
}

export interface Role {
  id: string
  name: string
  permissions: string[]
  is_owner: boolean
  /** card and attachment permissions only cover cards the member created */
  own_cards_only: boolean
  /** columns the role may add cards to (null = any) */
  card_list_ids: string[] | null
}

export interface CardTemplate {
  id: string
  name: string
  title: string
  description: string
  priority: number
  status_id: string | null
  label_ids: string[]
  due_in_days: number | null
  updated_at: string
}

/** Due date for a card made from a template: today + N days at 09:00 local. */
export function templateDue(t: Pick<CardTemplate, 'due_in_days'>): string | null {
  if (t.due_in_days == null) return null
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + t.due_in_days, 9, 0).toISOString()
}

export interface BoardDetail {
  board: Board
  my_permissions: string[]
  my_role_id: string | null
  my_own_cards_only: boolean
  /** columns I may add cards to (null = any) */
  my_card_list_ids: string[] | null
  all_permissions: string[]
  permission_groups?: [string, string[]][]
  lists: List[]
  cards: CardSummary[]
  labels: Label[]
  statuses: Status[]
  members: Member[]
  roles: Role[]
  templates: CardTemplate[]
}

export interface Card {
  id: string
  board_id: string
  list_id: string
  number: number
  title: string
  description: string
  priority: number
  status_id: string | null
  color: string | null
  start_at: string | null
  due_at: string | null
  remind_minutes: number | null
  done_at: string | null
  created_by: string | null
  created_by_name?: string | null
  created_at: string
  updated_at: string
  label_ids: string[]
  assignee_ids: string[]
}

export interface Attachment {
  id: string
  filename: string
  content_type: string
  size: number
  is_inline: boolean
  uploaded_by: string | null
  created_at: string
  uploaded_by_name?: string | null
}

export interface CardDetail {
  card: Card
  attachments: Attachment[]
}

export type TimelineItem =
  | { type: 'comment'; id: string; author_id: string | null; author_name?: string | null; author_color?: string | null; author_avatar?: string | null; imported?: boolean; body: string; created_at: string; edited: boolean }
  | { type: 'event'; id: number; actor_id: string | null; actor_name?: string | null; actor_color?: string | null; actor_avatar?: string | null; kind: string; data: Record<string, unknown>; created_at: string }

export interface SearchResult {
  boards: { id: string; name: string; color: string }[]
  cards: {
    id: string
    board_id: string
    board_name: string
    list_name: string
    number: number
    title: string
    snippet: string
  }[]
}
