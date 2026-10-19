# 0014: XState for convergence and connection lifecycles

Status: Accepted. Date: 2026-07-20. Sources: [history/xstate.md](../history/xstate.md),
[history/xstate-2.md](../history/xstate-2.md), [agent-patterns/xstate.md](../../agent-patterns/xstate.md).

## Context

Hydration, replay, reconnects, authentication expiry and access loss raced
each other inside one large provider: going online started hydration and
replay with unspecified order, and socket reference counts could leak.

## Decision

- One account-convergence actor runs an ordered pipeline: local → hydrate →
  replay → reconcile → confirm (`src/lib/sync/account-convergence-machine.ts`).
- One actor per column owns its connection lifecycle; leases from
  `subscribeToColumn` replace reference counts
  (`src/lib/sync/column-session-manager.ts`).
- Durable bytes stay outside machine context, in the outboxes.
- Use XState only where states, cancellation or retries are real; keep simple
  UI state in React.

## Consequences

- `repos/xstate/` vendors the matching source as read-only reference, and
  its version must move together with the installed packages.
