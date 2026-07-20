# Local-first account mode: current state and decision record

Status: current as of 2026-07-19.

This document records what Todoflare runs today, which parts of the original
local-first proposal were superseded, and which decisions remain open. It is not
a promise that historical proposals are active architecture.

## Current production architecture

Todoflare has five explicit client modes:

- `guest_local`: browser-only columns stored in localStorage.
- `account_offline`: an account session backed by local snapshots and outboxes,
  without usable network or realtime transport.
- `account_syncing`: online account metadata is hydrating or column connections
  are being established.
- `account_realtime`: account metadata and Yjs column connections are active.
- `public_readonly`: a public link loads one read-only Yjs document without the
  authenticated account runtime.

The two state planes are intentionally different:

| Plane | Browser state | Server authority | Conflict/recovery behavior |
| --- | --- | --- | --- |
| Account metadata | IndexedDB account snapshot and mutation outbox | Account/index records in KV plus column metadata in Durable Objects | FIFO commands, idempotency keys, retry/backoff, stable terminal error codes |
| Column content | Yjs document plus IndexedDB Yjs update outbox | SQLite-backed `ColumnRoomSql` Durable Object | Yjs merge, state-vector reconciliation, ordered resend |
| Presence | In-memory connection projection | Durable Object WebSocket room | Ephemeral; never replayed as durable document state |
| Guest columns | localStorage with rolling checkpoints | None | Browser-local only |

The local-first database is a project-owned IndexedDB-backed `PersistedMap` with
four collections: `accountSnapshot`, `mutationOutbox`, `yjsUpdateOutbox`, and
`syncState`. It falls back to memory if IndexedDB cannot be opened.

`SyncProvider` remains the React orchestration root. Command-to-HTTP execution is
owned by `account-command-executor.ts`; queue retry/idempotency behavior is owned
by `mutation-queue-service.ts`; protocol constants and codecs are owned by
`websocket-protocol.ts`. Command names and payloads form one discriminated
contract, and persisted outbox data is parsed before entering replay. There is
no implemented `SyncRuntime` facade.

On the server, Hono route ingress uses Zod/OpenAPI schemas. Persistence record
parsing is centralized in `persistence-records.ts`. Delete, restore, share,
revoke, public-link enable/disable, and scheduled purge behavior are owned by
named workflow modules. External replay failures use stable API error codes so
a generic `403` does not imply access revocation.

## Decision status

### Implemented

- Yjs plus one SQLite-backed Durable Object per collaborative column.
- Offline account snapshots and durable metadata/Yjs outboxes in IndexedDB.
- One replayable metadata command envelope with FIFO replay, bounded retry,
  idempotency keys, operation-specific payloads, and explicit terminal outcomes.
- Optimistic create, reorder, hide, share, revoke, public-link, delete, and
  restore commands through the same queue.
- Offline startup from the latest account snapshot.
- Access-revocation policy: drop affected metadata and Yjs outbox entries,
  detach sync, and notify the user.
- Central WebSocket opcodes/codecs and persisted-record schemas.
- Runtime validation for external request bodies, paths, queries, and headers.
- Named lifecycle and purge workflows with failure-injection coverage.
- Cryptographically secure account/public IDs with bounded collision handling.
- Isolated, single-build full verification that preserves normal development state.
- Enforced browser/server import boundaries and accurately named local storage.
- One authoritative verification command: `pnpm verify` locally and in CI.
- Browser coverage for collaboration, offline restart, outages, revocation, and
  public rendering. One outage smoke retains the real five-second timer; the
  remainder use a deterministic E2E replay wake trigger.

### Superseded

- **TanStack DB and RxDB:** neither dependency is installed. The active browser
  store is the custom IndexedDB-backed implementation described above.
- **`SyncRuntime`, repository, and service-facade hierarchy:** these interfaces
  were never implemented and were removed. Extraction proceeds by cohesive
  workflow ownership rather than a generic facade.
- **Six planned local-first collections:** unused column index/meta collections
  were removed; only the four collections with production readers remain.
- **Two private collaboration clients:** the legacy `ColumnRoom` and unused
  private `useColumnSync` path were removed. Authenticated editing uses the Plate
  provider and `SyncProvider`; public viewing uses `usePublicColumnSync`.
- **HTTP status as replay policy:** stable response codes now drive terminal
  behavior, with status mapping retained only for backward compatibility.

### Deferred work

These are possible follow-up increments, not selected implementations:

- Extract column connection lifecycle and access-loss policy from
  `SyncProvider` into browser-safe modules.
- Continue extracting server lifecycle workflows one operation at a time,
  especially create and successful backup restore.
- Add deterministic failure injection at every external write boundary for the
  remaining multi-store operations.
- Decide whether the custom IndexedDB persistence layer is the long-term store.
  Do not add RxDB or TanStack DB without a new decision based on measured need.
- Consider more E2E parallelism only if isolated E2E Worker state remains
  deterministic.

## Resolved product decisions

### Account number is the authentication credential

The generated 16-digit account number intentionally acts as both identifier and
bearer authentication secret. Possession grants account access; there is no
separate username/password distinction. Users must protect the number like a
password.

This is inspired by
[Mullvad's account-number model](https://mullvad.net/en/blog/mullvads-account-numbers-get-longer-and-safer),
where a generated number serves as both the account's unique token and its
authentication secret. Todoflare adopts that product principle, not an assertion
that its threat model or implementation is otherwise identical to Mullvad's.

### Metadata authority is scoped by domain

Durable Object metadata is authoritative for column existence, ownership,
collaborator access, and public-link identity. Account KV records are
authoritative for account existence, owned-column order, hidden shared columns,
and trash/restore eligibility. The `shared:*` and `public:*` KV records are
derived discovery projections.

Lifecycle operations update authoritative state and then reconcile projections
idempotently. Retrying share or public-link enablement repairs missing KV indexes
without changing the authoritative collaborator set or rotating an existing
public ID. Account hydration validates shared-index entries against DO metadata
and removes entries that no longer grant access.

## Open product and architecture decisions

- Do read-only agent endpoints need a separately versioned public contract?
- Is the current IndexedDB schema and migration strategy sufficient for a
  long-lived production store?

Do not resolve these questions implicitly in unrelated changes. Record a new
decision and its migration/verification plan first.

## Current invariants and guardrails

- Valid account edits are accepted locally and queued while offline.
- Every replayable metadata write carries an idempotency key.
- Replay is FIFO by creation time; transient failures retry and terminal failures
  are removed with a typed reason.
- Yjs owns collaborative content conflict resolution; metadata remains
  server-authoritative after replay/reconciliation.
- Delete and revoke tombstones dominate pending edits.
- Revocation is the only authorization result that triggers column-wide local
  outbox deletion.
- Browser-safe contracts must not import Worker or Durable Object modules.
- The architecture check enforces browser/server import boundaries.
- Route handlers validate ingress once and delegate lifecycle-sensitive work to
  named workflows.
- `pnpm verify:fast` is the development gate; `pnpm verify` is the completion
  gate and must remain identical to CI. Full verification builds once and uses
  only `.wrangler/e2e-state`.

## Historical proposal mapping

The original plan proposed a large facade-oriented migration. Its useful product
goals were retained—offline writes, durable recovery, explicit modes,
idempotency, revocation handling, and telemetry—but the proposed dependency and
class hierarchy was not adopted. The table below is the authoritative mapping:

| Original proposal | Current status |
| --- | --- |
| TanStack DB + RxDB metadata plane | Superseded by custom IndexedDB persistence |
| `SyncRuntime` top-level facade | Not implemented; superseded |
| `MutationQueueService` | Implemented as `LocalMutationQueueService` |
| `AccessPolicyService` | Behavior implemented in `SyncProvider`; extraction deferred |
| `CollaborationService` | Responsibilities split between provider, sync context, protocol module, and Durable Object |
| Explicit sync modes | Implemented |
| Durable metadata and Yjs outboxes | Implemented |
| Revoke drop-and-notify policy | Implemented |
| Startup from local account snapshot | Implemented |
| Queue/replay and outage coverage | Implemented |

Future work should update the status sections above in the same change that
alters architecture or behavior.
