# Todoflare

A local-first, collaborative rich-text todo app. You can use Todoflare entirely
in one browser or create an account session to sync columns, collaborate, share
read-only public links, and recover deleted data.

## How data works

- **Guest-local mode:** columns are stored in `localStorage`. Hourly rolling
  checkpoints provide local recovery.
- **Account mode:** passkeys authenticate access through an HttpOnly Better Auth
  session cookie. The generated 16-digit Account ID is a public sharing identity;
  it cannot authenticate and is safe to give to collaborators.
  Account snapshots, merged Yjs document caches, queued metadata commands, pending Yjs updates, and sync
  telemetry are persisted in IndexedDB so the app can start and accept edits
  offline.
  Authenticated WebSockets use a per-column, single-use ticket that expires
  after 45 seconds, so neither session cookies nor credentials enter the upgrade URL.
- **Metadata sync:** creates, ordering, sharing, public-link, delete, and restore
  operations use one durable client queue. The Worker applies replayable writes
  idempotently.
- **Collaborative content:** Plate edits are represented by Yjs. A Durable Object
  per column stores the shared document and relays content and presence over
  WebSockets.
- **Server storage:** Cloudflare D1 stores Better Auth users, passkeys, sessions,
  and recovery-code hashes. Cloudflare KV stores domain accounts and indexes, SQLite-backed
  Durable Objects store column state, and R2 stores administrative backups.
  Durable Object metadata is authoritative for column ownership, sharing, and
  public-link identity. Account KV owns account order, hidden columns, and trash;
  shared/public KV keys are repairable discovery projections.
- **Access loss:** when access is revoked, queued metadata and Yjs changes for
  that column are discarded and the local editor detaches.

Sessions renew through API responses, with a periodic check while the app is
visible and another check when it regains focus. If authentication expires,
sync pauses and a reconnect banner offers passkey authentication for the same
account. Cached documents remain editable, and metadata commands and Yjs edits
stay queued across reloads until reconnection. Account IDs in request headers
only bind queued work to the expected cookie identity; they cannot authenticate.

The browser persistence layer is a project-owned IndexedDB-backed `PersistedMap`.
The project does not currently use RxDB or TanStack DB.

## Stack

- **Frontend:** React 19, Tailwind CSS, Plate, Yjs, and dnd-kit
- **Backend:** Hono on Cloudflare Workers
- **Storage:** D1, KV, SQLite-backed Durable Objects, R2, IndexedDB, and localStorage
- **Build:** Vite with `@cloudflare/vite-plugin`
- **Tests:** Vitest in the Workers runtime and Playwright in Chromium

## Development

Install dependencies:

```bash
pnpm install
```

Start the development server:

```bash
pnpm dev
```

The app runs at `http://localhost:5173` with hot module replacement. The
Cloudflare Vite plugin runs Worker APIs, KV, and Durable Objects locally through
`workerd`; local binding state is kept under `.wrangler/state/`.

## Verification

Run the fast gate while developing. It typechecks application and test code,
runs Vitest once, and builds the production bundle:

```bash
pnpm verify:fast
```

Before considering a change complete, run the authoritative full gate. It adds
the Playwright browser suite and performs exactly one E2E-enabled production
build:

```bash
pnpm verify
```

GitHub Actions installs Chromium and runs this same `pnpm verify` command.
Browser tests reset only `.wrangler/e2e-state`; normal development data under
`.wrangler/state` is never touched by verification.

Individual checks are also available as `pnpm typecheck`,
`pnpm typecheck:test`, `pnpm test:run`, `pnpm build`, and `pnpm test:e2e`.
The standalone E2E command performs its own E2E-enabled build.

## Building

Build for production:

```bash
pnpm build:production
```

Output is written to `dist/`:

- `dist/client/` — static HTML, CSS, and JavaScript
- `dist/todoflare_prod/` — Worker code, manifest, and generated Wrangler config

## Preview

Preview the production build locally:

```bash
pnpm preview
```

This serves the built application through the local Workers runtime.

## Staging

The isolated staging environment is available at
[staging.todo.tamesystems.org](https://staging.todo.tamesystems.org). Run
`pnpm deploy:staging` to build and deploy it, and `pnpm test:staging` for the
remote passkey and account recovery drill. See [the staging runbook](docs/staging.md)
for resource isolation, write freeze/thaw commands and the verified production rollout.

## Deployment

Production at [todo.tamesystems.org](https://todo.tamesystems.org) uses its own
auth database and signing/admin secrets. Auth migrations are already applied.
Apply any new migrations before deploying code that depends on them:

```bash
pnpm auth:migrate:remote
```

For local development, run `pnpm auth:migrate:local` after creating or resetting
local D1 state. Do not recreate the existing production database or rotate its
signing secret just to deploy.

Production builds select the production bindings and disable E2E auth controls.
The deployment guard checks resources and artifact hashes. A writable deployment
requires a fresh verified checkpoint for the exact frozen build; `pnpm deploy`
refuses to open writes without it. Follow [the release procedure](docs/staging.md#release-procedure)
for a fresh admin snapshot, frozen verification and guarded thaw. The custom domain is `todo.tamesystems.org`; preview and
`workers.dev` URLs are disabled.

## Project Structure

```
├── .github/workflows/  # Authoritative CI verification
├── docs/               # Engineering reports and increment definitions
├── e2e/                # Playwright user journeys and helpers
├── index.html           # SPA entry point
├── wrangler.jsonc       # Cloudflare Worker configuration
├── vite.config.ts       # Vite and local Workers configuration
├── src/
│   ├── client.tsx       # React and public-route entry point
│   ├── index.tsx        # Hono Worker entry point
│   ├── contexts/        # React sync orchestration and projections
│   ├── durable-objects/ # ColumnRoomSql collaboration runtime
│   ├── lib/             # Browser-safe protocols, queues, and local persistence
│   └── server/          # Persistence contracts and named server workflows
├── test/                # Workers-runtime and unit tests
└── dist/                # Generated build output
```

## Recovery Runbook

The app supports emergency read-only mode and admin backup/restore endpoints.
Local-only users also keep hourly rolling checkpoints in browser storage
(`todoflare-backup-YYYYMMDDHH`) with automatic compaction.

Authenticated users can self-serve export/import from the account menu
(`Export Data` and `Import Data`).

### 1) Enable read-only mode (freeze writes)

Build with `pnpm build:production`, then run
`node scripts/deploy-production.mjs --freeze`. Verify data and backups before
reopening writes with the same guarded build.

Use a full deployment rather than a gradual rollout. Wait for the deployment to
finish before starting a backup or in-place restore. The deployment closes
authenticated realtime sessions, and both the Worker and ColumnRoom reject new
private WebSocket tickets, upgrades, and sync submissions while the flag is set.
Public read-only WebSockets remain available.

`GET /api/clock` returns `readOnlyMode` with `Cache-Control: no-store` so you can
verify the version serving that request. Treat this as a local smoke check, not
as proof that an incomplete deployment has reached every location.

### 2) Configure backup auth secret

Set an admin token as a Worker secret:

```bash
wrangler secret put BACKUP_ADMIN_TOKEN
```

The Worker uses the `BACKUPS` R2 binding from `wrangler.jsonc`.

### 2.5) Enable automatic scheduled backups

Set these Worker vars and deploy:

- `AUTO_BACKUP_ENABLED=true`
- `BACKUP_MAX_COLUMNS=1000` (or lower for conservative runs)

Cron is configured in `wrangler.jsonc` as hourly (`0 * * * *`).

### 3) Create and list snapshots

```bash
BACKUP_API_ORIGIN="https://todo.tamesystems.org" \
BACKUP_ADMIN_TOKEN="<token>" \
pnpm backup:create -- <columnId>

BACKUP_API_ORIGIN="https://todo.tamesystems.org" \
BACKUP_ADMIN_TOKEN="<token>" \
pnpm backup:list -- <columnId>
```

### 4) Restore a snapshot

Restore latest snapshot for a column:

```bash
BACKUP_API_ORIGIN="https://todo.tamesystems.org" \
BACKUP_ADMIN_TOKEN="<token>" \
pnpm backup:restore -- <columnId>
```

By default this performs a safe `clone` restore (creates a new column).

Restore a specific snapshot key:

```bash
BACKUP_API_ORIGIN="https://todo.tamesystems.org" \
BACKUP_ADMIN_TOKEN="<token>" \
pnpm backup:restore -- <columnId> "columns/<columnId>/<timestamp>.json"
```

In-place restore (dangerous, takes a pre-restore snapshot first):

```bash
BACKUP_API_ORIGIN="https://todo.tamesystems.org" \
BACKUP_ADMIN_TOKEN="<token>" \
pnpm backup:restore -- <columnId> in_place
```

Scheduled backup runs log an event named `scheduled_backup_run` with counts.

Restore all owned columns for an account from latest backups:

```bash
BACKUP_API_ORIGIN="https://todo.tamesystems.org" \
BACKUP_ADMIN_TOKEN="<token>" \
pnpm backup:restore-account -- <accountId>
```

Automatic backups are enabled in the checked-in configuration. Each hourly run
copies account order, hidden columns, sharing, trash, and D1 users, passkeys and
provider credentials to private R2 objects under `accounts/`. Column selection
includes active, trashed and registered orphan columns and rotates across the
configured cap. For N columns and a cap of C, a successful sweep needs
`ceil(N/C)` hourly runs. Backups are separate snapshots across objects, not an
atomic database checkpoint. An account snapshot can reference a column that has
not been copied yet; recovery refuses incomplete inventories before writing.

Read-only mode also freezes cron work, including automatic backups, so scheduled
snapshots cannot race a recovery. Manual backup endpoints remain available.

Before a planned migration, freeze writes and take a complete account copy:
`node scripts/backup-admin.mjs create-account <accountId>`. Check
`node scripts/backup-admin.mjs status` after deployment and after each expected
cron run. Treat a missing/stale `lastRun`, `failed > 0`, `invalidAccounts > 0`, or
`rawCopies > 0` as an operational failure. The temporary Codex rollout monitor is paused. Automatic off-account mirroring
and chat alerts are no longer running; hourly Cloudflare backups continue. Run `node scripts/backup-health.mjs production` and
`node scripts/mirror-backups.mjs production` manually when needed.
A raw copy preserves forensic bytes but does not establish a usable backup.

Account restore accepts an optional `accounts/<id>/<timestamp>-<uuid>.json` key
and recovers account records and credentials even if their originals are gone.
It uses the latest validated column copies and restores the saved trash state.
In-place column and account restore require a completed read-only deployment.
Pre-restore copies live under `pre-restore/` and do not become the latest recovery
snapshot. Cross-object restoration is retryable, not atomic: keep writes frozen
if it fails and inspect the failure before retrying. Legacy account recovery
without an account snapshot still needs the original account record.

For a recovery drill, use an isolated Worker with the same migrations and a
private copy of the backup bucket. Remove that test account's coordinator/KV
records, D1 user and column state; restore; verify order, content, sharing, trash,
and passkey authentication from a browser; then lift the freeze. The automated
regressions cover missing account/column/passkey recovery, but production
credentials need this operational drill. Save the D1 schema/migrations,
Worker bindings and secrets (including `BETTER_AUTH_SECRET`) independently;
sessions and one-time challenges are deliberately not restored.

Independent verified snapshots are retained under
`/Users/lukasmurdock/Documents/Todoflare Recovery/production`; the dated release
folder also preserves original exports, configuration, secrets and source.
Hourly snapshots can lose changes since the last successful copy if live storage
is catastrophically lost. Keep the workstation copies protected and preserve a
second location if workstation loss must also be covered.

R2 backups contain private content and credential material. Restrict bucket and
admin-token access and maintain an independent off-account copy. No retention
rule is installed by this change: do not add an R2 lifecycle deletion rule until
you have chosen a recovery window and verified that complete inventories survive
it. Cloudflare account loss also removes backups in that account.

If browser persistence fails, editing pauses and offers a recovery download and
retry. Keep the tab open until one succeeds. The recovery JSON preserves pending
commands/Yjs updates and guest content; pending Yjs updates may need their server
base state for manual recovery. Guest checkpoints remain on the same device and
are lost when browser storage is cleared; export guest data independently.
