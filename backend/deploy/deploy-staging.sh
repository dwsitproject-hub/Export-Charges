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
PROJECT_DIR=$(setting STORAGE_HOST_PROJECT_DIR)
DEPLOYMENT=$(setting STORAGE_DEPLOYMENT); DEPLOYMENT=${DEPLOYMENT:-dev}
SLUG=$(setting STORAGE_PROJECT_SLUG); SLUG=${SLUG:-ECR}
[[ -n $PROJECT_DIR ]] || { echo "Set STORAGE_HOST_PROJECT_DIR in $ENV_FILE (where NAS folder APPs/$DEPLOYMENT/$SLUG is mounted, e.g. /mnt/synology-ecr)." >&2; exit 1; }

# Which commit is deployed, and whether GitHub has a newer one (a rollback deploys an older commit on purpose).
timeout 30 git fetch -q origin 2>/dev/null || echo "Could not reach GitHub to check for newer commits." >&2
DEPLOY_SHA=$(git rev-parse --short HEAD)
if LATEST_SHA=$(git rev-parse --short '@{u}' 2>/dev/null) && [[ $DEPLOY_SHA != "$LATEST_SHA" ]]    && git merge-base --is-ancestor HEAD '@{u}'; then
  echo "Note: deploying $DEPLOY_SHA, but GitHub's $(git rev-parse --abbrev-ref '@{u}') is at $LATEST_SHA." >&2
  echo "      Run 'sudo git pull --ff-only' first, unless you mean to deploy this older commit." >&2
fi

# Other applications share this server: the port must be free, or held by this API already.
if ss -ltn "( sport = :$PORT )" | grep -q ":$PORT" \
   && ! docker ps --format '{{.Names}} {{.Ports}}' | grep -q "^ecr-api-staging .*:$PORT->"; then
  echo "Port $PORT is already used by another program:" >&2
  ss -ltnp "( sport = :$PORT )" >&2 || true
  exit 1
fi

# Files live in ECR's own folder on the shared Synology NAS. Check only — never create or change anything there:
# other systems use the same share.
if [[ ! -d "$PROJECT_DIR" ]]; then
  echo "$PROJECT_DIR does not exist. NAS folder APPs/$DEPLOYMENT/$SLUG must be created and mounted there (docs/DEPLOY-STAGING.md);" >&2
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

echo "Building $(git rev-parse --short HEAD) ..."
"${COMPOSE[@]}" build

# The API runs as uid 1000: it must be able to write in ECR's folder (one test file, removed at once).
if ! docker run --rm --network none --user 1000:1000 --entrypoint sh -v "$PROJECT_DIR:/check" ecr-api:staging      -c 'f=/check/.ecr-write-check-$$ && echo ok > "$f" && rm -f "$f"'; then
  echo "uid 1000 cannot write in $PROJECT_DIR. The share's mount options (uid/gid or file_mode/dir_mode) must allow it — ask infra." >&2
  exit 1
fi
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
