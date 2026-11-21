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

- **Roles.** *Super admin* sees and manages every board and all users. *Board roles* are per board and fully customizable: Owner / Admin / Editor / Commenter / Viewer are seeded, and you can add your own from a permission matrix (13 permissions).
- **Cards are Markdown.** GFM tables and task lists are supported. Clicking a task checkbox in the preview edits the source, and `- [ ]` items double as the card's checklist progress. **Paste or drop images** into the editor: they upload and become `![](/api/files/…)`. Dropping other files attaches them and inserts a link.
- **Attachments** with upload progress, inline images, and Thai filenames (RFC 5987 headers).
- **Comments and activity log** in one timeline. Every change (title, status, priority, due date, move, labels, assignees, attachments) is logged in the same DB transaction.
- **Search.** Ctrl+K searches every visible board and card (title, description, `#number`). Each page also has its own filter bar. Matching is case-insensitive *substring*, so Thai works without word segmentation.
- **Hover preview.** Pausing on a card shows its rendered description excerpt, status, due date and assignees.
- **Drag and drop** cards between columns, and reorder columns. Positions use fractional indexing, so one move rewrites one row.
- **Realtime.** Other people's changes appear live over a WebSocket per board.
- Labels, assignees, due dates (overdue highlighting), card colours, archive.

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
kanban create-admin --username NAME [--display-name "..."]   # password from KANBAN_ADMIN_PASSWORD or stdin
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
