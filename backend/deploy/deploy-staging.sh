#!/usr/bin/env bash
# Builds and (re)starts the ECR API on the staging BE server (172.28.92.57), then runs the database migrations.
#   cd /opt/export-charges && git pull --ff-only && sudo bash backend/deploy/deploy-staging.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

ENV_FILE=backend/.env.staging
COMPOSE=(docker compose --env-file "$ENV_FILE" -f backend/docker-compose.staging.yml)

[[ -f $ENV_FILE ]] || { echo "Missing $ENV_FILE: copy backend/.env.staging.example and fill it in." >&2; exit 1; }
if grep -q 'CHANGE_ME' "$ENV_FILE"; then
  echo "$ENV_FILE still has values to fill in:" >&2
  grep -n 'CHANGE_ME' "$ENV_FILE" >&2
  exit 1
fi
setting() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-; }
BIND=$(setting ECR_API_BIND); BIND=${BIND:-172.28.92.57}
PORT=$(setting ECR_API_PORT); PORT=${PORT:-4160}
DATA=$(setting ECR_DATA_DIR); DATA=${DATA:-/opt/export-charges/data}

# Other applications share this server: the port must be free, or held by this API already.
if ss -ltn "( sport = :$PORT )" | grep -q ":$PORT" \
   && ! docker ps --format '{{.Names}} {{.Ports}}' | grep -q "^ecr-api-staging .*:$PORT->"; then
  echo "Port $PORT is already used by another program:" >&2
  ss -ltnp "( sport = :$PORT )" >&2 || true
  exit 1
fi

# The API runs as uid 1000 (node) and keeps uploaded documents and exports here.
mkdir -p "$DATA/storage"
chown -R 1000:1000 "$DATA"

echo "Building $(git rev-parse --short HEAD) ..."
"${COMPOSE[@]}" build
if ! "${COMPOSE[@]}" up -d; then
  echo "Start failed. Migration log (ecr-migrate-staging):" >&2
  docker logs ecr-migrate-staging 2>&1 | tail -40 >&2
  echo "See docs/DEPLOY-STAGING.md, Troubleshooting." >&2
  exit 1
fi
docker logs ecr-migrate-staging 2>&1 | tail -5

echo "Waiting for the API on http://$BIND:$PORT ..."
for _ in $(seq 1 40); do
  if curl -fsS "http://$BIND:$PORT/api/ready" >/dev/null 2>&1; then
    "${COMPOSE[@]}" ps
    echo "ECR API ready on http://$BIND:$PORT ($(git rev-parse --short HEAD))."
    exit 0
  fi
  sleep 3
done
echo "The API did not become ready. Last logs:" >&2
"${COMPOSE[@]}" logs --tail 80 migrate api >&2
exit 1
