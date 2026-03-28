## Local-First Account Mode Plan

### Decision Log

- Treat offline account edits as fully allowed and queued for later sync.
- If access is revoked while offline, drop queued edits and show "access revoked."

### Goal

Make Todoflare truly local-first in account mode while preserving real-time collaboration.

### End State

- Account mode works offline with durable local state.
- Edits are never dropped while disconnected.
- Reconnect performs deterministic catch-up and conflict-safe merge.
- Realtime presence/cursors still work when online.
- Existing Cloudflare Durable Objects remain source of truth for shared collaboration.

### Architecture

- Keep Yjs + Durable Object for collaborative rich-text CRDT and presence.
- Add TanStack DB + RxDB for local-first metadata and mutation/outbox orchestration.
- Split responsibilities:
  - Yjs plane: column content CRDT + presence.
  - TanStack/RxDB plane: account, column order, shares, public-link state, delete/restore state, pending commands.

### Software Design Strategy (Complexity-First)

#### Design goals for this migration

- Reduce cognitive load in `SyncProvider` by decomposing responsibilities into deep modules.
- Hide volatile decisions (queue policy, reconnect policy, revocation policy) behind stable interfaces.
- Preserve conceptual integrity by enforcing one vocabulary and one control flow model.
- Keep UI code dumb: UI reads projections and dispatches intent; orchestration lives in runtime services.

#### Design it twice (before locking implementation)

Candidate A: incremental extraction from `SyncProvider` into utility hooks/services while preserving direct calls.

- Pros: fastest to ship; minimal initial churn.
- Cons: tends to create shallow wrappers and indirect coupling; likely to recreate the same monolith in a different shape.

Candidate B (chosen): explicit runtime facade with module boundaries and command/event flow.

- Pros: higher module depth, stronger ownership boundaries, easier to test and evolve, clearer local-first invariants.
- Cons: slightly higher upfront design/bootstrapping cost.

Decision: use Candidate B architecture, with Candidate A extraction steps only as transitional refactors.

#### Decomposition and ownership boundaries

- `SyncRuntime` (top-level orchestration facade)
  - Owns lifecycle (`start`, `stop`), wiring, and cross-module coordination.
  - Exposes stable API to React context/hook layer.
- `AuthSessionService`
  - Owns account identity, persisted session token/account id, and auth refresh behavior.
- `AccessPolicyService`
  - Owns authorization state (`allowed`, `revoked`, `unknown`) and revoke decisions.
  - Single place that enforces the product policy: drop queued edits on revoke.
- `AccountRepository` (TanStack DB + RxDB backed)
  - Owns metadata snapshots/projections for account, column index, share/public flags.
  - UI reads from this only, not directly from transport or fetch calls.
- `MutationQueueService`
  - Owns offline command queue, replay, backoff, idempotency, and hard-failure semantics.
- `CollaborationService` (Yjs + DO transport)
  - Owns per-column transport lifecycle and Yjs update application.
  - No account metadata mutation logic.
- `PresenceService`
  - Owns ephemeral collaborator presence projection and local presence updates.
- `NotificationPort`
  - Owns user-facing toasts/banners so domain modules do not import UI notification libs directly.

#### Interface-first contracts (stable boundaries)

Use interface contracts as the boundary between modules. Internal implementation can evolve freely.

```ts
interface SyncRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  dispatch(command: SyncCommand): Promise<DispatchResult>;
  status$(): Observable<SyncStatus>;
}

interface MutationQueueService {
  enqueue(cmd: AccountEditCommand): Promise<string>;
  replay(options?: { maxBatch?: number }): Promise<ReplayReport>;
  dropWhere(
    predicate: (m: QueuedMutation) => boolean,
    reason: DropReason,
  ): Promise<number>;
  pending$(): Observable<QueuedMutation[]>;
}

interface AccessPolicyService {
  evaluate(ctx: AccessContext): Promise<AccessPolicy>;
  policy$(): Observable<AccessPolicy>;
}
```

#### Coupling rules (non-negotiable)

- UI components depend only on Sync facade/repository APIs.
- Metadata plane and collaboration plane communicate only through typed events, never shared mutable objects.
- Transport wire details (op codes, message decoding) stay inside collaboration transport adapters.
- Queue replay decisions stay in `MutationQueueService` + `AccessPolicyService`, never in UI handlers.
- No module may write to both Yjs state and metadata store for the same concern.

#### Deep module guardrails

- Prefer one powerful module with a small API over multiple thin pass-through helpers.
- A module must own at least one hard concern (policy, retries, merge/reconcile, lifecycle), not just rename calls.
- Avoid "manager" files that only delegate; merge them into owning modules unless they provide clear abstraction.

#### Invariants to encode in design

- Offline account edits are always accepted locally and queued.
- Replay is idempotent and deterministic (FIFO by creation time, bounded retry policy).
- Access revocation cancels replay eligibility for affected columns.
- On revoke, queued metadata and Yjs updates for that column are dropped, sync is detached, user is notified.
- Startup is deterministic: online hydrates from server then reconciles; offline hydrates from RxDB snapshot.

#### Error handling by design (define errors out where possible)

- Use one command envelope shape with required idempotency key for all replayable mutations.
- Use one replay path for online recovery to avoid duplicate behavior branches.
- Use typed terminal reasons (`revoked`, `not_found`, `validation_failed`) to avoid string-matching error logic.
- Separate transient failure handling (retry) from terminal policy handling (drop and notify).

#### Conceptual integrity and naming

- Use one domain language everywhere: `command`, `event`, `projection`, `policy`, `replay`, `revoked`.
- Avoid mixed synonyms (`sync queue`, `pending ops`, `outbox`) in code and docs; choose one canonical term per concept.
- Keep mode names explicit and globally reused: `guest_local`, `account_offline`, `account_syncing`, `account_realtime`, `public_readonly`.

#### Comments and documentation standard

- Interface comments describe usage contract: ordering, idempotency, failure behavior, and side effects.
- Rationale comments explain non-obvious decisions (for example, why revoked offline edits are dropped).
- Do not add implementation-noise comments that restate code.
- For each deep module, include a short module header comment: purpose, owned invariants, and what it does not own.

#### PR design-review checklist

- [ ] Does this change reduce or preserve overall conceptual complexity?
- [ ] Is module ownership clear and singular?
- [ ] Is new behavior exposed through a stable interface, not leaked internals?
- [ ] Are offline writes routed through the queue (no bypass path)?
- [ ] Is revoke behavior centralized and tested (`drop + notify`)?
- [ ] Are transport concerns hidden from UI and repositories?
- [ ] Are retries/idempotency semantics explicit and covered by tests?
- [ ] Did we avoid introducing shallow wrappers?
- [ ] Are interface and rationale comments updated where behavior changed?

### Phased Implementation

#### 1) Add local-first core (TanStack DB + RxDB)

- Add dependencies: `@tanstack/react-db`, `@tanstack/rxdb-db-collection`, `rxdb` (+ storage plugin).
- Create `src/lib/local-first/rxdb.ts` for DB init and migrations.
- Create `src/lib/local-first/collections.ts` with:
  - `account_snapshot`
  - `column_index`
  - `column_meta_cache`
  - `mutation_outbox` (metadata commands)
  - `yjs_update_outbox` (content updates)
  - `sync_state`
- Keep `useSyncContext` public API stable to avoid immediate UI churn.

#### 2) Introduce deterministic mode state machine

- Replace implicit flags in `src/contexts/sync-context.tsx` with explicit states:
  - `guest_local`
  - `account_offline`
  - `account_syncing`
  - `account_realtime`
  - `public_readonly`
- Define transition rules for auth changes, websocket up/down, API health, and DO degradation.

#### 3) Move metadata writes to optimistic local mutations + replay queue

- Wrap operations (create/reorder/hide/share/revoke/public-link/delete/restore) as queued commands.
- Command envelope:
  - `idempotencyKey`
  - `opType`
  - `entityId`
  - `payload`
  - `createdAt`
  - `attemptCount`
  - `nextRetryAt`
- Replay worker behavior:
  - FIFO by `createdAt`
  - Exponential backoff + jitter
  - Remove command on server ack
  - Surface actionable UI state on hard failure

#### 4) Make Yjs content fully offline-durable

- In `src/lib/collaboration/cloudflare-yjs-provider.ts`:
  - Persist local Yjs doc updates.
  - Enqueue unsent updates to `yjs_update_outbox` when disconnected.
- On reconnect:
  - Perform state-vector reconciliation.
  - Flush queued updates in order.
  - Prune acknowledged updates.
- Coordinate websocket sync behavior with `src/durable-objects/column-room.ts`.

#### 5) Enforce revoke policy (selected behavior)

- On revoke event (or revoke during replay):
  - Mark column inaccessible in `column_meta_cache`.
  - Remove pending metadata commands for that column.
  - Remove pending `yjs_update_outbox` entries for that column.
  - Detach active editor sync for that column.
  - Show toast/banner: "Access revoked. Unsynced changes were discarded."

#### 6) Bootstrapping and conflict rules

- Startup behavior:
  - Online: hydrate from server, then subscribe realtime.
  - Offline: hydrate from RxDB snapshot immediately.
- Conflict policy:
  - Yjs content: CRDT merge.
  - Metadata: server-authoritative with idempotency/version checks.
  - Delete/revoke tombstones dominate pending edits.

#### 7) Rollout and safety

- Staged rollout:
  1. Internal/dev only
  2. Small percentage of production accounts
  3. Full rollout
- Telemetry:
  - queue depth
  - replay latency
  - revoke-discard count
  - convergence failures

#### 8) Test plan

- Unit tests:
  - replay worker ordering/backoff/idempotency
  - revoke policy dropping queued edits
- Integration tests:
  - offline create/edit/reorder/delete then reconnect
  - multi-tab same-account consistency
  - shared column revoke while editor offline
- E2E tests:
  - network flap during active editing
  - backend unavailable then recovery
  - public/shared mode boundaries

### Primary File Touch Points

- `src/contexts/sync-context.tsx`
- `src/hooks/useColumns.ts`
- `src/lib/collaboration/cloudflare-yjs-provider.ts`
- `src/durable-objects/column-room.ts`
- `src/components/todo/TodoColumn.tsx`
- `src/lib/local-first/*`
