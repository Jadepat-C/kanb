# Kanb API

Everything the Kanb web app does goes through this JSON API, so scripts can do the same: create cards from a form,
move cards when a build passes, log time from another tool, export boards every night.

## Signing in: API tokens

Create a token in **Profile → API**, and send it with every request:

```bash
curl -H "Authorization: Bearer kanb_…" https://kanb.example.com/api/boards
```

- A token acts as you, with your permissions on each board. Nothing more.
- **Read** tokens may only read (`GET`). **Read and write** tokens may also change things.
- No token may touch account security: tokens, your password, two-factor sign-in, signed-in devices, single sign-on,
  signing in, or your email address. Those answer `403` with `token_not_allowed`. Live updates (WebSockets) don't
  take tokens either.
- Tokens can expire (30, 90 or 365 days, or never). Revoke one in **Profile → API** at any time. Resetting your
  password from an email link, an admin setting your password, an admin signing you out everywhere, or an admin
  turning on "Require single sign-on" (for everyone but super admins) revokes them all.
- Only a hash is stored: copy the token when it's shown, because it can't be shown again.
- If your account is deactivated, must change its password, or must set up two-factor sign-in first, its tokens are
  refused until that's sorted out.

The browser app uses a session cookie instead. A request with `Authorization: Bearer …` uses the token only (other
`Authorization` headers, e.g. a reverse proxy's Basic auth, are ignored).

## Conventions

- Base URL: `https://<your server>/api`. Request and response bodies are JSON (`Content-Type: application/json`),
  except file uploads (`multipart/form-data` with a `file` field) and downloads.
- IDs are UUIDs (version 7, so they sort by creation time). Times are RFC 3339 in UTC, e.g. `2026-03-01T09:00:00Z`.
- In `PATCH` bodies, a field that's left out stays as it is, and `null` clears it (e.g. `"due_at": null`).
- Errors answer with a status code and `{"error": "<code>"}`, e.g. `{"error": "forbidden"}`:

  | Status | Meaning |
  |---|---|
  | 400 | the request isn't valid; the code says why (`title_required`, `invalid_list`, …) |
  | 401 | not signed in, or the token is unknown, revoked or expired |
  | 403 | not allowed (`forbidden`, or a specific code such as `token_read_only`) |
  | 404 | doesn't exist, or you can't see it (boards you're not on answer 404, not 403) |
  | 409 | conflicts with what's there (`username_taken`, `timer_running`, …) |
  | 413 | too large (`too_large`), or the server's storage is full (`storage_full`) |
  | 429 | too many attempts: `{"error": "too_many_attempts", "retry_after": <seconds>}`, plus a `Retry-After` header |

- Rate limits apply to signing in, password resets, sign-ups and single sign-on, per address and per account. The
  rest of the API isn't rate limited, but please keep scripts reasonable: large responses (a whole board, an export)
  are built a few at a time.
- **Permissions** are per board, from your role (Owner, Admin, Editor, Commenter, Viewer, or your board's own roles).
  The tables below name the permission each call needs. A role may be limited to the cards its members created; the
  server checks that for every card.

## Examples

Your boards, then one board with its columns and cards:

```bash
curl -H "Authorization: Bearer $KANB_TOKEN" https://kanb.example.com/api/boards
curl -H "Authorization: Bearer $KANB_TOKEN" https://kanb.example.com/api/boards/$BOARD
```

`GET /boards/{id}` answers `{ board, lists, cards, labels, statuses, members, roles, my_permissions, … }`. Each card
has `id`, `number`, `title`, `list_id`, `status_id`, `priority` (0–3), `label_ids`, `assignee_ids`, `start_at`,
`due_at`, `done`, `estimate_minutes`, `time_minutes` and more.

Create a card at the top of a column, due on 1 March:

```bash
curl -X POST -H "Authorization: Bearer $KANB_TOKEN" -H "Content-Type: application/json" \
  -d '{"title": "Call the supplier", "description": "About the **March** order", "at": "top", "due_at": "2026-03-01T09:00:00Z"}' \
  https://kanb.example.com/api/lists/$LIST/cards
```

Move it to another column. `index` is its place among that column's cards (0 = top; a large number = bottom):

```bash
curl -X POST -H "Authorization: Bearer $KANB_TOKEN" -H "Content-Type: application/json" \
  -d '{"list_id": "'$DONE_LIST'", "index": 0}' https://kanb.example.com/api/cards/$CARD/move
```

Change several fields, then comment (`@username` mentions notify people):

```bash
curl -X PATCH -H "Authorization: Bearer $KANB_TOKEN" -H "Content-Type: application/json" \
  -d '{"priority": 2, "status_id": "'$STATUS'", "estimate_minutes": 240}' https://kanb.example.com/api/cards/$CARD
curl -X POST -H "Authorization: Bearer $KANB_TOKEN" -H "Content-Type: application/json" \
  -d '{"body": "Done, see the attached invoice @somchai"}' https://kanb.example.com/api/cards/$CARD/comments
```

Attach a file, log 90 minutes, and export the board as CSV:

```bash
curl -X POST -H "Authorization: Bearer $KANB_TOKEN" -F file=@invoice.pdf https://kanb.example.com/api/cards/$CARD/attachments
curl -X POST -H "Authorization: Bearer $KANB_TOKEN" -H "Content-Type: application/json" \
  -d '{"minutes": 90, "note": "Supplier call"}' https://kanb.example.com/api/cards/$CARD/time
curl -H "Authorization: Bearer $KANB_TOKEN" -o board.csv "https://kanb.example.com/api/boards/$BOARD/export?format=csv"
```

Many cards at once, with the same checks as one by one (the answer lists the cards that couldn't be changed):

```bash
curl -X POST -H "Authorization: Bearer $KANB_TOKEN" -H "Content-Type: application/json" \
  -d '{"card_ids": ["'$A'", "'$B'"], "action": "labels", "add": ["'$LABEL'"]}' \
  https://kanb.example.com/api/boards/$BOARD/cards/bulk
```

## Reference

Paths are relative to `/api`. "Member" means anyone on the board (any role); super admins can open every board.

### Boards

| Method | Path | Needs | What it does |
|---|---|---|---|
| GET | `/boards` | signed in | your boards (`?archived=true` for archived ones, `?q=` to search their names) |
| POST | `/boards` | may create boards | new board: `{name, description?, color?, lists?: [names]}` |
| GET | `/boards/{id}` | member | the board with its columns, cards, labels, statuses, members and roles |
| PATCH | `/boards/{id}` | board.manage | `{name?, description?, color?}` |
| DELETE | `/boards/{id}` | board.archive | archive the board |
| POST | `/boards/{id}/restore` | board.archive | restore an archived board |
| DELETE | `/boards/{id}/permanent` | board.delete | delete for good, with all its cards and files |
| PUT | `/boards-order` | signed in | your own order of the boards list: `{ids}` |
| GET | `/boards/{id}/export` | member | `?format=csv`, `json` or `zip` (with every file) |
| GET | `/boards/{id}/analytics` | analytics.view | KPIs, `?days=7|30|90|180|365` |
| GET, PUT | `/boards/{id}/share` | board.manage | the public read-only link: `{enabled?, comments?, files?, reset?}` |
| GET | `/boards/{id}/ws` | member | live updates (WebSocket; browser session only) |
| POST | `/boards/{id}/save-as-template` | may create boards | save the board's structure as a board template |
| POST | `/import/preview` | may create boards | what a file would import (multipart `file`, optional `options`) |
| POST | `/import` | may create boards | import a board from Trello, Wekan, Kanb (JSON/ZIP) or CSV |

### Columns, labels, statuses, roles and members

| Method | Path | Needs | What it does |
|---|---|---|---|
| POST | `/boards/{id}/lists` | lists.create | new column: `{name}` |
| PATCH | `/lists/{id}` | lists.edit | `{name?, color?, wip_limit?, folded?, index?}` |
| DELETE | `/lists/{id}` | lists.delete (+ cards.delete when it has cards) | delete a column |
| POST | `/lists/{id}/archive`, `/lists/{id}/restore` | lists.archive | archive or restore a column |
| GET | `/boards/{id}/archived-lists` | member | archived columns |
| POST | `/lists/{id}/sort` | cards.move | sort a column: `{by: "priority"|"due"|"created"|"updated"|"title"|"number", desc?}` |
| POST | `/boards/{id}/labels` | labels.manage | `{name, color}` |
| PATCH, DELETE | `/labels/{id}` | labels.manage | rename / recolour, delete |
| POST | `/boards/{id}/statuses` | statuses.manage | `{name, color, is_done?, index?}` |
| PATCH, DELETE | `/statuses/{id}` | statuses.manage | change, delete |
| POST | `/boards/{id}/roles` | roles.manage | new role: `{name, permissions, own_cards_only?, card_list_ids?}` |
| PATCH, DELETE | `/roles/{id}` | roles.manage | change, delete |
| POST | `/boards/{id}/members` | members.manage | add someone: `{user_id, role_id}` |
| PATCH, DELETE | `/boards/{id}/members/{user_id}` | members.manage (or yourself, to leave) | change role `{role_id}`, remove |

### Cards

| Method | Path | Needs | What it does |
|---|---|---|---|
| POST | `/lists/{id}/cards` | cards.create | `{title, description?, at?: "top"|"bottom", due_at?, template_id?}` |
| GET | `/cards/{id}` | member | the card, its attachments, and whether you watch it |
| PATCH | `/cards/{id}` | cards.edit / cards.status / cards.due | `{title?, description?, priority?, color?, status_id?, start_at?, due_at?, remind_minutes?, estimate_minutes?}` |
| POST | `/cards/{id}/move` | cards.move | `{list_id, index}` |
| PUT | `/cards/{id}/labels` | cards.labels | the card's labels: `{ids}` |
| PUT | `/cards/{id}/assignees` | cards.assign | the card's assignees: `{ids}` (board members only) |
| PUT | `/cards/{id}/dependencies` | cards.dependencies | cards this one waits for: `{ids}` |
| PUT | `/cards/{id}/watch` | member | `{watching: true|false}` |
| POST | `/cards/{id}/duplicate` | cards.create | a copy below it |
| DELETE | `/cards/{id}` | cards.archive | archive |
| POST | `/cards/{id}/restore` | cards.archive | restore |
| DELETE | `/cards/{id}/permanent` | cards.delete | delete for good |
| GET | `/boards/{id}/archived-cards` | member | archived cards |
| GET | `/cards/{id}/timeline` | member | comments and history, newest first |
| POST | `/boards/{id}/cards/bulk` | per card, as below | one change to many cards (at most 500): `{card_ids, action, …}` |
| PUT | `/cards/{id}/calendar` | member | put the card in your calendar feed or take it out: `{on: true|false}` |
| POST | `/cards/{id}/save-template` | cards.create | save the card as a card template: `{name}` |

Bulk actions: `move` (`list_id`, `at?: "top"|"bottom"`), `update` (`changes`: the `PATCH /cards/{id}` fields except
title and description), `labels` / `assignees` (`add`, `remove`: ids), `watch` (`watching`) and `archive`. The answer
is `{done, failed: [{id, error}]}`.

### Comments and files

| Method | Path | Needs | What it does |
|---|---|---|---|
| POST | `/cards/{id}/comments` | comments.create | `{body}` (Markdown) |
| PATCH | `/comments/{id}` | the author | `{body}` |
| DELETE | `/comments/{id}` | the author, or comments.moderate | delete |
| POST | `/cards/{id}/attachments` | attachments.upload | multipart `file`; `?inline=1` for a picture inside the description |
| GET | `/files/{id}` | member | download (`?download=1` to force a download) |
| DELETE | `/attachments/{id}` | the uploader, or attachments.delete | delete |

### Time tracking

| Method | Path | Needs | What it does |
|---|---|---|---|
| GET | `/cards/{id}/time` | member | entries, total and estimate |
| POST | `/cards/{id}/time` | time.log | time entered by hand: `{minutes, started_at?, note?}` |
| POST | `/cards/{id}/time/start` | time.log | start your timer here (one runs at a time; another is stopped and logged first) |
| POST | `/me/timer/stop` | signed in | stop your timer: `{minutes?, note?}` (`minutes` corrects a timer that ran on) |
| GET | `/me/timer` | signed in | your running timer, or `null` |
| PATCH | `/time/{id}` | your own entry with time.log, or board.manage | `{minutes?, started_at?, note?}` |
| DELETE | `/time/{id}` | your own entry with time.log, or board.manage | delete |

### Templates and recurring cards

| Method | Path | Needs | What it does |
|---|---|---|---|
| POST | `/boards/{id}/templates` | templates.manage | card template: `{name, title, description, …}` |
| PATCH, DELETE | `/templates/{id}` | templates.manage | change, delete |
| GET | `/card-templates` | signed in | card templates of all your boards |
| POST | `/templates/{id}/copy` | templates.manage on the target | copy to another board: `{board_id}` |
| GET, POST | `/board-templates` | signed in / may create boards | board templates |
| PATCH, DELETE | `/board-templates/{id}` | its creator | change, delete |
| GET, POST | `/boards/{id}/recurrences` | member / cards.create | recurring cards |
| PATCH, DELETE | `/recurrences/{id}` | cards.create | change, delete |

### Search, calendar and notifications

| Method | Path | Needs | What it does |
|---|---|---|---|
| GET | `/search` | signed in | `?q=…&board_id=…`: boards and cards you can see |
| GET | `/calendar` | signed in | cards due between `?from=` and `&to=` (RFC 3339), optionally `&board_id=` |
| GET | `/notifications` | signed in | your notifications (`?unread_only=true` for unread ones) |
| POST | `/notifications/read` | signed in | mark read: `{ids}`, `{card_id}` or `{all: true}` |
| POST | `/notifications/clear` | signed in | clear: `{ids}` or `{all: true}` |
| GET | `/notifications/ws` | signed in | live notifications (WebSocket; browser session only) |
| GET, POST, PATCH, DELETE | `/me/calendar-feed` | signed in | your calendar feed link: status, new link, choices, turn off |
| GET | `/calendar/{file}` | the feed's secret link | the `.ics` feed for calendar apps |
| GET | `/announcement` | signed in | the site-wide banner, if any |

### Your account

| Method | Path | Needs | What it does |
|---|---|---|---|
| GET, PATCH | `/me` | signed in | you; change `{display_name?, email?, locale?, theme?, avatar_color?, notify_email?, notify_events?}` |
| POST, DELETE | `/me/avatar` | signed in | upload (multipart `file`) or remove your picture |
| GET | `/avatars/{id}` | signed in | a profile picture |
| GET | `/users` | signed in | everyone active (for adding members): id, names, picture, department |
| GET | `/departments` | signed in | the departments |
| GET, POST | `/me/contact-points` | signed in | your chat and webhook channels for notifications |
| PATCH, DELETE | `/me/contact-points/{id}` | signed in | change, delete |
| POST | `/me/contact-points/test` | signed in | send a test message |
| GET | `/push` | signed in | browser notifications: the server's public key |
| POST, DELETE | `/me/push` | signed in | subscribe / unsubscribe this browser |
| POST | `/me/push/test` | signed in | send a test notification |
| POST | `/me/tutorial` | signed in | add the "Getting started" board |
| GET, POST | `/me/tokens` | session only | your API tokens; create one: `{name, scope: "read"|"write", expires_days?}` |
| DELETE | `/me/tokens/{id}` | session only | revoke |
| POST | `/me/password` | session only | `{current_password, new_password}` |
| POST | `/me/2fa/setup`, `/me/2fa/enable`, `/me/2fa/disable`, `/me/2fa/recovery` | session only | two-factor sign-in |
| GET, DELETE | `/me/sessions` | session only | your signed-in devices; sign out the others |
| DELETE | `/me/sessions/{id}` | session only | sign out one device |
| GET | `/me/sso` | session only | your single sign-on connections |
| POST | `/me/sso/link` | session only | connect your provider account (answers the URL to open) |
| DELETE | `/me/sso/{id}` | session only | disconnect |

### Signing in (browser only)

| Method | Path | What it does |
|---|---|---|
| GET | `/health` | `ok` when the app and its database are up (no sign-in needed) |
| GET | `/auth/options` | what the sign-in page offers (password reset, sign-up, single sign-on) |
| POST | `/auth/login` | `{username, password}`: sets the session cookie, or answers `{totp_required, ticket}` |
| POST | `/auth/login/code` | `{ticket, code}`: the two-factor step |
| POST | `/auth/logout` | sign out |
| POST | `/auth/setup` | create the first admin on a new server (with the setup code) |
| POST | `/auth/forgot` | email a password-reset link: `{login}` |
| POST | `/auth/reset/check`, `/auth/reset` | check a reset link; set the new password |
| POST | `/auth/register`, `/auth/confirm` | self sign-up (with `ALLOW_SIGNUP=true`) and its email confirmation |
| GET | `/auth/sso/start`, `/auth/sso/callback` | single sign-on with the configured provider |

### Public board links (no sign-in)

| Method | Path | What it does |
|---|---|---|
| GET | `/public/{token}` | the shared board, read-only |
| GET | `/public/{token}/cards/{id}` | one card (comments only if the board shares them) |
| GET | `/public/{token}/files/{id}` | a file (pictures in descriptions; other files only if the board shares them) |

### Administration (super admins)

| Method | Path | What it does |
|---|---|---|
| GET, POST | `/admin/users` | everyone; create an account |
| PATCH, DELETE | `/admin/users/{id}` | change (`display_name`, `email`, `is_super_admin`, `can_create_boards`, `is_active`, `department_id`), delete |
| GET | `/admin/users/{id}/delete-preview` | what deleting them would do to their boards |
| POST | `/admin/users/{id}/send-reset` | email them a password-reset link |
| POST | `/admin/users/{id}/password` | set a password they must change |
| DELETE | `/admin/users/{id}/2fa` | turn off their two-factor sign-in |
| GET, DELETE | `/admin/users/{id}/sessions` | their devices; sign them out everywhere (and revoke their API tokens) |
| DELETE | `/admin/sessions/{id}` | sign out one device |
| POST | `/admin/departments` | new department: `{name, color?}` |
| PATCH, DELETE | `/admin/departments/{id}` | rename / recolour, delete |
| PUT | `/admin/departments/{id}/members` | `{add: [user ids], remove: [user ids]}` |
| GET, PUT | `/admin/signups` | sign-up settings and who's waiting |
| POST | `/admin/signups/approve`, `/admin/signups/reject` | `{ids}` |
| GET, PUT | `/admin/sso` | single sign-on settings (the client secret is never sent back) |
| POST | `/admin/sso/test` | check the provider with unsaved settings |
| GET, PUT | `/admin/email` | email (SMTP) settings |
| POST | `/admin/email/test` | send a test email: `{to}` |
| GET, PUT | `/admin/notifications` | which notification channels are on for everyone |
| GET, PUT | `/admin/security` | `{require_2fa, public_links}` |
| GET | `/admin/audit` | the activity log: `?topic=&user=&before=` |
| GET | `/admin/storage` | storage use |
| GET | `/admin/boards` | every board |
| POST | `/admin/boards/{id}/owners` | make someone an owner: `{user_id}` |
| GET | `/admin/system` | version, sizes, email status |
| GET, PUT | `/admin/announcement` | the site-wide banner |

### Board notification channels

| Method | Path | Needs | What it does |
|---|---|---|---|
| GET, POST | `/boards/{id}/contact-points` | notifications.manage | the board's team channels |
| POST | `/boards/{id}/contact-points/test` | notifications.manage | send a test |
| PATCH, DELETE | `/board-contact-points/{id}` | notifications.manage | change, delete |
