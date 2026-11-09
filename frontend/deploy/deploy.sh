#!/usr/bin/env bash
# Builds and (re)starts the ECR web app on an FE server; nginx in the container proxies /api to the BE server.
#   sudo bash frontend/deploy/deploy.sh staging    (or deploy-staging.sh)  — FE server 172.28.92.56
#   sudo bash frontend/deploy/deploy.sh prod       (or deploy-prod.sh)     — FE server 172.28.80.50
set -Eeuo pipefail
# Never stop without saying where and why.
trap 'echo "deploy.sh stopped at line $LINENO (exit $?): $BASH_COMMAND" >&2' ERR
cd "$(dirname "$0")/../.."

TARGET=${1:-}
case "$TARGET" in
  staging) DEFAULT_UPSTREAM=http://172.28.92.57:4160 ;;
  prod)    DEFAULT_UPSTREAM=http://172.28.80.51:4160 ;;
  *) echo "Usage: sudo bash frontend/deploy/deploy.sh staging|prod" >&2; exit 2 ;;
esac
ENV_FILE=frontend/.env.$TARGET
COMPOSE_FILE=frontend/docker-compose.$TARGET.yml
WEB_CONTAINER=ecr-web-$TARGET
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
echo "ECR $TARGET frontend deploy: checking $ENV_FILE ..."

[[ -f $ENV_FILE ]] || { echo "Missing $ENV_FILE: copy $ENV_FILE.example and fill it in." >&2; exit 1; }
if grep -qE '^[^#]*CHANGE_ME' "$ENV_FILE"; then
  echo "$ENV_FILE still has values to fill in (or empty them to build without the Hub SDK):" >&2
  grep -nE '^[^#]*CHANGE_ME' "$ENV_FILE" >&2
  exit 1
fi
# A setting's value ('' when the line is absent, so the defaults below apply), without quotes or Windows line endings.
setting() {
  local v
  v=$(grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '\r') || true
  v=${v%\"}; v=${v#\"}; v=${v%\'}; v=${v#\'}
  printf '%s' "$v"
}
PORT=$(setting ECR_WEB_PORT); PORT=${PORT:-3160}
UPSTREAM=$(setting ECR_API_UPSTREAM); UPSTREAM=${UPSTREAM:-$DEFAULT_UPSTREAM}

# Which commit is deployed, and whether GitHub has a newer one (a rollback deploys an older commit on purpose).
timeout 30 git fetch -q --tags origin 2>/dev/null || echo "Could not reach GitHub to check for newer commits." >&2
DEPLOY_SHA=$(git rev-parse --short HEAD)
RELEASE=$(git describe --tags --exact-match HEAD 2>/dev/null || echo "$DEPLOY_SHA")
if LATEST_SHA=$(git rev-parse --short '@{u}' 2>/dev/null) && [[ $DEPLOY_SHA != "$LATEST_SHA" ]] \
   && git merge-base --is-ancestor HEAD '@{u}'; then
  echo "Note: deploying $DEPLOY_SHA, but GitHub's $(git rev-parse --abbrev-ref '@{u}') is at $LATEST_SHA." >&2
  echo "      Run 'sudo git pull --ff-only' first, unless you mean to deploy this older commit." >&2
fi
# Production runs exactly what is on GitHub: no local edits to the code (the .env files are not tracked).
if [[ $TARGET == prod ]] && [[ -n $(git status --porcelain --untracked-files=no) ]]; then
  echo "The code in $(pwd) has local changes; production deploys only committed code:" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

# Other applications share this server: the port must be free, or held by this web app already.
if ss -ltn "( sport = :$PORT )" | grep -q ":$PORT" \
   && ! docker ps --format '{{.Names}} {{.Ports}}' | grep -q "^$WEB_CONTAINER .*:$PORT->"; then
  echo "Port $PORT is already used by another program:" >&2
  ss -ltnp "( sport = :$PORT )" >&2 || true
  exit 1
fi

# The API must be up first (backend/deploy/deploy-$TARGET.sh on the BE server).
curl -fsS "$UPSTREAM/api/health" >/dev/null || { echo "Cannot reach the API at $UPSTREAM: deploy the backend first, or check the firewall between the servers." >&2; exit 1; }

# The release the Hub SDK reports, so Sentinel reads the code users actually run.
export VITE_GIT_SHA=$DEPLOY_SHA
echo "Building $RELEASE ..."
"${COMPOSE[@]}" build
"${COMPOSE[@]}" up -d

echo "Waiting for the web app on port $PORT ..."
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    "${COMPOSE[@]}" ps
    echo "ECR $TARGET web app ready on port $PORT ($RELEASE), /api proxied to $UPSTREAM."
    exit 0
  fi
  sleep 2
done
echo "The web app did not become ready. Last logs:" >&2
"${COMPOSE[@]}" logs --tail 80 web >&2
exit 1
