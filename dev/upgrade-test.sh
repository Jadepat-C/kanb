#!/usr/bin/env bash
# Upgrade test: start a published release on an empty database, fill it with data (tests/upgrade.py seed), stop it,
# start the freshly built server on the same database, file store and SECRET_KEY, and check the data
# (tests/upgrade.py check). Run from the repository root after `cargo build` in backend/:
#
#     dev/upgrade-test.sh 0.1.0            # from the first release
#     dev/upgrade-test.sh "$(git describe --tags --abbrev=0 | sed 's/^v//')"   # from the latest release
#
# Uses its own throwaway compose project (kanb-upgrade) on the dev ports, so stop the dev stack first; everything,
# volumes included, is removed at the end.
set -euo pipefail

FROM=${1:?usage: dev/upgrade-test.sh <old version, e.g. 0.1.0>}
BIN=${BIN:-backend/target/debug/kanban}
PROJECT=kanb-upgrade
OLD=kanb-upgrade-old
STATE=$(mktemp)
LOG=$(mktemp)

cleanup() {
  docker rm -f "$OLD" >/dev/null 2>&1 || true
  [[ -n "${NEW_PID:-}" ]] && kill "$NEW_PID" 2>/dev/null || true
  docker compose -p "$PROJECT" -f dev/compose.yaml down -v >/dev/null 2>&1 || true
  rm -f "$STATE" "$LOG"
}
trap cleanup EXIT

export DATABASE_URL=postgres://kanban:kanban@127.0.0.1:55432/kanban
export S3_ENDPOINT=http://127.0.0.1:58333 S3_BUCKET=kanban S3_ACCESS_KEY=devaccesskey S3_SECRET_KEY=devsecretkey
export BIND_ADDR=127.0.0.1:8080 PUBLIC_ORIGIN=http://localhost:8080
export SECRET_KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
# never send webhooks (email stays switched off in the saved settings; MAIL_REDIRECT would hide the stored password)
export WEBHOOK_REDIRECT=http://127.0.0.1:9
export KANB_URL=http://localhost:8080 ADMIN_USER=upgrade_admin ADMIN_PASSWORD=upgrade-admin-password
ENVS=(-e DATABASE_URL -e S3_ENDPOINT -e S3_BUCKET -e S3_ACCESS_KEY -e S3_SECRET_KEY -e BIND_ADDR -e PUBLIC_ORIGIN
      -e SECRET_KEY -e WEBHOOK_REDIRECT)

wait_health() {
  for _ in $(seq 1 90); do curl -fsS "$KANB_URL/api/health" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}

docker compose -p "$PROJECT" -f dev/compose.yaml up -d --wait

echo "== $FROM: start and fill with data"
docker run -d --name "$OLD" --network host "${ENVS[@]}" "ghcr.io/jadepat-c/kanb:$FROM" >/dev/null
wait_health || { docker logs "$OLD"; exit 1; }
docker exec -e KANBAN_ADMIN_PASSWORD="$ADMIN_PASSWORD" "$OLD" /usr/local/bin/kanban create-admin --username "$ADMIN_USER"
python3 -B tests/upgrade.py seed "$STATE"
docker stop "$OLD" >/dev/null

echo "== this build: start on the same data and check it"
"$BIN" > "$LOG" 2>&1 &
NEW_PID=$!
wait_health || { cat "$LOG"; exit 1; }
python3 -B tests/upgrade.py check "$STATE" || { cat "$LOG"; exit 1; }
