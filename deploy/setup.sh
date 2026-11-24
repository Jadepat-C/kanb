#!/bin/sh
# Writes deploy/.env for docker compose, asking a few questions (press Enter to accept the [default]).
#
#   ./setup.sh                          answer the questions
#   ./setup.sh --defaults [URL]         no questions: try it at http://localhost:8080 (or the URL given)
#
# Run it again later to change settings: passwords and keys are kept as they are.
# shellcheck disable=SC2153,SC2154  # ask() and choose() set their variables through eval
set -eu
cd "$(dirname "$0")"

INTERACTIVE=1
URL_ARG=""
for a in "$@"; do
  case $a in
    --defaults | -y) INTERACTIVE=0 ;;
    -h | --help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    http://* | https://*) URL_ARG=${a%/} ;;
    *) echo "unknown option: $a (see --help)" >&2; exit 1 ;;
  esac
done
# no terminal (a script or CI): use the defaults
[ -t 0 ] || [ "${FORCE_PROMPTS:-}" = 1 ] || INTERACTIVE=0

command -v openssl >/dev/null || { echo "openssl is needed to generate passwords." >&2; exit 1; }
rand() { openssl rand -hex "$1"; }

# ---------------------------------------------------------------- helpers

# ask VAR "question" default  -> sets VAR (Enter keeps the default)
ask() {
  _var=$1 _q=$2 _def=$3
  if [ "$INTERACTIVE" = 1 ]; then
    printf '%s [%s]: ' "$_q" "$_def" >&2
    IFS= read -r _ans || _ans=""
    [ -n "$_ans" ] || _ans=$_def
  else
    _ans=$_def
  fi
  eval "$_var=\$_ans"
}

# yesno "question" default(y|n)  -> exit status 0 for yes
yesno() {
  while :; do
    ask _yn "$1 (y/n)" "$2"
    case $_yn in
      [Yy]*) return 0 ;;
      [Nn]*) return 1 ;;
    esac
    echo "  please answer y or n" >&2
  done
}

# choose VAR "question" default "1) …" "2) …"   -> VAR = the number picked
choose() {
  _cvar=$1 _cq=$2 _cdef=$3
  shift 3
  if [ "$INTERACTIVE" = 1 ]; then
    echo "$_cq" >&2
    for o in "$@"; do echo "  $o" >&2; done
  fi
  while :; do
    ask "$_cvar" "Choose" "$_cdef"
    eval "_c=\$$_cvar"
    case $_c in [1-9]) [ "$_c" -le $# ] && return 0 ;; esac
    echo "  please pick 1-$#" >&2
  done
}

say() { [ "$INTERACTIVE" = 1 ] && printf '%s\n' "$*" >&2 || true; }

valid_url() { case $1 in http://?* | https://?*) return 0 ;; esac; return 1; }
valid_port() { case $1 in '' | *[!0-9]*) return 1 ;; esac; [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }
plain() { case $1 in '' | *[!A-Za-z0-9]*) return 1 ;; esac; [ ${#1} -ge 12 ]; }
hex64() { [ ${#1} -eq 64 ] && case $1 in *[!0-9a-fA-F]*) return 1 ;; esac; }

# ---------------------------------------------------------------- existing settings

UPDATING=0
if [ -e .env ]; then
  UPDATING=1
  # shellcheck disable=SC1091
  . ./.env
  say "deploy/.env already exists: you can change the settings below."
  say "Passwords, keys and the setup code are kept: the database and stored secrets depend on them."
  if [ "$INTERACTIVE" = 0 ]; then
    echo ".env already exists; run ./setup.sh in a terminal to change it (nothing was changed)." >&2
    exit 1
  fi
fi

# defaults (from the existing .env when there is one)
D_URL=${URL_ARG:-${KANB_URL:-http://localhost:8080}}
D_BIND=${KANB_BIND:-127.0.0.1:8080}
D_DATA=${KANB_DATA:-./data}
D_TZ=${TZ:-$( (timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null) | head -n1)}
D_TZ=${D_TZ:-UTC}
D_UPLOAD=${MAX_UPLOAD_MB:-50}
D_STORAGE=${MAX_STORAGE_GB:-0}
D_IMAGE=${KANB_IMAGE:-}

say ""
say "Kanb setup — press Enter to accept the value in [brackets]."
say ""

# ---------------------------------------------------------------- address

while :; do
  ask URL "1. Address people will open in their browser (https://… for a real server)" "$D_URL"
  URL=${URL%/}
  valid_url "$URL" && break
  echo "  it must start with http:// or https://" >&2
done
case $URL in https://*) COOKIE_SECURE=true ;; *) COOKIE_SECURE=false ;; esac

# ---------------------------------------------------------------- port and who can connect

D_PORT=${D_BIND##*:}
case $D_BIND in
  127.0.0.1:*) D_WHO=1 ;;
  0.0.0.0:*) D_WHO=2 ;;
  *) D_WHO=3 ;;
esac
say ""
while :; do
  ask PORT "2. Port the app listens on, on this machine" "$D_PORT"
  valid_port "$PORT" && break
  echo "  a number from 1 to 65535" >&2
done
choose WHO "   Who can connect to that port directly?" "$D_WHO" \
  "1) only this machine — a reverse proxy here (Caddy, nginx) serves https" \
  "2) any device on my network or VPN — e.g. trying it from a laptop, or a proxy on another machine" \
  "3) one specific address of this machine (e.g. its Tailscale IP)"
case $WHO in
  1) BIND="127.0.0.1:$PORT" ;;
  2) BIND="0.0.0.0:$PORT" ;;
  3)
    D_ADDR=${D_BIND%:*}
    case $D_ADDR in 127.0.0.1 | 0.0.0.0) D_ADDR="" ;; esac
    while :; do
      ask ADDR "   Address (e.g. 192.168.1.20 or a Tailscale 100.x address)" "$D_ADDR"
      [ -n "$ADDR" ] && break
      echo "  type the address" >&2
    done
    BIND="$ADDR:$PORT"
    ;;
esac

# a proxy in front passes on each visitor's address, which the sign-in rate limits use
if [ "$WHO" = 1 ] || [ "$COOKIE_SECURE" = true ]; then
  TRUST_PROXY=true
else
  say ""
  if yesno "   Is there a reverse proxy (https) in front of Kanb?" "$([ "${TRUST_PROXY:-false}" = true ] && echo y || echo n)"; then
    TRUST_PROXY=true
  else
    TRUST_PROXY=false
  fi
fi
if [ "$COOKIE_SECURE" = false ] && [ "$WHO" != 1 ]; then
  say "   Note: over plain http, open exactly $URL — other addresses for the same server are refused."
fi

# ---------------------------------------------------------------- storage, time, uploads

say ""
ask DATA "3. Folder for the database and uploaded files (back this up)" "$D_DATA"
ask TZ_VALUE "4. Time zone for dates in chat posts and calendar feeds" "$D_TZ"
while :; do
  ask UPLOAD "5. Largest upload, in MB" "$D_UPLOAD"
  case $UPLOAD in '' | *[!0-9]*) echo "  a whole number" >&2 ;; *) break ;; esac
done
while :; do
  ask STORAGE "   Total space for all uploads together, in GB (0 = no limit)" "$D_STORAGE"
  case $STORAGE in '' | *[!0-9]*) echo "  a whole number (0 for no limit)" >&2 ;; *) break ;; esac
done

# ---------------------------------------------------------------- passwords and keys

if [ "$UPDATING" = 1 ]; then
  PG=$POSTGRES_PASSWORD S3K=${S3_ACCESS_KEY:-kanb} S3S=$S3_SECRET_KEY SK=$SECRET_KEY CODE=${SETUP_CODE:-}
else
  say ""
  say "6. Passwords and keys. Press Enter to generate random ones (recommended)."
  while :; do
    ask PG "   Database password (letters and digits, 12+)" "generate"
    [ "$PG" = generate ] && PG=$(rand 24) && break
    plain "$PG" && break
    echo "  use at least 12 letters and digits only (it goes into a connection URL)" >&2
  done
  ask S3K "   File storage access key" "kanb"
  while :; do
    ask S3S "   File storage secret (letters and digits, 12+)" "generate"
    [ "$S3S" = generate ] && S3S=$(rand 24) && break
    plain "$S3S" && break
    echo "  use at least 12 letters and digits only" >&2
  done
  while :; do
    ask SK "   Encryption key (SECRET_KEY; paste your old one when restoring a backup)" "generate"
    [ "$SK" = generate ] && SK=$(rand 32) && break
    hex64 "$SK" && break
    echo "  it must be 64 hex characters (0-9, a-f)" >&2
  done
  ask CODE "   Setup code for creating the first admin" "generate"
  [ "$CODE" = generate ] && CODE="$(rand 3)-$(rand 3)"
fi

# ---------------------------------------------------------------- image

say ""
case $D_IMAGE in '' | ghcr.io/*) D_SRC=1 ;; *) D_SRC=2 ;; esac
choose SRC "7. Which app image?" "$D_SRC" \
  "1) download the published image (fast; x86-64 and ARM64)" \
  "2) build from this checkout (a few minutes; use this if you changed the code)"
if [ "$SRC" = 2 ]; then
  IMAGE=kanb:local
else
  case $D_IMAGE in ghcr.io/*) IMAGE=$D_IMAGE ;; *) IMAGE="" ;; esac
fi

# ---------------------------------------------------------------- confirm and write

if [ "$INTERACTIVE" = 1 ]; then
  cat >&2 <<SUMMARY

  Address        $URL$([ "$COOKIE_SECURE" = true ] && echo "  (secure cookies)")
  Listens on     $BIND$([ "$TRUST_PROXY" = true ] && echo "  (behind a proxy)")
  Data folder    $DATA
  Time zone      $TZ_VALUE
  Uploads up to  $UPLOAD MB each, $([ "$STORAGE" = 0 ] && echo "no total limit" || echo "$STORAGE GB in total")
  Image          ${IMAGE:-published (ghcr.io)}$([ "$IMAGE" = kanb:local ] && echo " — built from this checkout")
  Passwords      $([ "$UPDATING" = 1 ] && echo "kept" || echo "ready")

SUMMARY
  yesno "Write deploy/.env?" y || { echo "Nothing was written." >&2; exit 1; }
fi

umask 077
cat > .env <<ENV
# Written by setup.sh — run it again to change these. See .env.example for what each one does.
KANB_URL=$URL
COOKIE_SECURE=$COOKIE_SECURE
KANB_BIND=$BIND
TRUST_PROXY=$TRUST_PROXY
KANB_DATA=$DATA
TZ=$TZ_VALUE
MAX_UPLOAD_MB=$UPLOAD
MAX_STORAGE_GB=$STORAGE
POSTGRES_PASSWORD=$PG
S3_ACCESS_KEY=$S3K
S3_SECRET_KEY=$S3S
SECRET_KEY=$SK
SETUP_CODE=$CODE
ENV
[ -n "$IMAGE" ] && echo "KANB_IMAGE=$IMAGE" >> .env

if [ "$IMAGE" = kanb:local ]; then START="docker compose up -d --build"; else START="docker compose up -d"; fi
if [ "$UPDATING" = 1 ]; then
  cat <<MSG
Updated deploy/.env. Apply it with:  $START
MSG
else
  cat <<MSG
Wrote deploy/.env for $URL. Keep a copy of SECRET_KEY with your backups.

Next:
  $START
  then open $URL and create the first admin with setup code:  $CODE
MSG
fi
