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
pnpm test:staging:auth
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

Staging keeps production rate limits (for example, five new accounts per IP
per hour). Because every drill creates fresh accounts, it first calls the
staging-only `reset-rate-limits` control, which clears the IP-keyed windows for
the caller's IP only.

Each drill then calls the staging-only `reset-data` control until it reports
`done`. It deletes every column, account, KV record, backup object and auth row
on staging in bounded batches (`src/staging-reset.ts`), so a run never depends
on data left by earlier runs, including aborted ones. It refuses while staging
is frozen. Staging therefore holds only the most recent drill's synthetic data.

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

`pnpm test:staging:auth` independently queues document edits and a new column
offline, removes the browser session cookie, and verifies the reconnect banner.
It reloads, tests a failed reconnect, and reconnects with the original passkey.
It checks that cached content survives and both document edits and queued metadata
reach a separate browser session after reconnecting.

Version changes propagate gradually, so after every deploy or rollback the
drill waits for five consecutive `/api/clock` responses in the requested write
mode. Before the rollback rehearsal it parks both browsers on `about:blank`, so
the app cannot write to the comparison column between snapshots.

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
[data-loss remediation](history/data-loss-remediation.md).

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
pnpm test:staging:auth
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
Like the drill, the verifier waits for five consecutive `/api/clock` responses
in the expected write mode before checking anything; a single response can
come from the new version while the next still reaches the old one. A failed
request names its method, path and status.
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

The temporary local Codex rollout monitor/mirror was paused at the user's request
after the production rollout. Existing independent copies are retained. Hourly
Cloudflare backups continue, while health checks and off-account mirroring are
now manual; no recurring chat alerts are active. Hourly snapshots
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

## Session renewal and reconnect release on 2026-10-15

Application API responses now forward Better Auth's session renewal and expiry
cookies. Visible clients refresh their account periodically and on focus.
Expired authentication pauses metadata and realtime sync without treating a 401
as revoked column access. A passkey reconnect banner retains the cached account,
queued commands, and Yjs edits; reconnecting must use that same account. Requests
also bind queued work to the expected cookie identity so another tab cannot
redirect it to a different account.

Merged Yjs documents are cached in a validated IndexedDB collection. Cached
content and pending updates hydrate the editor before collaboration starts,
including while authentication is expired. Concurrent tabs merge their cached
Yjs snapshots when writing. Storage recovery exports include the document cache.

Validation passed: 289 unit/Worker tests, all 27 browser tests, the real HTTPS
staging passkey reconnect test, and the full staging recovery/rollback drill.
The staging drill's scheduled backup request allows 180 seconds and reports
fetch failures without request headers. Its registration helper reports the
actual HTTP status. A temporary staging-only rate-limit override used for
synthetic fixture setup was removed by the normal freeze/thaw deployments and
its removal was checked against the deployed version bindings.

The verified frozen production version is
`96399a5a-8631-4816-ab2b-7d44b8c67fed`; the writable version is
`3376d22b-7198-47ff-8336-1a5811df3903`. Fresh preflight, frozen verification, and
live verification preserved all four accounts, four documents, and their
credentials. Eight independent backup snapshots verified successfully and backup
health remained current. The production deployment has no authentication or
rate-limit bypass bindings.

## Change-locality release (2026-10-18)

Released commit `93d58637` from `refactor/change-locality` (PR #1): shared route
and account command tables, contract-derived record types, the `index.tsx` split,
and UUID-only column IDs in server stored records. A read-only audit beforehand
found no non-UUID column IDs in production. Validation passed: 326 unit/Worker
tests, all 27 browser tests, the staging passkey test, and the full staging
recovery/rollback drill on the same commit.

The verified frozen production version is
`c053f08d-2623-4c63-b254-f712cec7c249`; the writable version is
`347c72df-4b31-4211-8e11-54940ecc02cb`. Preflight, frozen verification, and live
verification preserved all four accounts, four documents, and their credentials.
Eight independent backup snapshots verified and backup health is current.

## Embeddable board release (2026-10-18)

Released merge commit `47b1faf9` (PR #2): the board as the `@todoflare/board`
package with todoflare as its host, guest columns on Yjs, no placeholder
column while a signed-in account loads, the public page rendered with the
board's snapshot renderer, and a client bundle of 385 KiB gzip (from 422).
Validation: `pnpm verify` (330 unit, 32 e2e, 14 host tests and the boundary,
API and bundle checks), CI, and on staging version
`42b57df3-ab15-4def-8c31-e76a96922655` the passkey test and the full
recovery/rollback drill.

The verified frozen production version is
`12a25b56-1217-4734-bdc3-909afb73bb59`; the writable version is
`fa17ca52-381e-4da6-8817-a39aa3875e95`. Preflight, frozen verification, and live
verification preserved all four accounts, four documents, and their
credentials. Eight independent backup snapshots verified and backup health is
current.

## Dependency update release (2026-10-18)

Released merge commit `32157216` (PR #3): React 19.3, Plate 53.3, yjs, the
Radix packages, hono 4.13, zod 4.6, Vite 8.3, Wrangler 4.151 and the
Cloudflare Vite plugin 1.64, among routine updates. Client JS is 407.4 KiB
gzip (budget 415). Validation: `pnpm verify`, CI, 0-pixel visual baseline,
and on staging version `08731df4-50e9-4ef2-8034-5b5e08f49953` the passkey test
and the full recovery/rollback drill.

The verified frozen production version is
`085cc56e-67dd-4a0e-a693-f5a0d66f5470`; the writable version is
`52209b2a-db33-4cde-9ef9-488198172f8e`. Preflight, frozen verification, and live
verification preserved all four accounts, four documents, and their
credentials. Eight independent backup snapshots verified and backup health is
current.

## better-auth 1.7 and backup scaling release (2026-10-19)

Released merge commit `bdf2c6d5`: better-auth and the passkey plugin 1.7.10
(PR #5; auth schema unchanged, sessions and passkeys from 1.6 verified to keep
working on staging), single-account backups scoped to the column registry and
scheduled backups run concurrently (PR #7), and drills that start from empty
staging data. Validation: `pnpm verify`, CI, and on staging version
`904dde74-edcc-4b77-b686-2cae68590de6` the passkey test and the full
recovery/rollback drill.

The verified frozen production version is
`893bcb93-4db2-4349-86a4-936a94e1cc2e`; the writable version is
`97916249-3211-4241-855b-4a606eb13dd2`. Preflight, frozen verification, and live
verification preserved all four accounts, six documents, and their
credentials. Ten independent backup snapshots verified and backup health is
current.

## xstate 5.33 release (2026-10-19)

Released merge commit `0edd4ea5`: xstate 5.33.3 with the matching vendored
reference (PR #8), plus the tooling updates ESLint 10 (PR #9) and pnpm 12
(PR #10). Validation: `pnpm verify` under pnpm 12, CI, and on staging version
`38d1485d-9aeb-4339-9417-2ad26dedf127` the passkey test and the full
recovery/rollback drill.

The verified frozen production version is
`1634749c-d49d-4f46-91a5-5ef7968bfab5`; the writable version is
`dc997098-d059-4f52-8f82-8e6bd19aed86`. Preflight, frozen verification, and live
verification preserved all four accounts, seven documents, and their
credentials. Eleven independent backup snapshots verified and backup health is
current.
