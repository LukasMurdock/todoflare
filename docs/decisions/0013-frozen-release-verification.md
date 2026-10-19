# 0013: Production writes reopen only after verifying the frozen build

Status: Accepted. Date: 2026-10-01. Sources: [staging.md](../staging.md#release-procedure),
[history/data-loss-remediation.md](../history/data-loss-remediation.md).

## Context

A bad release can corrupt or lose real documents, and code rollback does not
roll back data. Tests run against local state, not production's.

## Decision

Every production release deploys the new build in read-only mode first, then
verifies it against fresh, checksummed snapshots taken just before: accounts,
credentials, sharing, trash and normalized Yjs state must be unchanged, and a
backup run must succeed with full coverage. Only then may the same build,
byte for byte, be deployed writable, within an hour. `deploy-production.mjs`
refuses otherwise. Read-only mode also freezes cron, so nothing scheduled
races a release or recovery.

## Consequences

- Each release freezes writes for a minute or two.
- Never build between verification and thaw.
- Because versions reach the edge gradually, the verifier waits for five
  consecutive `/api/clock` responses in the expected mode.
