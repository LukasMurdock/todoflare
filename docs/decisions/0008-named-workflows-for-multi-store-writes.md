# 0008: Multi-store writes live in named, journaled workflows

Status: Accepted. Sources: [history/PLAN.md](../history/PLAN.md),
[history/velocity-01.md](../history/velocity-01.md), [history/data-loss-remediation.md](../history/data-loss-remediation.md).

## Context

Delete, restore, share, revoke, public links, purge and backup restore each
write to a DO and several KV records with no cross-store transaction. Inline
handlers made partial failures hard to reason about and to test.

## Decision

Each such operation is a named module in `src/server/workflows/` that owns
its write order. Route handlers validate once and delegate. Writes are
ordered so that a retry can always finish the job (projections are removed
before the fields that locate them; a commit record is written last), and a
lifecycle journal entry lets the hourly `reconcileColumnLifecycle` finish
work a crash interrupted.

## Consequences

- Every declared write boundary gets a failure-injection test (throw after
  the write, retry, assert convergence).
- Purge double-checks with the DO, which refuses if the column was restored
  or reimported since.
- Column create is still inline in `src/server/routes/account-commands.ts`.
