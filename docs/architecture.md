# Architecture

The map of Todoflare: what it owns, where things live, how the important
requests flow, and what must stay true when you change it. Terms are defined
in [domain.md](domain.md); the reasons behind the shape are in
[decisions/](decisions/). Code is the reference for details; this file is the
reference for how the pieces fit.

## Purpose and boundary

Todoflare is a todo board of rich-text columns that works with no account at
all, and gains sync, collaboration, sharing, public links, recovery and AI
agent access when you sign in with a passkey.

Todoflare owns:

- column content (Yjs documents) and column metadata (owner, collaborators,
  public link, trash)
- account order, hidden shared columns and trash
- offline durability in the browser: snapshots and outboxes in IndexedDB
- agent connections, per-column grants, its own OAuth 2.1 authorization
  server, the MCP endpoint and the documents that advertise it
- backups, restore and the release safety procedure

It deliberately does not own:

- authentication primitives: [Better Auth](https://better-auth.com) owns users,
  passkeys, challenges and sessions in D1 ([0003](decisions/0003-passkeys-and-public-account-ids.md))
- email, passwords or social login (none exist)
- the editor: Plate and Yjs live inside `@todoflare/board`, which knows nothing
  about accounts, storage or transport ([0009](decisions/0009-embeddable-board-package.md))

## System at a glance

```text
                         ┌────────────── Cloudflare Worker (src/index.tsx) ───────────────┐
 Browser SPA             │ Hono routes ── same-origin guard ── per-handler guards        │
 (src/client.tsx)        │   │                                                           │
  ├─ guest: localStorage │   ├─► D1 AUTH_DB    Better Auth users/passkeys/sessions,       │
  ├─ account: IndexedDB  │   │                 agent connections, grants, OAuth           │
  │  snapshot + outboxes │   ├─► KV ACCOUNTS   account order/trash, shared:/public:       │
  │  ── HTTPS commands ─►│   │                 discovery projections                      │
  │  ── WebSocket Yjs ──►│   ├─► Durable Objects                                         │
  └─ /p/:id public view  │   │     ColumnRoomSql (one per column: Yjs + metadata,         │
                         │   │       sockets, agent edits)                                │
 MCP clients ── /api/mcp►│   │     AccountCoordinator, PublicIdCoordinator,               │
 (Claude, ChatGPT, …)    │   │     IdempotencyCoordinator, RateLimitCoordinator           │
   └─ OAuth /oauth/*  ──►│   └─► R2 BACKUPS    hourly column + account snapshots          │
                         │ scheduled (hourly cron): cleanup, reconcile, backup, purge    │
                         └────────────────────────────────────────────────────────────────┘
```

Production is `todoflare-prod` at `todo.tamesystems.org`; staging is
`todoflare-staging`, built from `src/staging.ts` (production plus
staging-only recovery controls). Bindings are in `wrangler.jsonc`.

## Code map

```text
src/
  client.tsx            SPA entry and tiny router: /p/:id → PublicView (no SyncProvider),
                        /oauth/authorize → consent page, everything else → SyncProvider + TodoApp
  components/
    todo/TodoApp.tsx    The host: adapts accounts/storage to @todoflare/board
    account/            Passkey modal, reconnect and storage-recovery banners
    agents/             Agents dialog, per-column agent menu, OAuth consent page
    column/             Share menu, presence avatars
    public/             Read-only public column page
    ui/                 shadcn-style primitives
  contexts/sync-context.tsx   SyncProvider: the client runtime root (account, queues, sockets)
  hooks/                React adapters: useColumns (guest vs synced columns), convergence
  lib/
    api/                Shared HTTP contracts: routes.ts, account-commands.ts, *-contract.ts, errors.ts
    sync/               XState machines and queues: account convergence, column sessions,
                        mutation queue, Yjs update outbox, replay policy
    local-first/        IndexedDB database, collections, outbox journal, persistence schema
    collaboration/      Board DocumentAdapter over WebSocket, document cache, wire protocol
    agents/             Browser client for agent management
  index.tsx             Worker entry: middleware, route registration, scheduled(), DO exports
  server/
    routes/             One register*Routes(app) per area (account, account-commands, columns,
                        public, agents, mcp, oauth, discovery, admin-backups, auth)
    workflows/          Named multi-store operations: share, revoke, delete, restore, public
                        link, clone, export, restore-from-backup, reconcile, purge
    http/               Guards (read-only), idempotency, request validation, error envelopes
    agent-access/       MCP protocol, tools, access decision, Yjs edits and undo, D1 store
    oauth/              Authorization server: clients (CIMD, DCR), codes, tokens
    auth.ts, session.ts Better Auth configuration and per-request session
    passkey-policy.ts   User-verification and recent-sign-in checks
    persistence-records.ts  Schemas for every KV/DO record
    column-backups.ts, account-backup.ts, backup-catalog.ts  Backups
  durable-objects/
    column-room.ts      ColumnRoomSql: the authority for one column
    account-coordinator.ts, public-id-coordinator.ts, idempotency-coordinator.ts,
    rate-limit-coordinator.ts
packages/board/         @todoflare/board, the embeddable editor (see its README)
examples/               Two other hosts of the board: minimal (client) and void (SSR)
migrations/             D1 schema: Better Auth, agent access, OAuth
scripts/                Gates (check-*), build/deploy/release, backup operations, analysis
test/                   Vitest, mostly in the Workers runtime (real D1/KV/DO/R2 bindings)
e2e/, hosts-e2e/        Playwright against the E2E build, and against the example hosts
```

Read first: `src/components/todo/TodoApp.tsx`, `src/contexts/sync-context.tsx`,
`src/lib/api/account-commands.ts`, `src/server/routes/account-commands.ts`,
`src/durable-objects/column-room.ts`.

## Dependency rules

These are enforced by `pnpm verify:checks`; a violation fails the build.

```text
packages/board  ◄──  src/components, hooks, contexts, lib  (browser)
                         │
                         ▼ only via HTTP/WebSocket contracts in src/lib/api
                     src/index.tsx ─► src/server ─► src/durable-objects   (Worker)
```

| Rule | Check |
| --- | --- |
| Browser code (`client.tsx`, `components`, `contexts`, `hooks`, `types`, `lib/api`, `lib/sync`, `lib/local-first`, `lib/collaboration`, …) never imports `src/index.tsx`, `src/server/**` or `src/durable-objects/**`, even transitively. | `check:architecture` |
| The board never imports host code, and the host imports the board only as `"@todoflare/board"`. Its public API must match `packages/board/api-report.md`. | `check:board-boundary`, `check:board-api` |
| No `/api/…` or `/p/…` string literal outside `src/lib/api/routes.ts` and `account-commands.ts` (admin routes excepted). Build URLs with `routePath`. | `check:route-literals` |
| Every route in `API_ROUTES` and `ACCOUNT_COMMANDS` is actually served. | `test/route-registration.test.ts` |
| Worker logs and traces stay off, and no account identifier is built into a URL. | `check:sensitive-url-observability` |
| `pnpm verify` builds once, runs E2E against `.wrangler/e2e-state` only, and equals CI. | `check:verification-config` |
| Client JavaScript stays within the gzip budget. | `check:bundle-size` (full `verify` only) |
| React hooks rules, zero warnings. | `lint:hooks` |

Not enforced, but expected: route handlers validate input once and delegate
anything touching more than one store to a named workflow in
`src/server/workflows/`. Guards (read-only, credential, rate limit,
idempotency) are per handler; there is no global middleware for them, so a new
handler must opt in.

## Where state lives and who is authoritative

| State | Authority | Copies and projections |
| --- | --- | --- |
| Column content | `ColumnRoomSql` (Yjs snapshot + update log in DO SQLite) | IndexedDB document cache; Yjs update outbox until acknowledged |
| Column owner, collaborators, public ID, trashed | `ColumnRoomSql` `meta` / `column_lifecycle` | KV `shared:<account>`, `public:<id>`, `column-registry:<id>` (repairable) |
| Account order, hidden columns, trash list | KV `account:<id>`, `trash:<id>` via `AccountCoordinatorSql` | IndexedDB account snapshot |
| Users, passkeys, sessions, recovery-code hash | D1 (Better Auth) | Account backups include users/passkeys, not sessions |
| Agent connections, grants, token hashes, OAuth | D1 | None; deliberately not backed up |
| Agent change log (30 days, at most 1000) | `ColumnRoomSql` `agent_changes` | None |
| Guest columns | `localStorage` `todoflare-columns` | Hourly rolling `todoflare-backup-*` checkpoints |

Projections are repaired, never trusted: account hydration drops `shared:`
entries the DO no longer grants, and the DO rejects a stale `public:` mapping
([0005](decisions/0005-metadata-authority-by-domain.md)).

## Runtime flows

### 1. Guest editing

```text
TodoApp ─ createMemoryDocuments() ─ board editor
  onContentChange ─► useColumns.updateColumnValue ─► localStorage "todoflare-columns"
                                                  └► hourly checkpoint "todoflare-backup-YYYYMMDDHH"
```

- `src/hooks/useColumns.ts` (`loadLocalColumns`, `setLocalColumns`, `persistLocalCheckpoint`).
- Saves are skipped when the JSON is unchanged, so selection moves do not
  write. The editor adds node ids to the default column on its first change,
  so the first save can be an id-only normalization.
- If the save throws (quota), the attempted value is kept for export, editing
  pauses (`browserStorageError`) and `StorageRecoveryBanner` offers a recovery
  download and retry. Checkpoint failures are only logged.

### 2. Signed-in startup and convergence

```text
SyncProvider ─► open IndexedDB, move outboxes onto it
  account convergence actor (src/lib/sync/account-convergence-machine.ts):
  loadingLocal ─► hydratingServer (GET /api/account) ─► replaying (mutation queue)
     ─► reconciling (apply acks, access loss) ─► confirmingServer ─► ready
```

- The display is always the server base plus pending commands
  (`projectPending`), so a late hydration cannot erase an optimistic change.
- Hydration runs before replay; a newly persisted command can jump straight
  to replay.
- Queue storage is opened before columns mount, so a fast reconnect cannot
  miss durable Yjs frames.
- An expired session moves to `authenticationRequired`: replay and realtime
  pause, nothing local is discarded, `ReconnectBanner` asks for the same
  account's passkey.
- Client mode (`deriveSyncMode`, `src/lib/sync/mode-machine.ts`): `guest_local`,
  `account_auth_required`, `account_offline`, `account_realtime`,
  `account_syncing`. Signed-in editing is read-only unless browser storage is
  durable.

### 3. A metadata command (create, share, delete, …)

```text
UI ─► submit(command) ─► LocalMutationQueueService.enqueue (journal + IndexedDB, idempotency key)
   ─► replay, FIFO ─► account-command-executor ─► POST/PUT/DELETE (X-Idempotency-Key)
   ─► route: read-only guard ─► session ─► validate ─► withIdempotentWrite
             ─► runJournaledLifecycle ─► named workflow ─► DO first, then KV projections
   ◄─ ack + effects, or a stable error code ─► retry / drop with typed reason
```

- One table, `ACCOUNT_COMMANDS` in `src/lib/api/account-commands.ts`, defines
  each command's path, payload, body and response schemas and affected column.
  The outbox parser, executor and server registration all derive from it.
- Replay policy comes from error codes, not HTTP status
  (`src/lib/sync/replay-response.ts`): `access_revoked`, `not_owner`,
  `not_found`, `invalid_request`, `idempotency_conflict`,
  `idempotency_outcome_unknown` drop; 401 pauses; everything else retries
  ([0007](decisions/0007-stable-error-codes-drive-replay.md)).
- The executor checks the response means what was asked (a share response
  must list the target). A mismatch retries; success is never inferred.
- Server side, the lifecycle journal (`lifecycle-operation:*` in KV) is
  written first and removed on success; the hourly
  `reconcileColumnLifecycle` finishes anything a crash left half-done.

Delete is the clearest example (`src/server/workflows/delete-column.ts`): KV
projections are removed before the DO fields they mirror, so a retry can
still find them, and the trash record is written last as the commit. The
room keeps the first deletion time, so a repeat or retried delete leaves
the purge date alone. Every
write boundary has a failure-injection test in
`test/column-lifecycle-workflows.test.ts`.

### 4. Editing a column while signed in

```text
editor ─ Y.Doc update ─► cache in IndexedDB ─► Yjs outbox (persist first)
   ─► column session actor (one per column) ─► POST /api/column/:id/ws-ticket
   ─► GET /api/column/:id/ws?ticket=… ─► ColumnRoomSql
        full state to client; client replays every unacknowledged outbox frame
        DO: re-check access ─► transaction(received_outbox + yjs_updates) ─► apply
            ─► echo to all sockets ─► sync-ack to sender ─► outbox entry removed
        alarm ~10 s later: compact into yjs_snapshot
```

- Sessions: `src/lib/sync/column-session-manager.ts`,
  `column-session-machine.ts`, `column-socket-actor.ts`. Durable bytes live
  only in `src/lib/sync/yjs-update-outbox.ts`.
- Tickets are single use, live 45 s and are stored hashed; only the ticket,
  never a cookie or account ID, enters the URL
  ([0004](decisions/0004-single-use-websocket-tickets.md)).
- **Acknowledged means durable.** An outbox entry is removed only after the
  DO has committed it. A repeated outbox ID with the same digest is re-acked
  (another tab's replay); a different digest closes the socket.
- Removing an entry leaves a removal marker in both outboxes (localStorage
  `…:removed:<id>`, IndexedDB `deletedKeys`) so a stale tab cannot rewrite it.
  Markers expire after 7 days (`REMOVAL_MARKER_TTL_MS`,
  `src/lib/local-first/outbox-journal.ts`); a later resurrection only replays
  an update the DO re-acks. Unexpired markers once filled localStorage
  (one per acknowledged edit) and paused editing.
- There is no state-vector exchange: on reconnect the server sends its whole
  document and the client its whole unacknowledged outbox, and Yjs merges.
- Presence is derived on the server from sessions; awareness (cursors) is
  relayed and kept only as the latest entry per column. The room stops
  y-protocols' expiry timer so it can hibernate: a peer's entry is dropped when
  its socket closes, and clients expire peers that stop renewing.

### 5. Losing access

A revoke or delete reaches the client over the socket (`access-revoked`,
`column-deleted`), from a ticket 403/404, from a `revoked` replay result, or
from a shared column missing in a fresh hydration. All paths end in
`applyColumnAccessLossPolicy` (`src/contexts/sync-context.tsx`): drop the
column's cached document, queued commands and Yjs outbox, remove it from the
projection (which unmounts the editor), and show a toast. Revocation is the
only authorization result that discards local work.

### 6. Public link

`/p/:publicId` renders `PublicView` without `SyncProvider`; it opens
`/api/p/:publicId/ws` (no ticket) and renders a static `ColumnSnapshot`. The
Worker resolves the KV `public:` mapping, but the DO accepts only if its own
`meta.publicId` matches, and marks the session read-only server-side.

### 7. An agent tool call

```text
MCP client ─ POST /api/mcp, Authorization: Bearer tfa_… ─► src/server/routes/mcp.ts
  resolve token (SHA-256 lookup in D1) ─► rate limit (120/min/connection)
  ─► protocol era (2026-07-28 native, or legacy 2025-*) ─► tool (src/server/agent-access/tools.ts)
  ─► authorizeColumn: grant ∩ the account's live access ─► decideAgentColumnAccess
  reads: DO /yjs-state ─► markdown
  writes: DO /agent-edit ─► scratch doc ─► diff ─► transaction(update + agent_changes row) ─► broadcast
```

- Agent access is the intersection of the grant and the granting account's
  current access; anything invisible returns the same "not found"
  ([0010](decisions/0010-agent-access-model.md)).
- Every agent write goes through the column's DO, which re-checks membership
  and trash atomically with the write.
- Undo is compare-and-revert ([0011](decisions/0011-agent-undo-compare-and-revert.md)).
- OAuth clients (Claude.ai, ChatGPT) discover
  `/.well-known/oauth-protected-resource/api/mcp`, identify themselves with a
  Client ID Metadata Document (or DCR), and get a code from the consent page
  `/oauth/authorize`, where approval creates the connection and its grants
  ([0012](decisions/0012-own-oauth-server-public-clients.md)). Details:
  [proposals/agent-access.md](proposals/agent-access.md).
- Before connecting, agents and crawlers can find the endpoint from
  `/llms.txt`, the MCP server card `/.well-known/mcp/server-card.json`, the
  RFC 9727 catalog `/.well-known/api-catalog` (linked from `/` by a `Link`
  header in `public/_headers`) and `/robots.txt`, all generated in
  `src/server/routes/discovery.ts` from the same constants the endpoint uses
  ([0016](decisions/0016-generated-agent-discovery.md)). Only production
  `robots.txt` admits crawlers, and never to `/p/`, `/oauth/` or `/api/`.

### 8. Sign-in and account creation

`GET /api/auth-status` → anonymous Better Auth user (its id *is* the 16-digit
Account ID; the email is synthetic and never leaves the auth subsystem) →
`addPasskey` → `POST /api/account` creates the KV account record. Abandoned
provisional users are deleted by cron after 7 days. Requests carry
`X-Todoflare-Expected-Account`; a mismatch with the cookie's user is 401, so
work queued for one account can never run as another. Later credential
changes need a recent sign-in, and `src/server/passkey-policy.ts` refuses
passkey ceremonies without user verification
([0017](decisions/0017-verified-passkeys-and-recent-credential-changes.md)).

### 9. The hourly cron

`scheduled` in `src/index.tsx`, skipped entirely in read-only mode:
provisional-user cleanup → `reconcileColumnLifecycle` → `runScheduledBackups`
→ `purgeExpiredTrashedColumns` (final backup before each purge; the DO refuses
a purge if the column was restored meanwhile). See
[operations.md](operations.md).

## Cross-cutting concepts

- **Read-only mode** (`READ_ONLY_MODE`, `src/server/read-only-mode.ts`): the
  incident and release freeze. Blocks every write route, WebSocket tickets and
  private upgrades, DO submissions, agent writes and cron; allows reads,
  public sockets, passkey sign-in, sign-out, revoking agents and admin backups.
  In-place restores require it. `GET /api/clock` reports it and the build.
- **Validation at every trust boundary**: Zod at HTTP ingress, persisted
  records parsed in `src/server/persistence-records.ts` and
  `src/lib/local-first/persistence-contract.ts`, outbox entries parsed before
  replay. Both sides of a contract validate it, from one schema.
- **Idempotency**: every replayable write has a key; `IdempotencyCoordinatorSql`
  stores the outcome for 24 h and replays it. After a 5xx, a throw or a
  lapsed lease the outcome is unknown; a `rerunnable` write (every queued
  account command, not import) re-runs on the next retry instead of
  answering `idempotency_outcome_unknown`
  ([0015](decisions/0015-rerunnable-idempotent-writes.md)).
- **Rate limits**: `src/lib/rate-limit.ts` over `RateLimitCoordinatorSql`,
  applied per handler.
- **XState** for behavior with real lifecycles (convergence, column sessions);
  conventions in [agent-patterns/xstate.md](../agent-patterns/xstate.md),
  source in `repos/xstate/` (read-only).

## Invariants

Breaking one of these is a bug even if every test passes.

- An Account ID alone never authenticates. Only a passkey session (or a
  recovery code) does. Synthetic emails never leave the auth subsystem.
- A passkey ceremony without user verification never succeeds, and a
  credential that outlives its session (passkey, recovery code) is added only
  from a recent sign-in ([0017](decisions/0017-verified-passkeys-and-recent-credential-changes.md)).
- A valid edit made offline is kept until the server acknowledges it; an
  expired session never discards local work.
- Every replayable metadata write carries an idempotency key, and replay is
  FIFO by creation time.
- The DO is authoritative for column access; KV `shared:`/`public:` records
  are projections and must be repairable from it.
- Delete and revoke dominate pending edits. Revocation is the only result
  that drops a column's local queue.
- A Yjs outbox entry is removed only after the DO committed it.
- Corrupt Yjs state blocks reads, writes, sockets and compaction rather than
  being compacted away.
- Read-only mode stops every write path, including cron.
- `ColumnRoomSql` holds no timers or non-hibernatable sockets between
  messages. Anything pending keeps the object awake, and it is billed for
  duration the whole time a column is open.
- An agent's access never exceeds its account's live access; no agent-facing
  route can widen, extend or create access; column text is data, not
  instructions.
- Agent credentials are never backed up or restored.
- Production writes reopen only after the exact frozen build was verified
  ([0013](decisions/0013-frozen-release-verification.md)).

## Known gaps

Recorded so they are not mistaken for intent:

- There is no OAuth token revocation endpoint (RFC 7009); disconnecting in the
  Agents dialog revokes everything for a connection.
- A column session actor that ends through access loss stays in
  `ColumnSessionManager.sessions` until reload.
- `src/lib/rate-limit.ts` is server-only but sits under `src/lib`, so
  `check:architecture` would not catch a browser import of it.
