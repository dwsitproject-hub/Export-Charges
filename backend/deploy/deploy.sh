#!/usr/bin/env bash
# Builds and (re)starts the ECR API on a BE server, then runs the database migrations.
#   sudo bash backend/deploy/deploy.sh staging    (or deploy-staging.sh)  — BE server 172.28.92.57
#   sudo bash backend/deploy/deploy.sh prod       (or deploy-prod.sh)     — BE server 172.28.80.51
set -Eeuo pipefail
# Never stop without saying where and why.
trap 'echo "deploy.sh stopped at line $LINENO (exit $?): $BASH_COMMAND" >&2' ERR
cd "$(dirname "$0")/../.."

TARGET=${1:-}
case "$TARGET" in
  staging) DEFAULT_BIND=172.28.92.57; EXPECTED_DEPLOYMENT=dev ;;
  prod)    DEFAULT_BIND=172.28.80.51; EXPECTED_DEPLOYMENT=prod ;;
  *) echo "Usage: sudo bash backend/deploy/deploy.sh staging|prod" >&2; exit 2 ;;
esac
ENV_FILE=backend/.env.$TARGET
COMPOSE_FILE=backend/docker-compose.$TARGET.yml
API_CONTAINER=ecr-api-$TARGET
MIGRATE_CONTAINER=ecr-migrate-$TARGET
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
echo "ECR $TARGET backend deploy: checking $ENV_FILE ..."

[[ -f $ENV_FILE ]] || { echo "Missing $ENV_FILE: copy $ENV_FILE.example and fill it in." >&2; exit 1; }
if grep -qE '^[^#]*CHANGE_ME' "$ENV_FILE"; then
  echo "$ENV_FILE still has values to fill in:" >&2
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
BIND=$(setting ECR_API_BIND); BIND=${BIND:-$DEFAULT_BIND}
PORT=$(setting ECR_API_PORT); PORT=${PORT:-4160}
PROJECT_DIR=$(setting STORAGE_HOST_PROJECT_DIR)
DEPLOYMENT=$(setting STORAGE_DEPLOYMENT); DEPLOYMENT=${DEPLOYMENT:-dev}
SLUG=$(setting STORAGE_PROJECT_SLUG); SLUG=${SLUG:-ECR}
[[ -n $PROJECT_DIR ]] || { echo "Set STORAGE_HOST_PROJECT_DIR in $ENV_FILE (where NAS folder APPs/$EXPECTED_DEPLOYMENT/$SLUG is mounted, e.g. /mnt/synology-ecr)." >&2; exit 1; }
# Production files go to APPs/prod/…, staging files to APPs/dev/…: never the other one's folder.
if [[ $DEPLOYMENT != "$EXPECTED_DEPLOYMENT" ]]; then
  echo "STORAGE_DEPLOYMENT=$DEPLOYMENT in $ENV_FILE, but $TARGET uses $EXPECTED_DEPLOYMENT (NAS folder APPs/$EXPECTED_DEPLOYMENT/$SLUG)." >&2
  exit 1
fi

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

# Other applications share this server: the port must be free, or held by this API already.
if ss -ltn "( sport = :$PORT )" | grep -q ":$PORT" \
   && ! docker ps --format '{{.Names}} {{.Ports}}' | grep -q "^$API_CONTAINER .*:$PORT->"; then
  echo "Port $PORT is already used by another program:" >&2
  ss -ltnp "( sport = :$PORT )" >&2 || true
  exit 1
fi

# Files live in ECR's own folder on the shared Synology NAS. Check only — never create or change anything there:
# other systems use the same share.
if [[ ! -d "$PROJECT_DIR" ]]; then
  echo "$PROJECT_DIR does not exist. NAS folder APPs/$DEPLOYMENT/$SLUG must be created and mounted there (docs/DEPLOY-${TARGET^^}.md);" >&2
  echo "ECR does not create folders or mounts." >&2
  exit 1
fi
FSTYPE=$(findmnt -n -o FSTYPE --target "$PROJECT_DIR" 2>/dev/null || true)
case "$FSTYPE" in
  cifs|smb3|nfs|nfs4|fuse.*) ;;
  *) echo "$PROJECT_DIR is not on the Synology share (file system: ${FSTYPE:-none}): the NAS folder is not mounted there." >&2
     exit 1 ;;
esac
# The mount must be ECR's own NAS folder (not another application's) and writable.
MNT_TARGET=$(findmnt -n -o TARGET --target "$PROJECT_DIR")
MNT_SOURCE=$(findmnt -n -o SOURCE --target "$PROJECT_DIR")
MNT_OPTIONS=$(findmnt -n -o OPTIONS --target "$PROJECT_DIR")
NAS_PATH="${MNT_SOURCE%/}${PROJECT_DIR#"$MNT_TARGET"}"
if [[ ${NAS_PATH,,} != */apps/${DEPLOYMENT,,}/${SLUG,,} ]]; then
  echo "$PROJECT_DIR is NAS folder $NAS_PATH, not APPs/$DEPLOYMENT/$SLUG. Check STORAGE_HOST_PROJECT_DIR — it must not be another application's folder." >&2
  exit 1
fi
if [[ ,$MNT_OPTIONS, == *,ro,* ]]; then
  echo "$PROJECT_DIR ($NAS_PATH) is mounted read-only; ECR's folder must be mounted read-write." >&2
  exit 1
fi
echo "Storage: $PROJECT_DIR = $NAS_PATH ($FSTYPE)"

echo "Building $RELEASE ..."
"${COMPOSE[@]}" build

# The API runs as uid 1000: it must be able to write in ECR's folder (one test file, removed at once).
if ! docker run --rm --network none --user 1000:1000 --entrypoint sh -v "$PROJECT_DIR:/check" "ecr-api:$TARGET" \
     -c 'f=/check/.ecr-write-check-$$ && echo ok > "$f" && rm -f "$f"'; then
  echo "uid 1000 cannot write in $PROJECT_DIR. The share's mount options (uid/gid or file_mode/dir_mode) must allow it — ask infra." >&2
  exit 1
fi
if ! "${COMPOSE[@]}" up -d; then
  echo "Start failed. Migration log ($MIGRATE_CONTAINER):" >&2
  docker logs "$MIGRATE_CONTAINER" 2>&1 | tail -40 >&2
  echo "See docs/DEPLOY-${TARGET^^}.md, Troubleshooting." >&2
  exit 1
fi
docker logs "$MIGRATE_CONTAINER" 2>&1 | tail -5

echo "Waiting for the API on http://$BIND:$PORT ..."
for _ in $(seq 1 40); do
  if curl -fsS "http://$BIND:$PORT/api/ready" >/dev/null 2>&1; then
    "${COMPOSE[@]}" ps
    echo "ECR $TARGET API ready on http://$BIND:$PORT ($RELEASE)."
    exit 0
  fi
  sleep 3
done
echo "The API did not become ready. Last logs:" >&2
"${COMPOSE[@]}" logs --tail 80 migrate api >&2
exit 1
