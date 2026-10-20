# 0015: Rerunnable writes retry an unknown outcome instead of dropping it

Status: Accepted. Date: 2026-10-20.

## Context

An idempotency claim whose handler answered 5xx, threw, or died past its
lease is recorded as indeterminate, and every retry with that key got
`idempotency_outcome_unknown`. Clients drop that reason
([0007](0007-stable-error-codes-drive-replay.md)). So one transient failure,
such as a column room briefly unavailable, permanently dropped a queued
command the client had correctly retried. A production browser had
recorded 9 replay batches that included such drops.

Refusing to re-run protects writes that are not safe to repeat (account
import clones columns). Most queued commands are safe: lifecycle commands
are journaled workflows that the reconciler already re-runs from the same
inputs ([0008](0008-named-workflows-for-multi-store-writes.md)), and reorder
and hide-shared write absolute values.

## Decision

`withIdempotentWrite` takes `rerunnable`. For a rerunnable write, the
coordinator gives an indeterminate claim, or a pending one past its lease,
to the next request with the same key and fingerprint, under a new owner
token. A live pending claim is never taken over. A stale owner that
finishes later is rejected by its old token. Every queued account command
in `src/server/routes/account-commands.ts` is rerunnable; account import is
not.

## Consequences

- A new idempotent route must decide whether its handler is safe to repeat.
- A re-run whose first attempt did take effect can answer differently (a
  second restore finds nothing in the trash and drops as `not_found`). The
  state is still right, and the client resyncs from the server.
- A request that is slow rather than dead, past the 2-minute lease, can
  overlap its re-run. That overlap is the same as the reconciler running
  next to a request.
