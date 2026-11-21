# Kanban

A self-hosted Kanban board for **one organization**: no public sign-up. Accounts are created by a super admin. It combines kan.bn-style boards with Odoo-style cards (stars, blocked/ready status, column progress bars, folding, WIP limits, a unified comments + activity log).

| | |
|---|---|
| Backend | Rust · Axum 0.8 · SQLx 0.9 (runtime queries, embedded migrations) |
| Database | PostgreSQL 18 |
| Files | S3 API (SeaweedFS), private: every upload and download streams through the app after a permission check |
| Frontend | React 19 · Vite · TanStack Query · React Router · Tailwind v4 · Radix · dnd-kit · CodeMirror 6 · react-markdown |
| i18n / theme | English / ไทย toggle (IBM Plex Sans Thai) · light / dark / system |

## Features

- **Sign in with username or email.** Emails are unique (case-insensitive) and validated. Users set theirs in Profile, or a super admin sets it in Users → Edit.
- **Roles.** *Super admin* sees and manages every board and all users. *Board roles* are per board and fully customizable: Owner / Admin / Editor / Commenter / Viewer are seeded, and you can add your own from a permission matrix (13 permissions).
- **Cards are Markdown, edited Obsidian-style.** Live preview renders headings, bold/italic/strike, code, links, images, quotes, lists, checkboxes and dividers in place. An element's raw syntax shows only while the cursor is in it. There's a formatting toolbar, and Ctrl+B / I / E / K work. **Paste or drop images**: they upload and become `![](/api/files/…)`. Other dropped files are attached with a link. `- [ ]` items double as the card's checklist progress.
- **Autosave** for descriptions: 1.2 s after you stop typing, on blur, and on close. A burst of edits by one person within 10 minutes becomes **one** "updated the description" log entry.
- **Attachments** with upload progress and Thai filenames.
- **In-app file preview** (← → between files), rendered in the browser so files never leave your server:
  - images (SVG too, safely through `<img>`), PDF (PDF.js), Word `.docx` (docx-preview), Excel `.xlsx/.xls/.ods/.csv` (SheetJS, as a grid with sheet tabs), PowerPoint `.pptx` (pptx-preview)
  - Markdown, text and code files (UTF-8, or Thai TIS-620/Windows-874), video and audio
  - Legacy `.doc`/`.ppt` are download-only.
- **Comments and activity log** in one timeline. Every change (title, status, priority, due date, move, labels, assignees, attachments) is logged in the same DB transaction.
- **Search.** Ctrl+K searches every visible board and card (title, description, `#number`). Each page also has its own filter bar. Matching is case-insensitive *substring*, so Thai works without word segmentation.
- **Hover preview.** Pausing on a card shows its rendered description excerpt, status, due date and assignees.
- **Custom statuses per board** (name, colour, order). They appear as the card dot and in the column progress bar. New boards start with Normal / Blocked / Ready, in the creator's language.
- **Board filters:** text, assigned to me, labels, status, priority (★+, ★★+, ★★★, none), due date (overdue / today / 7 days / has / none). **Boards page:** shows owners and filters by owner.
- **Drag and drop** cards between columns, and reorder columns by their grip handle. **Sort a column** (priority, due date, newest/oldest, recently updated, title, number) from its ⋯ menu. This is a one-off reorder; you can keep dragging afterwards. Positions use fractional indexing, so one move rewrites one row.
- **Realtime.** Other people's changes appear live over a WebSocket per board.
- Labels, assignees, due dates (overdue highlighting), card colours, archive.
- **Columns can be archived** (hidden with their cards, restorable) **or deleted with everything in them** (cards, comments, files). Deleting a column that still has cards requires typing **Delete**, and so does deleting a board permanently.
- **No browser pop-ups:** every confirmation and input is an in-app dialog. **Toasts** confirm your own actions, and tell you when someone else changes the board you're viewing ("Somchai updated …"; a burst of edits is collapsed).
- **Presence:**
  - The board header shows who else is on the board right now: green dot = viewing, amber = typing.
  - A card that someone has open shows their avatar, and the open card says who's there and whether they're editing.
  - It's carried over the same per-board WebSocket.
- **Boards page:** drag boards to arrange them. The order is saved **per user**, and dragging is paused while a filter is active.
- **Archive and permanent delete:**
  - **Archive** hides a card or board but keeps everything. Archived cards are under Board settings → Archive (restore puts a card back at the bottom of its column). Archived boards are on the Boards page → Archived.
  - **Delete permanently** removes the rows and the stored files in S3. Boards require typing the board name to confirm. Pasted images that another card still references (e.g. a duplicate) are kept. Deleting a column also purges the files of archived cards in it.
- **Tutorial board:** every new account gets its own "👋 Getting started" board, in the language chosen when the account is created (English or ไทย). It has 11 cards covering every feature. You can add another copy at any time from the Boards page (right-click → *Add tutorial board*).
- **Right-click menus:**
  - **Cards** (Kanban and both calendars): open, rename, new card, duplicate, copy link / title, move to column, status, priority, due date (today / tomorrow / in a week / clear), labels, assign to me, colour, archive. Only actions you have permission for are shown.
  - **Columns:** new card at top or bottom, fold, sort, rename, WIP limit, delete.
  - **Boards** (Boards page): open, open in a new tab, copy link, rename, colour, board settings, leave, archive or restore, delete permanently. Right-clicking the page itself gives *New board* and *Add tutorial board*.
- **Calendar:**
  - Each board has a Board / Calendar switch, and the calendar uses the same filters.
  - There's also a cross-board **Calendar** page with board and "assigned to me" filters.
  - Month and week views, weeks starting Monday.
  - Drag a card to another day to reschedule it (its time is kept), drag it to "No due date" to clear the date, or click + on a day to add a card there.
  - **New card** from the toolbar, by double-clicking a day, or by right-clicking a day. Choose the column, date and time; the cross-board calendar also asks for the board. Chips there show which board each card is from.

## Development

```bash
docker compose -f dev/compose.yaml up -d          # Postgres :55432 + SeaweedFS :58333 (localhost only)

cd backend
cp .env.example .env                                # see below
set -a; . ./.env; set +a
KANBAN_ADMIN_PASSWORD='devpassword1' cargo run -- create-admin --username admin
cargo run                                           # API on 127.0.0.1:8080

cd ../frontend && npm install && npm run dev        # http://localhost:5173 (proxies /api + WebSocket)
```

`backend/.env` for development:

```
DATABASE_URL=postgres://kanban:kanban@127.0.0.1:55432/kanban
BIND_ADDR=127.0.0.1:8080
PUBLIC_ORIGIN=http://localhost:5173,http://localhost:8080
```

Tests: `cargo test` (ordering keys, checklist parsing) · `npx tsc -b` (types).

### CLI

```
kanban serve                                   # default
kanban create-admin --username NAME [--display-name "..."] [--locale th]   # password from KANBAN_ADMIN_PASSWORD or stdin
kanban set-password --username NAME            # also signs that user out everywhere
```

## Deployment (home server + VPS)

```
browser ──https──▶ VPS nginx (TLS) ──tailscale──▶ home server 100.64.12.34:3040 kanban-app
                                                               ├─ kanban-db  (no published port)
                                                               └─ kanban-s3  (no published port)
```

1. **Image.** Build on the main PC (faster) and ship it:
   ```bash
   docker build -t kanban:latest .
   docker save kanban:latest | ssh user@100.64.12.34 docker load
   ```
   (Building directly on the home server also works: `docker build -t kanban:latest <checkout>`. It's just slower.)
   The compose file sets `pull_policy: never` and `diun.enable=false` for this local image. your update script
   lists it as "local build", and it still updates Postgres and SeaweedFS normally.
2. **Files on the home server:**
   ```bash
   mkdir -p /srv/appdata/docker/kanban/secrets /srv/appdata/kanban/{postgres,seaweedfs}
   cp deploy/docker-compose.yml /srv/appdata/docker/kanban/
   # secrets (chmod 600): db.env, app.env, seaweedfs-s3.json, from the *.example files
   openssl rand -hex 24   # use for POSTGRES_PASSWORD / S3 secret
   ```
   `app.env`'s `PUBLIC_ORIGIN` must be the exact public URL (`https://<host>`).
3. `docker compose up -d`, then `docker exec -it kanban-app kanban create-admin --username <you>`.
4. **VPS:** DNS A record → VPS, issue the cert (certbot webroot, same as the other vhosts), copy `deploy/nginx-kanban.conf` to `/opt/nginx/conf.d/kanban.conf` with the host name filled in, `nginx -t`, reload.
5. **Tailscale ACL:** allow `tag:vps` → `100.64.12.34:3040`.
6. **Backups:** add a dump to the nightly script, e.g.
   `docker exec kanban-db pg_dump -U kanban -Fc kanban > /srv/appdata/backups/db/kanban-app-$(date +%Y%m%d-%H%M%S).dump`.
   Files live in `/srv/appdata/kanban/seaweedfs`, which the appdata snapshots cover.
   if you have an update script that dumps databases first, add a
   `predump` case: `kanban) out="$DUMPS/kanban-app-$T.dump"; docker exec kanban-db sh -c 'pg_dump -U kanban -d kanban -Fc' > "$out.part"; rc=$?;;`

Memory: the app uses about 30–70 MB, and Postgres and SeaweedFS are capped at 384 MB each.

## Security notes

- Sessions: random 256-bit token in an `HttpOnly; Secure; SameSite=Lax` cookie. Only its SHA-256 is stored. Expiry slides.
- CSRF: every non-GET request and WebSocket upgrade must carry an allowed `Origin`.
- Passwords: Argon2id. Login has rate limiting in nginx and constant-ish timing for unknown users.
- Files: permission-checked on every request. Only PNG, JPEG, GIF, WebP and AVIF are served inline. Everything else (SVG and HTML included) is a download with `nosniff` and `CSP: sandbox`.
- Markdown is sanitized (no raw HTML, no `javascript:` or `data:` URLs). The SPA ships with a strict CSP (no inline scripts).
- Boards you can't access return 404, not 403.

## Roadmap

- 2FA (TOTP; the `users.totp_secret` column is reserved) and OIDC SSO (`password_hash` is already nullable).
- Import from kan.bn.
- @mentions and notifications, custom fields, an archived-cards view with restore, board templates.
