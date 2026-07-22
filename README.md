# Todoflare

A local-first, collaborative rich-text todo app. You can use Todoflare entirely
in one browser or create an account session to sync columns, collaborate, share
read-only public links, and recover deleted data.

## How data works

- **Guest-local mode:** columns are stored in `localStorage`. Hourly rolling
  checkpoints provide local recovery.
- **Account mode:** the generated 16-digit account number is a bearer credential:
  it is both the account identifier and the secret that authenticates access.
  Anyone who has it can access the account, so store it as carefully as a
  password. This model is inspired by
  [Mullvad's account numbers](https://mullvad.net/en/blog/mullvads-account-numbers-get-longer-and-safer).
  Account snapshots, queued metadata commands, pending Yjs updates, and sync
  telemetry are persisted in IndexedDB so the app can start and accept edits
  offline.
  Private HTTP requests carry this credential only in the `Authorization`
  header; account credentials are never placed in paths or query strings.
  Authenticated WebSockets use a per-column, single-use ticket that expires
  after 45 seconds, so the account credential never enters the upgrade URL.
- **Metadata sync:** creates, ordering, sharing, public-link, delete, and restore
  operations use one durable client queue. The Worker applies replayable writes
  idempotently.
- **Collaborative content:** Plate edits are represented by Yjs. A Durable Object
  per column stores the shared document and relays content and presence over
  WebSockets.
- **Server storage:** Cloudflare KV stores accounts and indexes, SQLite-backed
  Durable Objects store column state, and R2 stores administrative backups.
  Durable Object metadata is authoritative for column ownership, sharing, and
  public-link identity. Account KV owns account order, hidden columns, and trash;
  shared/public KV keys are repairable discovery projections.
- **Access loss:** when access is revoked, queued metadata and Yjs changes for
  that column are discarded and the local editor detaches.

The browser persistence layer is a project-owned IndexedDB-backed `PersistedMap`.
The project does not currently use RxDB or TanStack DB.

> **Authentication direction:** We are exploring passkeys as a future
> phishing-resistant authentication and recovery option because
> [we don't want your password](https://tailscale.com/blog/passkeys). The current
> 16-digit account number remains Todoflare's authentication credential; passkeys
> are exploratory, not an implemented login method or committed migration.

## Stack

- **Frontend:** React 19, Tailwind CSS, Plate, Yjs, and dnd-kit
- **Backend:** Hono on Cloudflare Workers
- **Storage:** KV, SQLite-backed Durable Objects, R2, IndexedDB, and localStorage
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
pnpm build
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

## Deployment

Deploy to Cloudflare Workers:

```bash
pnpm deploy
```

This builds and deploys the Worker to the routes configured in `wrangler.jsonc`.
The current production custom domain is `https://todo.tamesystems.org`;
`workers.dev` and preview URLs are disabled. Wrangler prompts for Cloudflare
credentials when needed.

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

Set `READ_ONLY_MODE=true` in your deployed Worker vars, then redeploy.

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
