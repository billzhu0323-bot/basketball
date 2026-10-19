#!/usr/bin/env bash
# One-shot local bootstrap: env file + secrets, Postgres, deps, schema, seed.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v node >/dev/null || { echo "Node.js 20+ is required"; exit 1; }

if [ ! -f .env ]; then
  cp .env.example .env
  rand() { openssl rand -base64 "$1" | tr -d '\n'; }
  # Use | as the sed delimiter; base64 contains '/' and '+'.
  sed -i.bak \
    -e "s|^AUTH_JWT_SECRET=.*|AUTH_JWT_SECRET=$(rand 48)|" \
    -e "s|^STATE_SIGNING_SECRET=.*|STATE_SIGNING_SECRET=$(rand 48)|" \
    -e "s|^TOKEN_ENCRYPTION_KEY=.*|TOKEN_ENCRYPTION_KEY=$(rand 32)|" \
    .env && rm -f .env.bak
  echo "created .env with fresh secrets"
fi

if [ "${SKIP_DOCKER:-0}" != "1" ]; then
  docker compose up -d db
  echo -n "waiting for postgres"
  until docker compose exec -T db pg_isready -U localpulse -d localpulse >/dev/null 2>&1; do echo -n .; sleep 1; done
  echo
fi

npm install
npm run db:migrate
npm run db:seed
echo
echo "Done. Next:  npm run dev   (API)   |   npm run worker   (SMS dispatcher)"
