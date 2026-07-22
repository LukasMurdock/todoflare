# XState application patterns

This file records the XState conventions for TodoFlare. It complements the
vendored source under `repos/xstate/`; it is not a replacement for that source.

## Adoption boundary

- Use XState for behavior with meaningful states, events, transitions,
  cancellation, concurrency, retries, or actor lifecycles.
- Keep simple, local UI values in React state when an explicit state model would
  not make the behavior clearer.
- Do not migrate existing state to XState incidentally. Give each new machine a
  named behavioral responsibility.

## Machine organization

- Define reusable machine logic outside React components.
- Prefer `setup({ ... }).createMachine({ ... })` so actors, actions, guards, and
  delays have explicit names and inferred types.
- Model mutually exclusive situations as states rather than collections of
  booleans.
- Name events for domain occurrences or user intent, and use typed event payloads.
- Keep context limited to data; represent behavior and lifecycle in states and
  transitions.
- Use `assign(...)` for context updates. Keep guards and assignment functions
  deterministic.
- Model asynchronous work as actors and handle success, failure, and cancellation
  explicitly rather than starting promises from actions.

## React integration

- Import React bindings from `@xstate/react` and machine APIs from `xstate`.
- Use `useMachine` when a component owns an actor's lifetime.
- Use `useActorRef` plus `useSelector` when render subscriptions should be narrow
  or an actor reference needs to be shared.
- Select the smallest value a component needs; avoid subscribing a large subtree
  to complete snapshots without a reason.
- Pass actor references across boundaries instead of exposing machine internals.

## Testing

- Test machine transitions, emitted effects, and actor outcomes independently of
  React where possible.
- Add component tests for rendering and user interaction at the React boundary.
- Cover invalid events, failure states, cancellation, and re-entry when they are
  part of the modeled behavior.
- Prefer observable behavior over assertions against private implementation
  details.

## Column collaboration

- Use `ColumnSessionManager` from
  `src/lib/sync/column-session-manager.ts` as the application entry point for
  authenticated column collaboration.
- Acquire transport activity with `subscribeToColumn(columnId)` and use its
  returned idempotent closure for cleanup. Do not add separate connect and
  disconnect calls or numeric reference counts.
- Keep WebSocket lifecycle behavior in `column-session-machine.ts` and
  `column-socket-actor.ts`. Keep durable outbound Yjs bytes exclusively in
  `yjs-update-outbox.ts`.
- Treat the Durable Object sync acknowledgement as the delivery boundary for
  persisted Yjs updates. A successful browser `WebSocket.send()` must not remove
  sync entries from the outbox; awareness frames remain explicitly best-effort.
- Add lifecycle invariants to `test/column-session-machine.test.ts` when changing
  connection, retry, replay, lease, or terminal behavior.

## Account convergence

- `account-convergence-machine.ts` is the lifecycle owner for authentication,
  cached hydration, server hydration, durable command replay, reconciliation,
  retry scheduling, network pause/resume, and logout cancellation.
- The visible account must be derived with `applyPendingCommands(serverBase,
  durableQueue)`. A server response replaces the confirmed base, never the
  optimistic projection directly.
- Persist account commands before sending `COMMAND_PERSISTED`. Account command
  effects return in `ReplayReport` and are applied only by the active account
  actor.
- Account replay is scoped by the immutable command `entityId`, accepts an
  `AbortSignal`, and is independent of realtime WebSocket policy.
- Keep hydration and replay retry schedules in distinct named states. Hydration
  backoff must never read a mutation queue deadline, and rate-limited responses
  must preserve the server-provided retry delay.
- Handle network events at the machine boundary so every lifecycle state records
  connectivity changes. States that invoke online work may add transitions to
  cancel or pause that work, but must not be the only network event handlers.
- Treat account API projections as an authoritative runtime-validated boundary.
  Retained sharing and public-link metadata belongs only to local snapshots.
- Persisting a command is its acceptance boundary. Waiting for convergence must
  be bounded; a settlement timeout must not turn an already-durable command into
  a reported write failure.
- Command settlement is keyed by the persisted `queueId`. A lifecycle-wide
  stable state is not proof that a particular command was acknowledged. Return
  `acknowledged`, `queued`, `terminal`, `signed_out`, or `timed_out` explicitly.
- Observe each `ReplayReport` once at the actor adapter boundary for telemetry
  and notifications. Do not attach report-wide side effects to every command
  submitter waiting on the same replay cycle.
- Add transition and projection invariants to
  `test/account-convergence-machine.test.ts` and
  `test/account-projection.test.ts` when changing this lifecycle.

## Reference routes

- Core behavior and idioms: `repos/xstate/packages/core/test/`
- Actor implementations: `repos/xstate/packages/core/src/actors/`
- React hook behavior: `repos/xstate/packages/xstate-react/test/`
- React hook implementation: `repos/xstate/packages/xstate-react/src/`
- Broader examples: `repos/xstate/examples/` (verify versions before adapting)

Update this file when the application establishes a more specific convention in
an approved machine. Application precedent takes priority over generic examples.
