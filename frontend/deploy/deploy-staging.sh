#!/usr/bin/env bash
# Builds and (re)starts the ECR web app on the staging FE server (172.28.92.56).
#   cd /opt/export-charges && git pull --ff-only && sudo bash frontend/deploy/deploy-staging.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

ENV_FILE=frontend/.env.staging
COMPOSE=(docker compose --env-file "$ENV_FILE" -f frontend/docker-compose.staging.yml)

[[ -f $ENV_FILE ]] || { echo "Missing $ENV_FILE: copy frontend/.env.staging.example and fill it in." >&2; exit 1; }
if grep -q 'CHANGE_ME' "$ENV_FILE"; then
  echo "$ENV_FILE still has values to fill in (or empty them to build without the Hub SDK):" >&2
  grep -n 'CHANGE_ME' "$ENV_FILE" >&2
  exit 1
fi
setting() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-; }
PORT=$(setting ECR_WEB_PORT); PORT=${PORT:-3160}
UPSTREAM=$(setting ECR_API_UPSTREAM); UPSTREAM=${UPSTREAM:-http://172.28.92.57:4160}

# Other applications share this server: the port must be free, or held by this web app already.
if ss -ltn "( sport = :$PORT )" | grep -q ":$PORT" \
   && ! docker ps --format '{{.Names}} {{.Ports}}' | grep -q "^ecr-web-staging .*:$PORT->"; then
  echo "Port $PORT is already used by another program:" >&2
  ss -ltnp "( sport = :$PORT )" >&2 || true
  exit 1
fi

# The API must be up first (backend/deploy/deploy-staging.sh on the BE server).
curl -fsS "$UPSTREAM/api/health" >/dev/null || { echo "Cannot reach the API at $UPSTREAM: deploy the backend first." >&2; exit 1; }

# The release the Hub SDK reports, so Sentinel reads the code users actually run.
export VITE_GIT_SHA
VITE_GIT_SHA=$(git rev-parse --short HEAD)
echo "Building $VITE_GIT_SHA ..."
"${COMPOSE[@]}" build
"${COMPOSE[@]}" up -d

echo "Waiting for the web app on port $PORT ..."
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    "${COMPOSE[@]}" ps
    echo "ECR web app ready on port $PORT ($VITE_GIT_SHA), /api proxied to $UPSTREAM."
    exit 0
  fi
  sleep 2
done
echo "The web app did not become ready. Last logs:" >&2
"${COMPOSE[@]}" logs --tail 80 web >&2
exit 1
