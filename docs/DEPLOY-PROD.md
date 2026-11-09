# ECR production deployment

How to put the Export Charges Registry (ECR) into production, step by step, and how to run it afterwards. It is
built the same way as staging ([DEPLOY-STAGING.md](DEPLOY-STAGING.md)) — the same images, scripts and checks — on the
production servers, database, NAS folder and DWS Hub.

```
Browser ──► FE server 172.28.80.50:3160   ecr-web-prod (nginx: web app, /api proxied)
                      │ /api
                      ▼
            BE server 172.28.80.51:4160   ecr-api-prod (NestJS API, scheduled jobs)
                      │
                      ├──► ApsaraDB RDS (prod)  pgm-d9jn3khh0b3907w4.pgsql.ap-southeast-5.rds.aliyuncs.com:5432
                      ├──► Synology NAS         //172.30.1.94/APPs/ECR  (mounted at /mnt/synology/ECR)
                      ├──► production DWS Hub   (OIDC token and JWKS)
                      ├──► corporate SMTP relay (notifications)
                      └──► peraturan.bpk.go.id, jdih.kemenkeu.go.id, jdih.kemendag.go.id, fiskal.kemenkeu.go.id (source watch)
Browser ──► production DWS Hub  (sign-in; Hub SDK script and analytics)
```

| | FE server 172.28.80.50 | BE server 172.28.80.51 |
|---|---|---|
| Container | `ecr-web-prod` | `ecr-api-prod` (+ `ecr-migrate-prod`, runs once per deploy) |
| Port | **3160** on all interfaces | **4160** on 172.28.80.51 only |
| Compose file | `frontend/docker-compose.prod.yml` | `backend/docker-compose.prod.yml` |
| Settings | `frontend/.env.prod` (from `frontend/.env.prod.example`) | `backend/.env.prod` (from `backend/.env.prod.example`) |
| Deploy | `sudo bash frontend/deploy/deploy-prod.sh` | `sudo bash backend/deploy/deploy-prod.sh` |
| Code | `/opt/export-charges`, at a release tag | `/opt/export-charges`, at the same release tag |

Do the sections in order. Sections 2–6 are one-time preparation; section 7 onwards is the deployment itself.

---

## 1. Ports

Both servers already run many applications. The ports below were checked against the running containers
(`docker ps`, 9 November 2026):

| Server | Host ports already taken | ECR uses |
|---|---|---|
| FE 172.28.80.50 | 80, 2001, 3001, 3002, 3020, 3040, 3042, 3070, 3080, 3100, 8000, 8080, 8081, 8090, 8443 | **3160** |
| BE 172.28.80.51 | 3000, 3003, 4000, 4001, 5000, 5001, 5003, 5010, 5050, 5070, 5433, 5434, 8001, 8091, 13000 | **4160** |

Ports a container only exposes inside Docker (`3000/tcp`, `5432/tcp`, `6379/tcp` without `->`) do not take a host
port. The `docker ps` list was longer than the screen, and programs outside Docker are not in it, so confirm on each
server before the first deploy — the command must print nothing:

```bash
sudo ss -ltnp | grep -E ':3160\b'     # FE server
sudo ss -ltnp | grep -E ':4160\b'     # BE server
```

The deploy scripts check again every time and stop with `Port … is already used by another program` rather than
disturb another application. If a port is taken, pick a free one and set it in **both** places: `ECR_API_PORT` in
`backend/.env.prod` and `ECR_API_UPSTREAM` in `frontend/.env.prod` (API), or `ECR_WEB_PORT` in `frontend/.env.prod`
plus the Hub registration and `PUBLIC_BASE_URL` (web app).

## 2. Before you start: who provides what

| Item | From | Used in |
|---|---|---|
| RDS account `ecr_app`, database `ecr`, high-privilege account for the extensions, whitelist for 172.28.80.51 | DBA / cloud admin | §3 |
| ECR registered in the **production** DWS Hub: client id, issuer, dashboard URL, SDK key | Hub administrator | §4 |
| NAS folder `APPs → ECR` and its mount on the BE server | IT infrastructure | §6 |
| SMTP relay (host, port, account if any, sender address) | IT / mail team | §7 |
| Firewall rules (table below) | Network team | §2 |
| Read-only GitHub deploy key per server | Repository admin | §5 |
| A release tag, e.g. `v1.0.1`, of a commit that passed staging | Release owner | §5, §12 |

**Decisions to make before go-live**

- **HTTP or HTTPS.** Like staging, this guide serves ECR over plain HTTP on the private network
  (`http://172.28.80.50:3160`, `COOKIE_SECURE=false`), reachable only from `ALLOWED_NETWORKS`. HTTPS with a DNS name
  is recommended for production; §11 lists what changes.
- **Authenticator for Super Admins.** `TOTP_EXEMPT_ROLES=SUPER_ADMIN` (as on staging) lets Super Admins work without
  the ECR authenticator. Leaving it empty makes every privileged role confirm an authenticator code before sensitive
  actions.
- **First data load without a Checker.** The first load (§9) publishes the prepared official data directly, as on
  staging. Every later change goes through maker-checker.

**Network rules**

| From | To | Why |
|---|---|---|
| Users (office, VPN) | FE 172.28.80.50:3160 | The application |
| Users | production DWS Hub | Sign-in, Hub SDK script |
| FE 172.28.80.50 | BE 172.28.80.51:4160 | `/api` |
| BE 172.28.80.51 | RDS :5432 | Database — 172.28.80.51 on the RDS **whitelist** |
| BE 172.28.80.51 | production DWS Hub (issuer address) | Token exchange and signing keys |
| BE 172.28.80.51 | NAS 172.30.1.94 :445 | File storage (SMB) |
| BE 172.28.80.51 | SMTP relay | Notification emails |
| BE 172.28.80.51 | the four official sites above, HTTPS | Daily source watch (06:00 WIB); without it the job fails and alerts Super Admins |
| Both servers | github.com:22, Docker Hub, registry.npmjs.org | Building the images |

## 3. Database on ApsaraDB RDS (once)

Production instance: `pgm-d9jn3khh0b3907w4.pgsql.ap-southeast-5.rds.aliyuncs.com`. It must be **PostgreSQL 18**
(the schema uses `uuidv7()`).

1. RDS console → **Whitelist**: add `172.28.80.51` (the BE server) — nothing broader.
2. **Accounts**: create `ecr_app` (standard account) with a strong password generated for production (not staging's).
3. **Databases**: create `ecr`, owner `ecr_app`, encoding UTF8.
4. Create the two extensions with the instance's **high-privilege account**, and let `ecr_app` own the database and
   create tables in `public`. From the BE server (asks for the password):
   ```bash
   sudo docker run --rm -it postgres:18 psql \
     "host=pgm-d9jn3khh0b3907w4.pgsql.ap-southeast-5.rds.aliyuncs.com port=5432 dbname=ecr user=<high-privilege account>" \
     -c "SELECT version();" \
     -c "CREATE EXTENSION IF NOT EXISTS citext;" \
     -c "CREATE EXTENSION IF NOT EXISTS btree_gist;" \
     -c "ALTER DATABASE ecr OWNER TO ecr_app;" \
     -c "GRANT CREATE ON SCHEMA public TO ecr_app;"
   ```
   `version()` must say PostgreSQL 18. The console's DMS SQL window (database `ecr`, high-privilege account) works too.
5. **Backup**: RDS → Backup and Restoration → automatic backups on, retention at least 7 days (30 recommended), log
   backup on (point-in-time restore). Take one manual backup before go-live.
6. If the instance enforces SSL, you will set `DB_SSLMODE=require` in §7.

## 4. DWS Hub registration (once, in the **production** Hub)

On these servers the production Hub appears to run as `downstream-hub-web` (FE, port 3100) and `downstream-hub-api`
(BE, port 4001); confirm its public address with the Hub administrator.

Hub Admin → **Applications** → add *Export Charges Registry* (SSO-TARGET-APP-INTEGRATION.md):

| Field | Value |
|---|---|
| `sso_mode` | `oidc` |
| `oauth_client_id` | e.g. `ecr-prod` → `OIDC_CLIENT_ID` |
| `oidc_redirect_uris` | `http://172.28.80.50:3160/api/auth/callback` |
| Target / launch URL | `http://172.28.80.50:3160/api/auth/login` |

Assign the people who should use ECR; their first sign-in creates an ECR account with the Viewer role. Clicking the
ECR tile in the Hub signs them in directly (ECR completes a Hub-started launch by itself).

Find the issuer from the BE server — `issuer` in the answer is `HUB_ISSUER`:

```bash
curl -s <production Hub address>/api/sso/.well-known/openid-configuration
```

The API container must reach that issuer address (§2). If the BE server can only reach the Hub at another address
(for example the Hub API on this same server, `http://172.28.80.51:4001`), keep `HUB_ISSUER` exactly as reported and
set `HUB_DISCOVERY_URL` to the reachable discovery address.

**Hub SDK** — Admin → Applications → *Export Charges Registry* → **SDK**: copy the key to `VITE_HUB_SDK_KEY` and the
script address (`<production Hub>/api/sdk/v1/hub-sdk.js`) to `VITE_HUB_SDK_URL` in `frontend/.env.prod`. **Allowed
origins**: `http://172.28.80.50:3160`. Use the production Hub's key, never staging's.

**Sentinel** — Admin → Analytic → *Export Charges Registry* → **Sentinel settings**: repository
`dwsitproject-hub/Export-Charges`, branch `main`, application folder empty, analyse automatically ✓, and the same
notes as staging ([DEPLOY-STAGING.md](DEPLOY-STAGING.md) §3). **Test repository access** must show `main`.

## 5. The code on each server (once per server)

Each server gets its own **read-only** deploy key (GitHub → Export-Charges → Settings → Deploy keys → *Add*, *Allow
write access* off):

```bash
sudo ssh-keygen -t ed25519 -C "export-charges prod $(hostname)" -f /root/.ssh/id_ed25519_exportcharges -N ""
sudo cat /root/.ssh/id_ed25519_exportcharges.pub
```

```bash
sudo tee -a /root/.ssh/config >/dev/null <<'EOF'
Host github-exportcharges
  HostName github.com
  User git
  IdentityFile /root/.ssh/id_ed25519_exportcharges
  IdentitiesOnly yes
EOF
```

```bash
sudo git clone git@github-exportcharges:dwsitproject-hub/Export-Charges.git /opt/export-charges
cd /opt/export-charges
sudo git checkout v1.0.1        # the release tag that passed staging (§12)
```

Production runs a tagged release, not whatever `main` is at. The deploy scripts print the tag they deploy and refuse to
deploy code with local edits.

## 6. ECR's folder on the Synology NAS (once, BE server)

Every file ECR stores — the official PDFs, Excel imports, exports, evidence packs and access-review reports — goes to
its own folder on the shared NAS. On the production NAS each application's folder sits **directly under `APPs`**
(unlike staging's `APPs/dev/…`), and the BE server mounts each one under `/mnt/synology/<app>`:

```
//172.30.1.94/APPs/PM                     →  /mnt/synology/PM
//172.30.1.94/APPs/EXIM/Import            →  /mnt/synology/EXIM/Import
//172.30.1.94/APPs/SUSTAINABILITY-PORTAL  →  /mnt/synology/SUSTAINABILITY-PORTAL
//172.30.1.94/APPs/ECR                    →  /mnt/synology/ECR        ← ECR (new)
```

ECR's folder is File Station **`APPs → ECR`**. Other systems use the same share, so:

- Only ECR's folder is mounted for ECR and bound into the container; the rest of the share is not visible to it.
- ECR never uses `/mnt/synology-apps` (the whole share, read-write).
- Neither Docker nor ECR creates folders or mounts, or changes owners or permissions.
- The deploy script stops unless `STORAGE_HOST_PROJECT_DIR` is a network mount of exactly `APPs/ECR` — other
  applications' folders and staging's `APPs/dev/ECR` are refused — mounted read-write and writable by uid 1000 (the
  API's user).

**By IT, or with their agreement:**

1. File Station: create the folder `APPs → ECR` (the `app-prj` account that mounts the other folders must be able to
   read and write it).
2. On the BE server, see how the other applications' folders are mounted. They are not in `/etc/fstab` (only the whole
   share is), so they come from systemd mount units or a script:
   ```bash
   systemctl list-units --type=mount --all | grep -i synology
   ```
   If `mnt-synology-PM.mount` and similar are listed, IT may prefer the same for ECR: a copy of that unit named
   `mnt-synology-ECR.mount`, with `What=//172.30.1.94/APPs/ECR`, `Where=/mnt/synology/ECR` and the options below. Otherwise
   use `/etc/fstab` as in steps 3–5.
3. Create the mount point and make it **immutable while nothing is mounted on it**. If the NAS is ever not mounted,
   nothing can then write to the server's own disk in its place, and ECR refuses to start instead of storing files
   locally (mounting over it still works):
   ```bash
   sudo mkdir -p /mnt/synology/ECR
   ```
   ```bash
   sudo chattr +i /mnt/synology/ECR
   ```
4. Back up `/etc/fstab`, then add ECR's line. It uses the same credentials file as the share's existing line
   (`/etc/smb.creds`), and uid/gid 1000 because the API runs as uid 1000. It deliberately has no `nofail`, so a missing
   NAS shows up as a failed mount, not as an empty folder:
   ```bash
   sudo cp /etc/fstab /etc/fstab.bak.$(date +%F)
   ```
   ```bash
   grep -q ' /mnt/synology/ECR ' /etc/fstab || echo '//172.30.1.94/APPs/ECR /mnt/synology/ECR cifs rw,credentials=/etc/smb.creds,uid=1000,gid=1000,forceuid,forcegid,dir_mode=0770,file_mode=0660,vers=3.0,iocharset=utf8,soft,nounix,noserverino,_netdev 0 0' | sudo tee -a /etc/fstab
   ```
5. Mount and check:
   ```bash
   sudo systemctl daemon-reload && sudo mount /mnt/synology/ECR
   ```
   ```bash
   findmnt /mnt/synology/ECR
   ```
   Expected: SOURCE `//172.30.1.94/APPs/ECR`, FSTYPE `cifs`, options starting with `rw` and including `uid=1000`.
   It comes back by itself after a reboot.

## 7. Backend (BE server 172.28.80.51)

```bash
cd /opt/export-charges
sudo cp backend/.env.prod.example backend/.env.prod
sudo chmod 600 backend/.env.prod
openssl rand -base64 32                   # → ECR_ENCRYPTION_KEY: a new one for production
sudo nano backend/.env.prod               # fill every CHANGE_ME
```

| Setting | Value |
|---|---|
| `DB_PASSWORD` | `ecr_app`'s password, in single quotes: `DB_PASSWORD='…'` |
| `DB_SSLMODE` | `require` if the instance enforces SSL (remove the `#`) |
| `HUB_ISSUER`, `OIDC_CLIENT_ID`, `HUB_DASHBOARD_URL` | From §4 (production Hub) |
| `ECR_ENCRYPTION_KEY` | The value generated above |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` | From the mail team. Without a relay yet: `MAIL_TRANSPORT=log` and delete the `SMTP_` lines |
| `ALLOWED_NETWORKS` | Narrow to the office and VPN ranges when known |
| `TOTP_EXEMPT_ROLES` | `SUPER_ADMIN`, or empty (§2) |

**Keep a copy of `backend/.env.prod` in the password vault** — above all `ECR_ENCRYPTION_KEY`: without it every
authenticator must be set up again.

Deploy:

```bash
sudo bash backend/deploy/deploy-prod.sh
```

The script, in order: checks the settings; checks the port; checks the NAS folder (prints
`Storage: /mnt/synology/ECR = //172.30.1.94/APPs/ECR (cifs)`); builds the images; tests that uid 1000 can write
in ECR's folder; runs the migrations (`ecr-migrate-prod`, ending `Database is up to date.` or the list of applied
migrations); starts `ecr-api-prod`; and waits until `http://172.28.80.51:4160/api/ready` answers. It ends with
`ECR prod API ready on http://172.28.80.51:4160 (v1.0.1).`

## 8. Frontend (FE server 172.28.80.50)

```bash
cd /opt/export-charges
sudo cp frontend/.env.prod.example frontend/.env.prod
sudo nano frontend/.env.prod              # production Hub SDK address and key (or empty both to build without the SDK)
sudo bash frontend/deploy/deploy-prod.sh
```

The script checks the API answers from this server (`http://172.28.80.51:4160/api/health`), builds the web app with
the Hub SDK and the release commit, starts `ecr-web-prod` on port 3160 and checks `/` and `/api/health` through the
proxy. It ends with `ECR prod web app ready on port 3160 (v1.0.1), /api proxied to http://172.28.80.51:4160.`

## 9. First sign-in, Super Admins and the first data load

The order matters: the data load runs under an existing ECR account.

1. **Sign in once** at `http://172.28.80.50:3160` (or from the Hub tile) as the platform owner — the account is
   created with the Viewer role.
2. **Make the first Super Admins** (SoD-4 needs two people; each signs in once first). On the BE server:
   ```bash
   cd /opt/export-charges
   sudo docker compose --env-file backend/.env.prod -f backend/docker-compose.prod.yml run --rm migrate \
     npx tsx src/scripts/grant-role.ts --email jerry.hakim@energi-up.com --role SUPER_ADMIN --reason "Production platform owner"
   ```
   From then on roles are managed on the *Users* page.
3. **Load the official data** (once, on the empty production registry):
   ```bash
   cd /opt/export-charges
   sudo docker compose --env-file backend/.env.prod -f backend/docker-compose.prod.yml exec api \
     node dist/scripts/seed-official-data.js --as jerry.hakim@energi-up.com --reason "Initial load of production from the official PDFs"
   ```
   It downloads the six official PDFs (Permenperin 32/2024, PMK 68/2025, PMK 69/2025, PMK 9/2026, Kepmendag
   2064/2026, KMK 53/MK/EF.2/2026), refuses any whose SHA-256 differs from the checked copy, stores them in
   `APPs → ECR → sources`, and publishes data version 1: the PALM commodity, groups I–V, 4 regulations,
   122 products, the BK and PE schedules (26 + 34 lines), the CPO bands, the November 2026 CPO reference price and the
   4–10 November 2026 KMK rate. It is audited as `CHANGESET_PUBLISHED_DIRECT` with the reason. Without internet on the
   server: `sudo docker cp <folder with the six PDFs> ecr-api-prod:/tmp/pdfs` and add `--files /tmp/pdfs`.
4. **Bring the prices up to date** through a normal change set (Maker enters, Checker approves): the current month's
   CPO reference price (Kepmendag) and the current week's KMK rate, if go-live is after November 2026 or after
   10 November. Until then the catalogue shows *Value missing* for the affected charges or Rupiah amounts. The source
   watch reports new decrees every morning.

## 10. Go-live checks

| # | Check | Expected |
|---|---|---|
| 1 | Open `http://172.28.80.50:3160` from an office PC | Goes straight to DWS Hub, back to ECR Home signed in |
| 2 | Click the ECR tile in the production Hub | Signed in on Home, no "Try again" |
| 3 | Home | *Check a product*, today's CPO price and KMK rate, the 122 palm oil products with duty, levy and total |
| 4 | Check *Crude Palm Oil (CPO)* | Duty, levy, total and the regulation lines behind them |
| 5 | *Official PDFs* (Sources) → open one | The PDF opens; File Station shows it under `APPs → ECR → sources` |
| 6 | Calculator: CPO, 1 tonne, save, create evidence pack | Saved; evidence PDF downloads and verifies |
| 7 | As Super Admin: *Jobs* → `source-watch` → *Run now* | OK (otherwise the BE server cannot reach the official sites) |
| 8 | *Notifications*: follow a product, have a change approved | Email arrives (or appears in the API log with `MAIL_TRANSPORT=log`) |
| 9 | Hub: Applications → SDK | **Receiving data**; Analytic shows signed-in users by name |
| 10 | Sentinel → Test repository access | Shows `main` |
| 11 | From a PC outside `ALLOWED_NETWORKS` (if possible) | `403 NETWORK_NOT_ALLOWED` |
| 12 | `sudo docker ps` on both servers | `ecr-api-prod` healthy, `ecr-web-prod` up; the other applications unchanged |

## 11. HTTPS (recommended)

When ECR gets a DNS name (e.g. `ecr.<company domain>`) and a certificate:

1. Put TLS in front of port 3160 — the company's existing reverse proxy or load balancer, forwarding to
   `172.28.80.50:3160` and passing `X-Forwarded-For`/`X-Forwarded-Proto`. If that adds a second proxy hop, set
   `TRUST_PROXY=2`.
2. `backend/.env.prod`: `PUBLIC_BASE_URL=https://<name>`, `COOKIE_SECURE=true`, `MAIL_TRANSPORT=smtp` (required),
   and a ClamAV daemon: `CLAMD_HOST=<host>`, `MALWARE_SCAN_REQUIRED=true` (required, the API refuses to start
   otherwise).
3. Hub registration: redirect URI `https://<name>/api/auth/callback`, launch URL `https://<name>/api/auth/login`,
   SDK allowed origin `https://<name>`.
4. Deploy the backend, then the frontend. Everyone signs in again (the cookie names change to `__Host-`/`__Secure-`).

## 12. Releasing updates and rolling back

Every change goes through staging first, then the same commit is tagged and deployed to production.

1. Deploy to staging and test there ([DEPLOY-STAGING.md](DEPLOY-STAGING.md) §8).
2. Tag the tested commit (on a workstation with push rights):
   ```bash
   git tag -a v1.1.0 <commit> -m "ECR 1.1.0"
   git push origin v1.1.0
   ```
3. Production, **BE server first** (it runs the migrations), then FE:
   ```bash
   cd /opt/export-charges && sudo git fetch --tags && sudo git checkout v1.1.0
   sudo bash backend/deploy/deploy-prod.sh       # BE server
   sudo bash frontend/deploy/deploy-prod.sh      # FE server
   ```
   Only the API is briefly unavailable while its container restarts (a few seconds); deploy outside working hours
   when a release has migrations.

**Rolling back**: `sudo git checkout <previous tag>` and run the same scripts. Migrations only add to the schema, so
older code keeps working on the newer schema; a migration that must really be undone needs a new migration and an RDS
backup taken before the release. To return data to an earlier state, use ECR's own rollback of a data version
(*Change sets*), never SQL.

## 13. Backup and recovery

| What | Where | How |
|---|---|---|
| Database | RDS | Automatic backups and log backup (§3). Restore to a new instance, then point `DB_HOST` at it and redeploy the backend |
| Stored files | NAS `APPs/ECR` | Covered by the NAS's snapshot / Hyper Backup policy — ask IT to include `APPs/ECR` |
| Settings and keys | `backend/.env.prod`, `frontend/.env.prod` | Copies in the password vault; `ECR_ENCRYPTION_KEY` is essential |
| Code | GitHub, release tags | Re-clone and check out the tag (§5) |

The audit log is hash-chained in the database, so restoring the database restores it; files referenced by the database
are found again on the NAS by their keys.

## 14. Running it day to day

- Health: `curl -s http://172.28.80.51:4160/api/ready` (BE), `curl -s http://127.0.0.1:3160/api/health` (FE).
- Logs: `sudo docker logs -f ecr-api-prod` (BE), `sudo docker logs -f ecr-web-prod` (FE); kept by Docker, 5 × 20 MB.
- *Jobs* page (Super Admin): publish-due, email outbox, exports, data checks, source watch — failures alert Super
  Admins.
- *Audit log* and the DWS Hub Analytic/Sentinel views for usage and errors.
- Monthly: the new Kepmendag CPO reference price; weekly: the KMK rate — through change sets.
- Containers restart by themselves after a crash or a server reboot (`restart: unless-stopped`); the NAS mount comes
  back from `/etc/fstab` before Docker starts them (`_netdev`).

## 15. Troubleshooting

Everything in [DEPLOY-STAGING.md](DEPLOY-STAGING.md) §9 applies, with `ecr-api-prod` / `ecr-web-prod`,
`backend/.env.prod` and 172.28.80.51 in place of the staging names. Production adds:

| Symptom | Cause / fix |
|---|---|
| `Missing backend/.env.prod` | Copy `backend/.env.prod.example` to `backend/.env.prod` (§7). |
| `STORAGE_DEPLOYMENT=dev in backend/.env.prod, but prod uses prod` | Set `STORAGE_DEPLOYMENT=prod` in `backend/.env.prod`. |
| `… is NAS folder //172.30.1.94/APPs/…, not APPs/ECR` | `STORAGE_HOST_PROJECT_DIR` points at another folder (another application's, staging's, or the whole share): use `/mnt/synology/ECR` (§6). |
| `/mnt/synology/ECR is not on the Synology share (file system: ext4)` | The NAS folder is not mounted: `sudo mount /mnt/synology/ECR`, then `findmnt /mnt/synology/ECR` (§6). |
| API log: `Cannot write in the storage folder …` after a reboot | Same cause: the mount did not come back; the immutable mount point (§6 step 3) stopped ECR from writing to the local disk. Mount it and restart: `sudo docker restart ecr-api-prod`. |
| `The code in /opt/export-charges has local changes` | Someone edited files on the server. `sudo git status`, then `sudo git checkout -- <file>` (or move the change to GitHub) and deploy again. |
| `Cannot reach the API at http://172.28.80.51:4160` | Backend not deployed yet, or 172.28.80.50 → 172.28.80.51:4160 is blocked. |
| `ETIMEDOUT` in the migration log | 172.28.80.51 is not on the production RDS whitelist. |
| API log: `MAIL_TRANSPORT must be smtp when COOKIE_SECURE=true` / `CLAMD_HOST is required` | HTTPS settings without SMTP or ClamAV (§11). |
| Emails never arrive | `sudo docker logs ecr-api-prod | grep -i smtp`; check the relay allows 172.28.80.51 and the sender address. |
| Sign-in ends on *DWS Hub is unavailable* | The BE server cannot reach the issuer address; set `HUB_DISCOVERY_URL` (§4). |

Logs: `sudo docker logs -f ecr-api-prod` (BE), `sudo docker logs -f ecr-web-prod` (FE).
