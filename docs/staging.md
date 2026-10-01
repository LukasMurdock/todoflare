# Staging and production release gate

Staging is a persistent environment at https://staging.todo.tamesystems.org.
It uses the same application and Durable Object classes with a staging-only
recovery control entry point. It is built in production mode: the E2E account
header does not authenticate.

## Isolation

| Resource | Staging | Production |
| --- | --- | --- |
| Worker | `todoflare-staging` | `todoflare-prod` |
| KV | `000084374c0d46949985ce0331cd67bd` | `b2a26a39720746e2b67d8a07ee1a2d68` |
| D1 | `todoflare-auth-staging` (`b978ef4f-261e-45ba-bba0-c008136e51ef`) | `todoflare-auth` (`6314b61f-579a-474b-88dc-df715faff5fc`) |
| R2 | `todoflare-backups-staging` | `todoflare-backups` |
| Durable Objects | Namespaces owned by staging Worker | Namespaces owned by production Worker |
| Analytics | `todoflare_lifecycle_invariants_staging` | `todoflare_lifecycle_invariants` in source configuration |
| Auth origin / passkey RP | `staging.todo.tamesystems.org` | `todo.tamesystems.org` |
| Secrets | Separate generated signing and admin secrets | Separate generated signing and admin secrets |

The Durable Object bindings intentionally omit `script_name`; no staging object
references the production Worker. Staging explicitly supplies every binding and
variable that Wrangler does not inherit. The custom domain overrides the
production route. Staging passkeys and cookies cannot authenticate production.

Cloudflare's Vite plugin selects an environment **at build time**. Do not deploy
an arbitrary `dist/` using `wrangler deploy --env staging`. Our deploy script
checks the flattened build configuration against the staging resource IDs and
checks hashes of the production-mode staging artifacts before deploying.

## Commands

```sh
pnpm auth:migrate:staging
pnpm deploy:staging
pnpm test:staging
```

`deploy:staging` performs a fresh staging build. The manual write freeze and thaw
commands require that build:

```sh
node scripts/deploy-staging.mjs --freeze
node scripts/deploy-staging.mjs
```

The admin and signing secrets are uploaded to the staging Worker. The generated
local copy is `.wrangler/staging-secrets.json`, ignored by Git and mode 0600.
Keep it in a password manager or secret store if needed on another workstation;
do not rotate the signing secret merely to run tests. For a fresh workstation,
obtain the staging admin token and put it in that ignored file. The drill needs
only `BACKUP_ADMIN_TOKEN`; deploying an existing Worker does not upload secrets.

## Remote recovery drill

`test:staging` uses Chromium's virtual WebAuthn authenticator to register actual
passkeys against the HTTPS staging origin. It verifies anonymous access and the
E2E authentication bypass are rejected. It creates only synthetic accounts,
imports a valid Yjs document, shares it with a second account, enables a public
link, trashes another column, and creates a complete account/document backup.

It invokes the **actual scheduled handler**, verifies persisted backup status,
deploys a write freeze, waits for the domain to report the freeze, and verifies
ordinary writes, credential enrollment/deletion/recovery-code rotation and scheduled maintenance are frozen. Passkey sign-in, session creation/counters and sign-out remain available to validate recovery. It then deletes the
marked test account's coordinator/KV roots and D1 user, credentials, and sessions.
It restores through the normal production admin recovery route and signs in
using the original passkey. It compares account order, column metadata, decoded
Yjs content, trash timestamps, collaborator access, and public-link identity,
then thaws writes and verifies a new write succeeds. It also writes after the
frozen Worker version was created, rolls back to that frozen version, and verifies
that the later data survives. Worker rollback must never restore an older data
snapshot merely because the code version changed.

Staging controls require `ENVIRONMENT=staging` and the admin token. Marking also
requires an authenticated account session; loss simulation requires a marked
case, a write freeze, and a verified account credential backup. These controls
are exported only by `src/staging.ts`, never by the production entry point.

The remote drill retains documents and reimports their backups; total document
loss, corrupt stored bytes, paginated recovery inventories, stale purges, and
failed browser storage are covered by local Worker/browser tests. This drill
does not establish production RPO/RTO. The synthetic fixtures remain available
in staging for inspection. A failure during recovery leaves staging frozen;
inspect the failure before retrying or thawing.

The successful report is saved at `.wrangler/staging-drill-report.json`.
The initial remote drill completed successfully on 2026-10-01, including original
passkey sign-in, restored account/document metadata and content, collaborator
access, public identity, trash timestamps, and successful writes after thaw.

The build-time selection and binding isolation follow Cloudflare's
[environment reference](https://developers.cloudflare.com/workers/wrangler/environments/)
and [Vite environment guidance](https://developers.cloudflare.com/workers/vite-plugin/reference/cloudflare-environments/).
Persistent staging was selected for repeatable operational drills; Cloudflare
[previews](https://developers.cloudflare.com/workers/previews/) serve temporary
previews with separate lifecycle rules.

## Production rollout on 2026-10-01

The initial production release was from 2026-05-12, with automatic backups
disabled and no auth database. Explicit remote inventory found four accounts and
two active documents. The initial code review found real data-loss risks; see
[data-loss remediation](data-loss-remediation.md).

## Passkey-only release

The production owner completed enrollment on 2026-10-01. The transitional legacy
endpoint, Account-ID bearer/header authentication, old client request rewriting,
enrollment UI, staging seeding and migration drill are removed. Existing passkey
sessions continue to work. Stored accounts and recovery copies remain available
to private administration; accounts without a passkey cannot authenticate.

Applied D1 migration 0002 remains in history, including its unused session column.
Existing coordinator retirement rows and old ticket tables are not dropped. A
small fail-closed socket check rejects any surviving hibernated legacy attachment;
new sessions never carry that marker. These are storage/security remnants, not an
active migration path.

## Release procedure

```sh
pnpm verify
pnpm deploy:staging
pnpm test:staging
pnpm build:production
node scripts/deploy-production.mjs --check
node scripts/production-preflight.mjs
node scripts/deploy-production.mjs --freeze
node scripts/verify-production-release.mjs
node scripts/mirror-backups.mjs production
node scripts/deploy-production.mjs
node scripts/verify-production-release.mjs --live
node scripts/backup-health.mjs production
```

The preflight discovers production accounts using explicit remote KV inventory
and creates checksummed admin account/document copies, including passkeys and
other provider credentials. Verification compares account roots, sharing/trash,
credential identities, metadata and normalized Yjs state against those fresh
snapshots. Passkey counters may increase during sign-in but cannot regress.
The verifier checks anonymous access fails, retired login is unavailable, staging
controls are absent, writes are frozen, and the backup run completes successfully.
It saves verified snapshots independently under `Todoflare Recovery/releases`.

The build guard checks binding IDs, domain, production auth mode and every build
artifact hash. Writable deployment requires verification of the exact same build
within the previous hour. Keep writes frozen if verification fails. Legitimate
edits made between preflight and freeze can fail comparison; investigate them and
capture a fresh frozen baseline without overwriting the original evidence. Never
build again between verification and thaw.

Initial migration deployment history: frozen version
`acd69ed4-1070-4689-9a04-b165e34671eb`, writable version
`72159442-6ed8-41ef-8c40-de3b61fae70b`. All four accounts and two documents survived
that rollout. The migration drill verified original passkey sign-in and rejected
retired bearer, stale cookie and socket access. Those historical migration versions
include compatibility code; prefer the most recent verified frozen passkey-only
release for recovery. Code rollback does not roll back data. Keep writes frozen
during data restore.

## Backup operations

Hourly backups include account roots, credentials and active/trashed/orphan
columns. `backup-health.mjs` fails if the last completed run is missing, older
than two hours, skipped or incomplete, or contains failed/raw/invalid copies.
`mirror-backups.mjs` follows all pages, copies the latest canonical snapshots and
checks their SHA-256 checksums and complete account/document inventory. It retains
previous independent copies.

Independent snapshots are stored under
`/Users/lukasmurdock/Documents/Todoflare Recovery/production`. The dated release
folder also contains original exports, configuration, secrets and a source archive.
These files contain private data and credentials and have restrictive permissions.
The mirror is outside the Cloudflare account but is still on this workstation;
losing this machine also loses those independent copies. No deletion policy is
installed. Keep complete inventories when choosing retention or moving these
copies to another protected location.

The local backup monitor/mirror runs every 15 minutes and stays quiet while healthy.
It needs the Codex host to be running and awake; hourly Cloudflare backups continue
independently. A missing run or failed mirror needs attention. Hourly snapshots
are not a zero-loss guarantee: catastrophic live-storage loss can lose changes
since the last successful copy. Cross-object recovery is retryable, not atomic.

Inventory correction: the earlier count of 33 came from Wrangler's default local
KV store. Explicit `--remote` inventory confirms four production accounts. Always
specify `--remote` when inventorying live KV or R2 objects.

The passkey-only cleanup froze production at version
`d35d91ed-fbf4-4eba-9502-5b2682231903`. Frozen verification preserved all four
account records, both documents and their credentials, and the independent mirror
verified all six recovery snapshots. Use this frozen version for emergency
recovery instead of the historical migration releases.

The writable passkey-only release is
`de32509c-bb12-4ae6-bf99-61f8f212e546`. Live verification also preserved all
account/document/credential state, rejected old bearer and header transports,
confirmed the legacy login route is absent, and passed backup health checks.
