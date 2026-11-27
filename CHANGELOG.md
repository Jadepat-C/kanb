# Changelog

Every release of Kanb. The full notes, with upgrade details, are on the
[releases page](https://github.com/Jadepat-C/kanb/releases). The database is always updated automatically when the
app starts; a release only needs a configuration change when it says so under **Upgrading**.

Kanb follows [semantic versioning](https://semver.org/) from 1.0.0 on: updates within one major version (1.x) never
need configuration changes or break your data, and the image tag `:1` follows them.

## Unreleased

## 0.4.0 (2026-11-27)

### New
- **Single sign-on (OpenID Connect)** with Google, Microsoft Entra ID, Authentik, Keycloak, Authelia or any other
  provider (Admin → Single sign-on). Existing accounts are matched by verified email address and can still use their
  password; with `ALLOW_SIGNUP` on, new people get an account under the sign-up rules, optionally only from chosen
  email domains. **Require single sign-on** turns off passwords for everyone except super admins. SSO sign-ins skip
  Kanb's own two-factor step (the provider handles that). People connect or disconnect their account in
  Profile → Security; accounts made by SSO can set a password there.
- **Watch a card** (the eye in a card, or its menu) to be notified about it like its assignees, for the kinds chosen
  in Profile → Notifications. Watched cards show an eye on the board.
- **Select several cards** with Ctrl/⌘- or Shift-click (on phones: hold a card → *Select*, then tap others) and
  move, label, assign, date, prioritise, watch or archive them at once. Each card is checked like a single change.

- **Swimlanes:** the board's *Lanes* menu splits it into rows by assignee, label, priority, status or department.
  Each person picks their own (kept in their browser). Dragging a card to another lane changes that field.
- **Time tracking:** an estimate per card, a timer (one at a time; it shows in the header and stops when you leave
  the board) or time entered by hand. Totals show on cards, in a new *Time logged* section of Analytics (per person,
  per card, estimated vs logged) and in the CSV export. New role permission **Log time** (every role that may edit
  cards gets it); people fix their own entries, board managers anyone's.
- **Departments** (Admin → Departments): create them, put people in them (also when creating an account, and in
  Admin → Users, with a filter). Shown next to people's names; boards can be split into lanes by department.
- **API tokens and API reference:** personal tokens in Profile → API (read-only or read-write, with an expiry) for
  scripts, and a reference of every endpoint with examples, in the app and in `docs/api.md`. CI checks that every
  endpoint is documented.

### Fixes
- Someone who left a board no longer gets comment and activity notifications for cards they created there.
- The README's live backup could miss recently uploaded files: the file store is now paused for the copy, and the
  restore steps put the files back before anything starts (as written, they failed for non-root users).

### Development
- CI checks upgrades from the first release and from the latest one, with real data (files, the encrypted SMTP
  password, two-factor sign-in), and refuses edits to migrations that were already released.

### Upgrading
Migrations 0028–0032. No configuration changes. If you pin `:0.3`, change it to `:0.4`.

## 0.3.0 (2026-11-26)

### New
- **Sign-up (optional).** `ALLOW_SIGNUP=true` adds "Create an account" to the sign-in page, with email confirmation
  and, if you want, an admin's approval for each account (Admin → Users → Sign-up). Waiting sign-ups arrive as one
  bundled notification.
- **Import a board** from Trello or Wekan (JSON export), another Kanb (JSON, or ZIP with the files), or any CSV, with
  a column-matching preview. Comments keep their original author and date; nobody is notified about imported cards.
- **Board analytics:** open / finished / overdue cards, on-time rate, lead and cycle time, created vs finished,
  cumulative flow, WIP per column, stale and blocked cards, workload per person, breakdowns by label, status and
  priority. New role permission **View analytics** (Owner and Admin get it).

### Fixes
- Board, column, label, status and card colours must be `#rrggbb` colours.
- Board exports record each card's column position and file ids, so re-importing a Kanb export is exact.

### Upgrading
Migrations 0025–0027. New optional setting `ALLOW_SIGNUP` (default `false`).

## 0.2.2 (2026-11-26)

### New
- Choose what you're notified about (Profile → Notifications).
- Clear notifications in the bell, all at once or one by one.
- A "due soon" reminder per card, from 15 minutes to a week before (or none).
- Read-only public board links (Board settings → Share), with optional comments and downloads; Admin → Security can
  turn them off for the whole site.
- Show/hide buttons on password boxes; a new password is asked for twice.

### Upgrading
Migration 0024. No configuration changes.

## 0.2.1 (2026-11-24)

### New
- Profile → Security → Signed-in devices, with *Sign out* and *Sign out everywhere else*.

### Fixes
- The admin page's tab bar no longer shows a scrollbar.

## 0.2.0 (2026-11-24)

### New
- Admin panel: activity log, signed-in devices per person, last active and bulk deactivation of idle accounts, all
  boards with owners and size, system status and release check, announcement banner, inviting several people at once.
- Require two-factor sign-in for everyone (Admin → Security).
- `MAX_STORAGE_GB` caps the space all uploads may take together.
- Board roles can be limited to the cards their members created, and to the columns they may add cards to.
- Press, hold and let go on phones and tablets opens the right-click menu.

### Fixes
- **Security:** the per-account limit on wrong two-factor codes never triggered.
- The "Uploaded" message no longer counts uploads that failed.

### Upgrading
Migrations 0022–0023. If you pin `:0.1`, change it to `:0.2`.

## 0.1.9 (2026-11-23)

### Security
- The image is one self-contained program on a distroless static base: no C library, shell or package manager
  (49 MB, no scan findings).
- `cookie` updated (RUSTSEC-2026-0594).

### Fixes
- Emails to people with brackets or commas in their name failed to send.

## 0.1.8 (2026-11-23)

### New
- A column's **+** opens *New card* or *New card from template*.
- Card tiles no longer have a coloured label strip.

### Fixes
- The new-card title box gets the cursor when opened from a menu.

## 0.1.7 (2026-11-23)

### Fixes
- Renaming a column from its menu works again.

## 0.1.6 (2026-11-23)

### New
- `METRICS_ADDR`: Prometheus metrics on a separate address.

### Fixes
- Space and Enter in a column's rename box no longer start a keyboard drag.
- Browser notifications explain why turning them on failed, and replace subscriptions made with an old server key.
- Due reminders for unassigned cards go to whoever created the card.
- Wrong passwords and codes answer 401, so fail2ban and CrowdSec recognise brute force.

## 0.1.5 (2026-11-22)

### Fixes
- Email settings couldn't be saved on a new install.

## 0.1.4 (2026-11-22)

### New
- The compose files declare the app's health check (`kanban healthcheck`).

## 0.1.3 (2026-11-22)

### Fixes
- Copy buttons work on installs without HTTPS.

### Docs
- README: a complete, self-contained `docker-compose.yml` and `.env`.

## 0.1.2 (2026-11-22)

### Fixes
- A burst of sign-in attempts could run the server out of memory; password checks now run two at a time.
- Big boards open about 4× faster.
- Text with a NUL character caused a server error; ZIP exports failed on duplicate file names.
- Live updates no longer make every open tab re-download the whole board for each change.

### Security
- Automated permission tests of every endpoint as six kinds of user, on every push.
- Distroless image without OpenSSL; known-vulnerability scans of libraries and the image.

### New
- `deploy/setup.sh` asks for every setting. New setting `HEAVY_REQUESTS`.

## 0.1.1 (2026-11-22)

### New
- The "👋 Getting started" board covers every feature, in English and Thai.

## 0.1.0 (2026-11-22)

First public release: boards, calendar and Gantt views, Markdown cards with checklists, attachments, comments,
dependencies, recurring cards and templates, live updates, notifications by email, browser and chat apps, per-board
roles, two-factor sign-in, calendar feeds, export, English and Thai, light and dark, phones and tablets.
