# Data-loss remediation

Owner: Codex. Started 2026-09-30. Implementation and production rollout completed 2026-10-01.
Scope: the seven findings from the production risk review, including the
conditional Yjs corruption path. Existing passkey work in this checkout is
preserved. Production was deployed through a verified frozen release; remote recovery was
rehearsed only in isolated staging.

The original risk was material: reproducible queue overwrites and destructive
restore/purge behavior could lose real edits or documents. The review began with code and local tests; the rollout also inventoried live
production and verified all existing account/document state before and after
deployment. The fixes reduce these specific risks. Historical losses cannot be
established or recovered from snapshots taken only during this rollout.

| ID | Issue | Local status | Implementation and evidence |
| --- | --- | --- | --- |
| DL-01 | Stale tabs overwrite metadata/Yjs queues and their crash journals | Fixed | IndexedDB transaction patches merge individual deliveries; localStorage journals use delivery keys; acknowledgment tombstones prevent stale resurrection. `test/multi-tab-persistence.test.ts` exercises independent metadata/Yjs clients and stale ACKs. `e2e/storage-recovery.spec.ts` verifies both offline tabs close and the reopened editor contains both edits. Replayed updates are echoed to the new submitting tab before ACK. |
| DL-02 | Backup restore leaves trash; purge deletes active documents | Fixed | Restore clears stale trash; purge checks authoritative owner membership and a DO lifecycle timestamp; import activates the room transactionally. Rejected stale purges repair the registry. `test/data-loss-recovery.test.ts` covers restored content past expiry, interrupted restores, lifecycle changes and backup failure before purge; existing lifecycle/outage regressions pass. |
| DL-03 | Latest backup ignores pagination | Fixed | Listing and column/account restore share a helper that follows every R2 page and sorts newest first. Regressions cover 101 objects and a truncated page smaller than the requested limit. Account snapshot lookup also follows all pages. |
| DL-04 | Backups disabled, capped without rotation, omit trash/orphans/account/auth state | Fixed | Automatic backups enabled in configuration; saved cursor rotates the column cap. Inventory includes active, trash and registered orphan columns. Private account snapshots include authoritative metadata and D1 user/passkey/provider credentials. Final purge requires an independent column copy. Recovery validates the entire inventory before mutation and restores missing account/document/passkey state. Rotation and lost-record recovery regressions pass; README documents status checks, recovery drills, secrets, coverage and retention responsibilities. |
| DL-05 | Read-only mode allows scheduled destructive work | Fixed | Read-only mode freezes all cron work. Destructive admin restores require the write freeze; manual backups remain available. A regression invokes the scheduler with otherwise unusable bindings and automatic backups enabled, proving no maintenance starts. |
| DL-06 | Storage errors accept edits with no durable copy | Fixed | Metadata acceptance awaits commit; journal/IndexedDB failures propagate. Unsaved Yjs/guest edits remain available for recovery, and editor input pauses with download/retry controls. Failed IDB patches retry, including reopening an unavailable database. Tests cover quota, failed transactions, reopening and a browser recovery download followed by saving/reload. |
| DL-07 | Failed Yjs decoding continues and compacts away source data | Fixed | Corrupt snapshot/update decoding blocks unsafe reads, writes, sockets and compaction. Internal raw export preserves original bytes; admin pre-restore copies save them independently before verified import. Raw copies count as failed usable backups. Both corruption-source regressions verify preservation and recovery. |

## Final validation

`pnpm verify` passed on 2026-10-01:

- Verification configuration, browser/server boundaries and sensitive URL checks.
- React hook lint; application and test TypeScript checks.
- 33 unit/Worker test files, 278 tests, including staging control boundaries and credential write freezes.
- E2E build; 27 Chromium browser tests, including passkey authentication.
- `git diff --check` passed.

The build retains its existing large-client-chunk warning. No vendored XState
files were edited. The change includes the existing passkey implementation and its production rollout.
The reviewed application is deployed to isolated staging and production.

## Staging validation

The persistent [staging environment](https://staging.todo.tamesystems.org) has
separate KV, D1, R2, Durable Object namespaces, analytics, signing secrets and
passkey RP/origin. A production-mode remote drill passed account-root and auth
loss recovery, original passkey sign-in, content/order/trash/share/public-link
checks, scheduled backup execution, freeze and thaw. Credential changes are
also frozen during recovery, while sign-in remains available for validation.
See [the runbook](../staging.md) for reproduction and the production release gate.

## Production validation

An explicit remote inventory found four accounts and two active documents.
Production D1 was provisioned, auth migrations applied and existing identities
seeded for restricted legacy enrollment. New accounts require passkeys. The initial rollout kept old credential access until enrollment. The production
owner has since enrolled and that temporary credential path is now removed. Verified enrollment saves a full credential/document backup
before permanently retiring the old credential and invalidating older enrollment
sessions and sockets. Coordinator retirement also survives an older D1 restore.

The deployment used the original production KV, R2 and column DO namespace,
first in read-only mode. Every original account record, metadata record and
normalized Yjs document matched the fresh independent baseline. Full account and
document snapshots were created and the backup pipeline completed with no failed,
raw or invalid copies. All six canonical snapshots were independently copied to
the workstation and verified by checksum and complete account inventory. The
same build was thawed and the original data and legacy session access checked
again. Automatic hourly backups are enabled; a temporary local Codex monitor checked health and independent mirroring every
15 minutes during rollout. That monitor is now paused at the user's request.

Staging separately passed original passkey recovery after account/auth loss,
sharing/order/trash/public checks, actual scheduled-handler execution, legacy
browser enrollment, retired credential/session/socket rejection, and Worker
rollback preserving data written after the older version was created. Production
owners were not enrolled using synthetic credentials, and production data was
not restored over its live originals. See [the runbook](../staging.md) for release
versions, commands, independent storage and recovery boundaries.

## Remaining limits

- Hourly backups can lose edits since the last successful snapshot during a
  catastrophic live-storage loss. Same-account R2 copies alone do not cover
  Cloudflare account loss. Independent copies currently live on this workstation;
  the rollout monitor is paused, so new off-account copies require a manual mirror run.
- Backups and restores span multiple objects and are not atomic. Keep writes
  frozen on restore failure and inspect before retrying. Recovery validates a
  complete inventory before writes. A cap of C for N columns takes `ceil(N/C)`
  successful hourly runs for a full sweep. Production currently has two columns,
  below the cap of 1000. No automatic backup-deletion policy is installed.
- Guest data/checkpoints remain device-local. Browser storage clearing, device
  loss and simultaneous guest editing in multiple tabs still require independent
  exports and care. Downloaded Yjs deltas can need their server base state. Keep a
  failed-storage tab open until saving or export succeeds. ACK markers protect
  sleeping stale tabs and consume storage; quota failures now pause editing.
- Remote drills retain document DOs and reimport their verified backups; total
  document loss/corruption recovery is covered by local Worker tests. These checks
  do not establish a guaranteed production RPO/RTO or eliminate every loss risk.

Inventory correction: the earlier count of 33 came from Wrangler's default local
KV store. Explicit `--remote` inventory confirms four production accounts.

## Migration cleanup

After the production owner enrolled a passkey, the temporary Account-ID migration
code was removed. Authentication is passkey-only, and production release checks
now compare fresh private admin snapshots, preserving account roots, document
state and credentials. Applied database history is retained. A surviving old
socket attachment fails closed. Stored records and backups are not deleted.

Cleanup validation: 32 unit/Worker files (276 tests), all 27 Chromium tests,
TypeScript, hook lint, sensitive-URL/boundary checks and build checks passed.
