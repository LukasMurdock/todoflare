# Operations

How Todoflare behaves in production and how to release, freeze, back up and
restore it. The step-by-step release gate and its history are in
[staging.md](staging.md).

## Environments

| | Production | Staging |
| --- | --- | --- |
| URL | https://todo.tamesystems.org | https://staging.todo.tamesystems.org |
| Worker | `todoflare-prod` (`src/index.tsx`) | `todoflare-staging` (`src/staging.ts`: production plus recovery controls) |
| Data | Own D1, KV, R2 and Durable Objects | Fully separate copies |
| Writable deploy | Only after frozen verification | Any time |

Preview and `workers.dev` URLs are disabled. Worker logs and traces are off,
and a check keeps them off, because URLs and payloads could carry private
data. Secrets (`BETTER_AUTH_SECRET`, `BACKUP_ADMIN_TOKEN`) are Worker secrets,
not in `wrangler.jsonc`. Do not recreate the production database or rotate
`BETTER_AUTH_SECRET` to deploy. Set `CLOUDFLARE_ACCOUNT_ID` if your Cloudflare
login can see more than one account.

## Releasing

Every production release is a frozen release
([0013](decisions/0013-frozen-release-verification.md)). The full procedure,
with the staging steps before it, is [staging.md](staging.md#release-procedure).
In short:

```bash
pnpm verify
pnpm build:production
node scripts/deploy-production.mjs --check     # bindings, domain, auth mode, artifact hashes
node scripts/production-preflight.mjs          # fresh checksummed snapshots of all accounts and documents
node scripts/deploy-production.mjs --freeze    # deploy this build read-only
node scripts/verify-production-release.mjs     # compare against snapshots; writes the release checkpoint
node scripts/mirror-backups.mjs production     # independent local copies
node scripts/deploy-production.mjs             # same build, writable; refuses without a fresh checkpoint
node scripts/verify-production-release.mjs --live
node scripts/backup-health.mjs production
```

If verification fails, stay frozen and investigate. Never build between
verification and thaw. Code rollback does not roll back data.

D1 migrations are applied before the code that depends on them:
`pnpm auth:migrate:remote` (production) or `pnpm auth:migrate:staging`.
Production is migrated through `0004_oauth.sql`.

## Read-only mode

`READ_ONLY_MODE=true` freezes writes. Deploy it with
`node scripts/deploy-production.mjs --freeze` after `pnpm build:production`.

| Blocked | Still works |
| --- | --- |
| Every write route (503 `read_only_mode`, `Retry-After: 60`) | All reads |
| WebSocket tickets and private upgrades; open writable sockets close (1013) | Public read-only links |
| Sign-up, passkey changes, recovery codes | Passkey sign-in and sign-out |
| Agent writes, new agent connections and grants, OAuth approval | Agent reads; disconnecting agents and removing grants |
| All cron work: cleanup, reconcile, automatic backups, purge | Manual admin backups |

In-place column restore and account restore *require* read-only mode.
Use a full deployment, not a gradual one, and wait for it to finish before a
backup or restore. `GET /api/clock` reports `readOnlyMode` and `build`, but a
single response only proves the version that served it; the release scripts
wait for five consecutive matching responses.

## Backups

Hourly cron (`0 * * * *`) with `AUTO_BACKUP_ENABLED=true` and
`BACKUP_MAX_COLUMNS` (1000) writes to the private R2 bucket:

- `columns/<id>/<timestamp>.json`: metadata and full Yjs state, checksummed.
  Inventory covers active, trashed and registered orphan columns, rotating
  through the cap (a full sweep of N columns takes `ceil(N/cap)` runs).
- `accounts/<id>/<timestamp>-<uuid>.json`: order, hidden, sharing and trash
  records plus D1 user, passkey and provider rows.
- `raw-columns/…`: bytes of a column whose Yjs state is corrupt. Forensic
  only; counts as a failed backup.
- `pre-restore/…`: copies taken before any in-place restore. Never chosen as
  "latest".

**Not backed up:** sessions and challenges, agent connections, grants and
OAuth state (reconnect agents after a restore), the agent change log and Yjs
update log (only merged state), idempotency and rate-limit state, browser
storage, and secrets. Backups are separate objects, not an atomic checkpoint,
and can lose up to an hour of edits. Same-account R2 copies do not survive
loss of the Cloudflare account.

Check health after every deploy and expected cron run:

```bash
node scripts/backup-health.mjs production    # fails on stale lastRun, failed, rawCopies or invalidAccounts > 0
node scripts/backup-admin.mjs status
node scripts/mirror-backups.mjs production   # verified copies under ~/Documents/Todoflare Recovery/production
```

Mirroring is manual; there is no automatic off-account copy or alerting.
Independent verified copies are kept in
`/Users/lukasmurdock/Documents/Todoflare Recovery/`; protect that machine's
copies and keep a second location if workstation loss must be covered. No R2
lifecycle rule deletes backups; do not add one without choosing a recovery
window and verifying complete inventories survive it.

Before a planned migration, freeze writes and take a complete account copy:
`node scripts/backup-admin.mjs create-account <accountId>`.

## Restoring

All commands take `BACKUP_API_ORIGIN` and `BACKUP_ADMIN_TOKEN` from the
environment:

```bash
pnpm backup:list -- <columnId>
pnpm backup:create -- <columnId>
pnpm backup:restore -- <columnId>                          # latest, as a new private column (clone)
pnpm backup:restore -- <columnId> "columns/<columnId>/<timestamp>.json"
pnpm backup:restore -- <columnId> in_place                 # overwrite; requires read-only mode
pnpm backup:restore-account -- <accountId>                 # whole account; requires read-only mode
```

- **Clone** (default) makes a new private column: no collaborators, no public
  link.
- **In place** takes a pre-restore copy first, then imports and reconciles
  order, trash, sharing and the public ID.
- **Account restore** validates every column backup in the inventory before
  writing anything, then restores columns, credentials (deleting sessions)
  and account records. It is retryable, not atomic: if it fails, keep writes
  frozen, inspect, and retry. Without an account snapshot it can only restore
  columns for an account record that still exists.

Rehearse on staging, never on production: `pnpm test:staging` freezes
staging, deletes a test account, restores it, signs in with its passkey and
compares everything ([staging.md](staging.md#remote-recovery-drill)).

## Self-serve export and import

Signed-in users can export and import from the account menu. Export
(`GET /api/account/export`) contains every owned column's metadata and Yjs
state and fails rather than produce a partial file. Import clones each column
into a new private column owned by the current account; it never overwrites.

## Browser-side recovery

If browser storage fails, editing pauses and the banner offers a recovery
download and retry. Keep the tab open until one succeeds. The recovery JSON
holds pending commands, pending Yjs updates, cached documents and guest
columns; Yjs deltas may need their server base state to apply by hand.

Guests keep hourly rolling checkpoints (`todoflare-backup-YYYYMMDDHH`, 30
days) in the same browser. They are lost if site data is cleared; guests
should export independently.
