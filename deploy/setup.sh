#!/bin/sh
# Writes deploy/.env with random passwords and keys.  Usage: ./setup.sh [public URL]
#   ./setup.sh https://kanb.example.com     behind an https reverse proxy (normal)
#   ./setup.sh                              try it out at http://localhost:8080
set -eu
cd "$(dirname "$0")"
if [ -e .env ]; then
  echo ".env already exists; not overwriting it (it holds your passwords and SECRET_KEY)." >&2
  exit 1
fi
command -v openssl >/dev/null || { echo "openssl is needed to generate passwords." >&2; exit 1; }
url=${1:-http://localhost:8080}
url=${url%/}
case $url in
  https://*) secure=true ;;
  *) secure=false ;;
esac
umask 077
code=$(openssl rand -hex 3)-$(openssl rand -hex 3)
cat > .env <<ENV
KANB_URL=$url
COOKIE_SECURE=$secure
KANB_BIND=127.0.0.1:8080
KANB_DATA=./data
TZ=${TZ:-UTC}
POSTGRES_PASSWORD=$(openssl rand -hex 24)
S3_ACCESS_KEY=kanb
S3_SECRET_KEY=$(openssl rand -hex 24)
SECRET_KEY=$(openssl rand -hex 32)
TRUST_PROXY=true
SETUP_CODE=$code
ENV
cat <<MSG
Wrote deploy/.env for $url (see .env.example for every setting).
Back up SECRET_KEY from it together with your data.

Next:
  docker compose up -d --build
  then open $url and create the first admin with setup code:  $code
MSG
