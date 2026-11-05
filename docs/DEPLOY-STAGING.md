# ECR staging deployment

How the Export Charges Registry (ECR) runs on staging, and the one-time steps around it.

```
Browser ──► FE server 172.28.92.56:3160   ecr-web-staging (nginx: web app, /api proxied)
                      │ /api
                      ▼
            BE server 172.28.92.57:4160   ecr-api-staging (NestJS API, scheduled jobs)
                      │
                      ├──► ApsaraDB RDS  pgm-d9jx9o06qae8gf3h.pgsql.ap-southeast-5.rds.aliyuncs.com:5432
                      ├──► staging DWS Hub  (OIDC token and JWKS)
                      └──► peraturan.bpk.go.id, jdih.kemenkeu.go.id, jdih.kemendag.go.id, fiskal.kemenkeu.go.id (source watch)
Browser ──► staging DWS Hub  (sign-in; Hub SDK script and analytics)
```

| | FE server 172.28.92.56 | BE server 172.28.92.57 |
|---|---|---|
| Container | `ecr-web-staging` | `ecr-api-staging` (+ `ecr-migrate-staging`, runs once per deploy) |
| Port | **3160** on all interfaces | **4160** on 172.28.92.57 only |
| Compose file | `frontend/docker-compose.staging.yml` | `backend/docker-compose.staging.yml` |
| Settings | `frontend/.env.staging` (from `.env.staging.example`) | `backend/.env.staging` (from `.env.staging.example`) |
| Deploy | `sudo bash frontend/deploy/deploy-staging.sh` | `sudo bash backend/deploy/deploy-staging.sh` |

**Ports.** 3160 and 4160 are free on the respective servers (checked against the running containers and the
reserved 3110, 3111, 3120, 3121 and 3130). Each deploy script also refuses to start if another program holds its
port. To use other ports, change `ECR_WEB_PORT` / `ECR_API_PORT` (and `ECR_API_UPSTREAM` on the FE side).

Staging is plain HTTP, so `COOKIE_SECURE=false`; production needs HTTPS (see the root README).

---

## 1. Network and access (once)

| From | To | Why |
|---|---|---|
| Users (office, VPN) | FE 172.28.92.56:3160 | The application |
| FE 172.28.92.56 | BE 172.28.92.57:4160 | `/api` |
| BE 172.28.92.57 | RDS :5432 | Database — add 172.28.92.57 to the RDS **whitelist** |
| BE 172.28.92.57 | staging DWS Hub | Token exchange and signing keys |
| BE 172.28.92.57 | the four official sites above, HTTPS | Daily source watch; without it the job fails and alerts Super Admins |
| Both servers | GitHub, Docker Hub, registry.npmjs.org | Building the images |

## 2. Database on ApsaraDB RDS (once)

The instance must be **PostgreSQL 18** (the schema uses `uuidv7()`).

1. RDS console → **Accounts**: create `ecr_app` (standard account) with a strong password.
2. **Databases**: create `ecr`, owner `ecr_app`, encoding UTF8.
3. A standard RDS account may not create extensions, so create `citext` and `btree_gist` once with the instance's
   **high-privilege account**, and make sure `ecr_app` owns the database and may create tables in `public` (the
   migrations table lives there). From the BE server, without installing anything (asks for the password):
   ```bash
   sudo docker run --rm -it postgres:18 psql \
     "host=pgm-d9jx9o06qae8gf3h.pgsql.ap-southeast-5.rds.aliyuncs.com port=5432 dbname=ecr user=<high-privilege account>" \
     -c "SELECT version();" \
     -c "CREATE EXTENSION IF NOT EXISTS citext;" \
     -c "CREATE EXTENSION IF NOT EXISTS btree_gist;" \
     -c "ALTER DATABASE ecr OWNER TO ecr_app;" \
     -c "GRANT CREATE ON SCHEMA public TO ecr_app;"
   ```
   `version()` must say PostgreSQL 18. The same statements can be run in the console's DMS SQL window, connected to
   database `ecr` as the high-privilege account. Afterwards the migration's `CREATE EXTENSION IF NOT EXISTS` finds them
   and needs no special right.
4. Put the connection in `backend/.env.staging` → `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` and `DB_PASSWORD`. Enter
   the password exactly as issued, in single quotes — `DB_PASSWORD='…'` — so `$`, `#` and spaces stay as they are
   (no URL-encoding). Set `DB_SSLMODE=require` if the instance enforces SSL.
   A full `DATABASE_URL` also works, but then special characters in the password must be URL-encoded.

## 3. DWS Hub registration (once, in the **staging** Hub)

Hub Admin → **Applications** → add *Export Charges Registry (staging)* (SSO-TARGET-APP-INTEGRATION.md):

| Field | Value |
|---|---|
| `sso_mode` | `oidc` |
| `oauth_client_id` | e.g. `ecr-staging` → `OIDC_CLIENT_ID` |
| `oidc_redirect_uris` | `http://172.28.92.56:3160/api/auth/callback` |
| Target / launch URL | `http://172.28.92.56:3160/api/auth/login` |

Assign the people who should use ECR; the first sign-in creates their ECR account with the Viewer role.
`HUB_ISSUER` is the `issuer` of the staging Hub's `/api/sso/.well-known/openid-configuration`. If the BE server
reaches the Hub at another address than that issuer, set `HUB_DISCOVERY_URL` too.

**Hub SDK** (SDK-INTEGRATION-GUIDE.md) — Admin → Applications → *Export Charges Registry (staging)* → **SDK**:

- Copy the key into `frontend/.env.staging` → `VITE_HUB_SDK_KEY`, and the script address into `VITE_HUB_SDK_URL`
  (`<staging Hub>/api/sdk/v1/hub-sdk.js`). Use the staging Hub's key, not production's.
- **Allowed origins**: `http://172.28.92.56:3160` (it is the Target URL, so normally already allowed).
- ECR sends no Content-Security-Policy, so nothing else is needed. The staging Hub must be HTTP or HTTPS like ECR is
  served — an HTTP page may load an HTTPS script, not the other way round.

What the web app does with the SDK: page views, time in app, JS errors, the 🐞 bug button and breadcrumbs come from
the script; ECR calls `DwsHub.identify({ id: <Hub sub>, email })` after sign-in (from `/api/auth/me` →
`user.hubSubject`) and `DwsHub.reset()` on sign-out, and tracks `calculation_saved`, `evidence_pack_created`,
`catalogue_exported`, `change_set_submitted`, `change_set_approved` and `change_set_rejected`. The build adds
`data-release` (the git commit) and keeps function names, so stack traces are readable.

**Sentinel** (SENTINEL-GUIDE.md) — Admin → Analytic → *Export Charges Registry (staging)* → **Sentinel settings**:

| Field | Value |
|---|---|
| GitHub repository | `dwsitproject-hub/Export-Charges` |
| Branch | `main` (the SDK reports the exact release commit) |
| Application folder | leave empty (the repository holds `frontend/` and `backend/`) |
| Analyse automatically | ✓ |

Notes for Sentinel:

> Export Charges Registry (ECR): Indonesian export duty (BK) and levy (PE) for palm products. React 19 + Vite SPA in
> `frontend/` (nginx serves it and proxies `/api`); NestJS 11 API in `backend/` with PostgreSQL 18 and plain SQL
> (`backend/src`, migrations in `backend/migrations`). Sign-in through DWS Hub OIDC; privileged roles must confirm an
> ECR authenticator code (API answers `STEP_UP_REQUIRED`, the web app shows a dialog). Data changes only through
> maker-checker change sets; charges are computed in `backend/src/tariffs/charge-engine.ts` from published data
> versions. "Value missing" in the catalogue or calculator is expected when the month's CPO reference price or the
> week's KMK rate has not been entered yet. Scheduled jobs in `backend/src/jobs`, source watch in
> `backend/src/source-watch`.

The Hub's read-only GitHub token must include `dwsitproject-hub/Export-Charges` (fine-grained tokens list repositories
explicitly); **Test repository access** should show `main` and its latest commit.

## 4. The code on each server (once)

Both servers build from a clone in `/opt/export-charges`. Give each server its own **read-only deploy key**:

```bash
sudo ssh-keygen -t ed25519 -C "export-charges staging $(hostname)" -f /root/.ssh/id_ed25519_exportcharges -N ""
sudo cat /root/.ssh/id_ed25519_exportcharges.pub   # GitHub → Export-Charges → Settings → Deploy keys (no write access)
sudo tee -a /root/.ssh/config >/dev/null <<'EOF'
Host github-exportcharges
  HostName github.com
  User git
  IdentityFile /root/.ssh/id_ed25519_exportcharges
  IdentitiesOnly yes
EOF
sudo git clone git@github-exportcharges:dwsitproject-hub/Export-Charges.git /opt/export-charges
```

## 5. Backend (BE server 172.28.92.57)

```bash
cd /opt/export-charges
sudo cp backend/.env.staging.example backend/.env.staging
sudo chmod 600 backend/.env.staging
openssl rand -base64 32                  # → ECR_ENCRYPTION_KEY (keep it: it encrypts authenticator secrets)
sudo nano backend/.env.staging           # fill every CHANGE_ME
sudo bash backend/deploy/deploy-staging.sh
```

The script checks ECR's folder on the Synology NAS (below), builds the images, runs the migrations
(`ecr-migrate-staging`), starts `ecr-api-staging` on 172.28.92.57:4160 and waits for `/api/ready`.

**File storage on the Synology NAS** (SYNOLOGY-INTEGRATION.md). Every file ECR stores — the official PDFs, Excel
imports, exports, evidence packs and access-review reports — goes to ECR's own folder on the shared NAS:
File Station `APPs → dev → ECR`, on the server `${STORAGE_HOST_MOUNT}/dev/ECR` (default `/mnt/synology/eos/dev/ECR`).
Other systems use the same share, so ECR is kept to that folder:

- Only that folder is bound into the container (at `/mnt/synology/dev/ECR`); the rest of the share is not visible.
- Neither Docker (`create_host_path: false`) nor ECR creates it, and nothing changes owners or permissions on the share.
- The deploy script stops when `STORAGE_HOST_MOUNT` is not a network mount (the NAS is not mounted), when
  `…/dev` or `…/dev/ECR` is missing, or when uid 1000 (the API's user) cannot write there; its write test creates one
  temporary file in ECR's folder and removes it. The API checks the folder again at start.

Before the first deploy, have `APPs → dev → ECR` created in File Station (or ask infra), writable by the user the
share is mounted as for uid 1000. Use `STORAGE_DEPLOYMENT=prod` only for production.

**First load of the official data.** Staging starts empty. One command loads what was prepared and checked locally —
6 official PDFs (Permenperin 32/2024, PMK 68/2025, PMK 69/2025, PMK 9/2026, Kepmendag 2064/2026, KMK 53/MK/EF.2/2026),
the PALM commodity and groups I–V, 4 regulations, 122 products, the BK and PE schedules with 26 + 34 lines, the CPO
bands, the November 2026 CPO reference price and the 4–10 November KMK rate — and **publishes it at once, without a
Checker**. It runs only on an empty registry, under an existing ECR account (sign in once first), and is audited as
`CHANGESET_PUBLISHED_DIRECT` with the reason; the change set shows it was never reviewed.

```bash
cd /opt/export-charges
sudo docker compose --env-file backend/.env.staging -f backend/docker-compose.staging.yml exec api   node dist/scripts/seed-official-data.js --as jerry.hakim@energi-up.com --reason "Initial load of staging from the official PDFs"
```

It downloads each PDF from its official address and refuses any whose SHA-256 differs from the copy the data was
checked against. Without internet access on the server, copy the six PDFs into the container
(`sudo docker cp <folder> ecr-api-staging:/tmp/pdfs`) and add `--files /tmp/pdfs`. The KMK rate covers 4–10 November
only; later weeks' rates and December's CPO price are entered as usual (the source watch reports new decrees).

**First Super Admins** (SoD-4 needs two). Each person signs in once through the Hub, then:

```bash
cd /opt/export-charges
sudo docker compose --env-file backend/.env.staging -f backend/docker-compose.staging.yml run --rm migrate \
  npx tsx src/scripts/grant-role.ts --email alice@corp.example --role SUPER_ADMIN --reason "Staging platform owner"
```

From then on roles are managed on the *Users* page.

## 6. Frontend (FE server 172.28.92.56)

```bash
cd /opt/export-charges
sudo cp frontend/.env.staging.example frontend/.env.staging
sudo nano frontend/.env.staging          # Hub SDK address and key (or leave both empty to build without the SDK)
sudo bash frontend/deploy/deploy-staging.sh
```

The script checks that the API answers, builds the web app with the Hub SDK and the commit as release, starts
`ecr-web-staging` on port 3160 and checks `/` and `/api/health` through the proxy.

## 7. Check

1. `http://172.28.92.56:3160` → *Sign in with DWS Hub* → back in ECR as Viewer.
2. Hub: Admin → Applications → SDK says **Receiving data**; Analytic shows the signed-in user (not anonymous).
3. As Super Admin: *Jobs* → `source-watch` → *Run now*: OK (otherwise the BE server cannot reach the official sites).
4. Sentinel settings → **Test repository access** shows `main`.
5. Click the 🐞 button, send a test report; it appears under Analytic with Sentinel's analysis.

After the first load (section 5), regulations, products, prices and KMK rates change through change sets (or the
Excel import), as in production. `APPs → dev → ECR` in File Station holds the stored files under `sources/`,
`imports/`, `exports/`, `evidence/` and `access-reviews/`.

## 8. Updating and rolling back

```bash
cd /opt/export-charges && sudo git pull --ff-only
sudo bash backend/deploy/deploy-staging.sh      # BE server, first when the API changed
sudo bash frontend/deploy/deploy-staging.sh     # FE server
```

To go back to an earlier commit: `sudo git checkout <commit>` and run the scripts again. Migrations only add to the
schema; a migration that must be undone needs a new migration.

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Script: `still has values to fill in` | A `CHANGE_ME` is left in the `.env.staging` file it names. |
| Script: `… is not on the Synology share` | The NAS is not mounted at `STORAGE_HOST_MOUNT`, or that setting is wrong. Mounting is infra's. |
| Script: `ECR's folder … does not exist` | Create `APPs → dev → ECR` in File Station (or ask infra). ECR never creates it. |
| Script: `uid 1000 cannot write in …` | The share's mount must let uid 1000 write (SMB mount options `uid`/`gid` or `file_mode`/`dir_mode`) — infra. |
| API log: `The storage folder … does not exist` | Same as above: the folder is missing or not bound; the API does not start without it. |
| Seed: `already has … published data version(s)` | The first load already ran; later data goes through change sets. |
| Seed: `SHA-256 … differs` | The publisher changed the file; do not load it — check the new official version first. |
| Script: `Port … is already used by another program` | Choose another port in `.env.staging` (and `ECR_API_UPSTREAM` for the API). |
| `service "migrate" didn't complete successfully` | The script prints the migration log below it; or run `sudo docker logs ecr-migrate-staging`. Its last lines name the database, the error and the likely cause (rows below). |
| `ETIMEDOUT` | No answer from RDS: add 172.28.92.57 to the RDS whitelist, or open the security group / route to port 5432. |
| `DATABASE_URL is not a valid URL` | A special character in the password (`/ ? # @ %`, space) is not URL-encoded. Use `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` instead (section 2). |
| `ECONNREFUSED` / `ENOTFOUND` | Wrong `DB_HOST` or `DB_PORT`, or the server's DNS cannot resolve the RDS host. |
| `28P01 password authentication failed` | Wrong `DB_USER` or `DB_PASSWORD`; write the password in single quotes (`DB_PASSWORD='…'`), as Docker Compose otherwise cuts it at ` #` and replaces `$…`. |
| `28000 no pg_hba.conf entry` | The instance refuses this client: whitelist 172.28.92.57, or set `DB_SSLMODE=require` if it needs SSL. |
| `3D000 database "ecr" does not exist` | Create the database in the RDS console (section 2). |
| `42501 permission denied to create extension` | Create `citext` and `btree_gist` with the high-privilege account (section 2, step 3). |
| `42501 permission denied for schema public` | Run the `ALTER DATABASE … OWNER` and `GRANT CREATE ON SCHEMA public` lines of section 2, step 3. |
| `42883 function uuidv7() does not exist` | The RDS instance is older than PostgreSQL 18. |
| FE script: `Cannot reach the API` | Backend not deployed, or 172.28.92.56 → 172.28.92.57:4160 blocked. |
| `403 NETWORK_NOT_ALLOWED` | The user's address is outside `ALLOWED_NETWORKS`. |
| Sign-in ends on *DWS Hub is unavailable* | The BE server cannot reach the Hub, or `HUB_ISSUER` is wrong (`docker logs ecr-api-staging`). |
| Sign-in ends on *could not be verified* | `HUB_ISSUER` differs from the Hub's `issuer`, or `OIDC_CLIENT_ID` from the registration. |
| Hub SDK: `403 origin_not_allowed` | Add `http://172.28.92.56:3160` under SDK → Allowed origins. |
| Users show as anonymous in the Hub | They signed in before the SDK was added; next sign-in identifies them. |

Logs: `sudo docker logs -f ecr-api-staging` (BE), `sudo docker logs -f ecr-web-staging` (FE).
