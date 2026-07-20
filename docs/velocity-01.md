# Developer velocity review

Audit scope: commit `3a40ec0`, clean worktree. No code was modified.

## 1. Executive summary

Todoflare has a strong architectural core for a project of this size:

- Metadata writes follow one durable, typed command queue.
- Lifecycle-sensitive server behavior is increasingly owned by named workflows.
- Failure-injection tests cover delete, restore, sharing, public links, and purge.
- Browser/server imports are automatically enforced.
- Local and CI completion use the same `pnpm verify` command.
- The incremental gate is fast: `verify:checks` completed in **8.78 seconds**, and a production build took **1.42 seconds**.

The main velocity problem is not excessive framework layering. It is that several important workflows still converge in two very large orchestration files:

- [src/contexts/sync-context.tsx](/Users/lukasmurdock/Documents/GitHub/todoflare/src/contexts/sync-context.tsx:317): 2,065 lines, approximately 20 state declarations, 40 callbacks, 12 effects, and 11 typed refs.
- [src/index.tsx](/Users/lukasmurdock/Documents/GitHub/todoflare/src/index.tsx:54): 2,163 lines and 22 raw Hono routes.

The three highest-value improvements are:

1. **Restore the authoritative verification gate and make account hydration monotonic.** The 23-test browser suite currently fails deterministically; the same test failed again in isolation.
2. **Give account identity/access semantics one pure owner.** A production WebSocket path compares normalized session IDs against formatted stored IDs, while other access paths normalize both sides.
3. **Move import and backup restore into tested, named workflows.** These destructive multi-store operations remain embedded in the route file, duplicate restore logic, and sometimes ignore Durable Object failures.

Overall velocity is good for ordinary isolated changes, but changes involving account hydration, sharing, realtime access, or recovery require too much cross-file reasoning.

## 2. Intended paved road

| Concern                    | Existing preferred path                                                                                                                                                                                         | Contradiction or ambiguity                                                                                                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Data access                | Worker routes and named workflows use Cloudflare KV/R2 directly and Durable Object `fetch` endpoints. DO metadata is authoritative for access; KV contains account authority and repairable projections.        | Import and backup restoration still perform multi-store mutations directly inside `index.tsx`. Shared-index KV records are parsed ad hoc in at least eight production locations.                             |
| Transport and APIs         | Hono handles HTTP; `account-command-executor.ts` maps all replayable browser metadata commands to HTTP; WebSockets carry Yjs and presence using one protocol module.                                            | Main APIs use 22 raw Hono routes plus custom validation; the agent API uses 3 declarative OpenAPI routes and six `any` casts.                                                                                |
| Validation                 | Zod validates external HTTP ingress. Persisted account, column metadata, and trash records use centralized parsers. Persisted outbox commands are parsed before replay.                                         | Record parsers are shallower than ingress schemas; shared-index records lack a parser; DO SQL metadata is loaded with casts; API schemas and TypeScript interfaces are duplicated.                           |
| Forms and user input       | Components own transient form state and reuse account formatting/validation from `lib/account.ts`.                                                                                                              | Sharing state is also copied into component-local caches, despite already existing in context projections and `ColumnMeta`.                                                                                  |
| Data loading and state     | `SyncProvider` loads an IndexedDB snapshot first, hydrates from the server, replays queues, and owns realtime connections. `useColumns` derives the displayed projection.                                       | A late server hydration can replace newer optimistic state. Account state, metadata overlays, queue results, connection state, telemetry, and access-loss behavior share one 2,065-line provider.            |
| Shared semantics and types | `types/account.ts`, sync contracts, API error codes, and WebSocket protocol constants are the main sources of truth.                                                                                            | `SyncMode` is redeclared in `collections.ts`; `AccountExportPayload` is redeclared in `index.tsx`; agent schemas copy `ColumnMeta`; storage keys are repeated across three production files and E2E helpers. |
| Error handling             | Replay policy uses stable API error codes, with HTTP-status fallback only for older deployments. Named lifecycle workflows return typed failures.                                                               | Agent APIs return a different error envelope and omit stable error codes. Some route and DO failures throw, some return coded JSON, and some are ignored.                                                    |
| Testing                    | Pure deterministic rules use unit tests; Worker, KV, DO, authorization, failure repair, and persistence behavior use Workers-runtime integration tests; 23 Playwright journeys cover critical browser behavior. | Successful backup restoration has no durable integration coverage. The production normalized-ID WebSocket case is absent. The current browser gate fails.                                                    |
| Local verification         | `pnpm verify:fast`; individual typecheck, test, architecture, and build scripts are available.                                                                                                                  | No React Hooks linting protects 40 provider callbacks and 12 effects.                                                                                                                                        |
| Full verification          | `pnpm verify`, identical in CI, performs checks, one E2E build, and Playwright. E2E state is isolated.                                                                                                          | Currently red. Browser run: 22 passed, 1 failed in 24.46 seconds; isolated rerun failed again in 8.79 seconds.                                                                                               |

The README and [PLAN.md](/Users/lukasmurdock/Documents/GitHub/todoflare/PLAN.md:1) substantially agree with production. One minor documentation contradiction is that the README lists a `docs/` directory that does not exist.

## 3. Findings

### F1. The authoritative completion gate is deterministically failing

- **Severity:** Critical
- **Category:** Verification, state convergence
- **Evidence:** `pnpm test:e2e` failed at [e2e/sharing.spec.ts:344](/Users/lukasmurdock/Documents/GitHub/todoflare/e2e/sharing.spec.ts:344), with 22/23 passing. The same test failed when run alone. After a successful share response, the page snapshot no longer contained the column or share popover.
- **Current developer cost:** Every change is either blocked from completion or encourages developers to normalize a red gate.
- **Conflict with velocity tenets:** The authoritative safe path is not usable.
- **Recommended improvement:** First make account hydration/reconciliation monotonic. A response initiated before a local mutation must not replace newer account state. Use a request generation/revision or reconcile server data with commands created after the request began. Keep the test assertion outcome-based.
- **Expected benefit:** Restores trustworthy delivery and removes a likely class of hydration-versus-optimistic-update races.
- **Implementation effort:** Medium
- **Migration risk:** Medium; reconciliation policy affects offline behavior.
- **Confidence:** Gate failure confirmed. The stale-hydration cause is a high-confidence hypothesis based on [fetchAccount](/Users/lukasmurdock/Documents/GitHub/todoflare/src/contexts/sync-context.tsx:1135), its unconditional `setAccount` at line 1172, optimistic creation at line 1657, and the observed column disappearance.
- **Suggested automated guardrail:** Add a browser race test that deliberately delays account hydration, creates and shares a column, then releases the stale hydration response and asserts that the column remains.

### F2. Account access semantics are duplicated and disagree in the WebSocket revocation path

- **Severity:** High
- **Category:** Authorization, single source of truth
- **Evidence:** Normal access checks normalize both IDs in [column-room.ts:261](/Users/lukasmurdock/Documents/GitHub/todoflare/src/durable-objects/column-room.ts:261). `notifyAccessChanges` instead uses raw equality and `Set.has` at [column-room.ts:541](/Users/lukasmurdock/Documents/GitHub/todoflare/src/durable-objects/column-room.ts:541). Production constructs WebSocket URLs with normalized account IDs at [sync-context.tsx:1335](/Users/lukasmurdock/Documents/GitHub/todoflare/src/contexts/sync-context.tsx:1335), while `sharedWith` is stored in display format by [share-column.ts:69](/Users/lukasmurdock/Documents/GitHub/todoflare/src/server/workflows/share-column.ts:69). The DO test connects using the formatted ID at [column-room-sql.test.ts:288](/Users/lukasmurdock/Documents/GitHub/todoflare/test/column-room-sql.test.ts:288), so it misses production behavior.
- **Current developer cost:** Authorization changes require checking the Worker, six lifecycle workflows, agent API, DO, client projection, and tests.
- **Conflict with velocity tenets:** One security-sensitive semantic has multiple implementations.
- **Recommended improvement:** Introduce pure browser-safe functions such as `isColumnOwner(meta, accountId)`, `hasColumnAccess(meta, accountId)`, and `normalizeAccountIdSet(ids)`. Use them across the Worker, agent API, workflows, DO, and `useColumns`. This is a narrow semantic owner, not an access-policy service hierarchy.
- **Expected benefit:** Fewer repeated conditionals and protection against formatting-dependent authorization bugs.
- **Implementation effort:** Low–medium
- **Migration risk:** Low if behavior is characterized first.
- **Confidence:** High
- **Suggested automated guardrail:** DO integration test with a normalized WebSocket session ID and formatted `sharedWith`; adding a second collaborator must not revoke the first.

### F3. `SyncProvider` is a mandatory 2,065-line coordination surface

- **Severity:** High
- **Category:** Workflow cohesion, mandatory layers
- **Evidence:** [sync-context.tsx](/Users/lukasmurdock/Documents/GitHub/todoflare/src/contexts/sync-context.tsx:317) owns account login, local snapshot persistence, mutation replay, command effects, access loss, per-column WebSockets, Yjs outbox behavior, telemetry, CRUD operations, import/export, and React context assembly. It contains roughly 20 state declarations, 40 callbacks, 12 effects, and 11 typed refs.
- **Current developer cost:** A change to sharing, hydration, connection handling, replay, or account state requires understanding unrelated lifecycle and closure dependencies in the same file.
- **Conflict with velocity tenets:** Important workflows are fragmented inside one technical orchestration root rather than cohesive named modules.
- **Recommended improvement:** Preserve `SyncContextValue` as the public UI API while extracting three cohesive owners incrementally:
    1. account hydration and snapshot reconciliation;
    2. metadata command enqueue/replay/effect reconciliation;
    3. column connection lifecycle and access-loss cleanup.
- **Expected benefit:** Feature changes open one relevant workflow module instead of the entire synchronization runtime.
- **Implementation effort:** Medium–high
- **Migration risk:** Medium because closure timing and React lifecycle matter.
- **Confidence:** High
- **Suggested automated guardrail:** Existing queue/connection unit tests plus race-focused browser tests; add React Hooks linting before extraction.

### F4. Recovery and import operations lack one explicit invariant owner

- **Severity:** High
- **Category:** Destructive operations, multi-record workflows
- **Evidence:** Backup restore logic spans helpers at [index.tsx:678](/Users/lukasmurdock/Documents/GitHub/todoflare/src/index.tsx:678), account restoration at line 1764, and column clone/in-place restoration at line 1908. Checksum and projection reconciliation are duplicated. Self-serve import performs DO `/init` and `/import` but ignores both response statuses at [index.tsx:1219](/Users/lukasmurdock/Documents/GitHub/todoflare/src/index.tsx:1219), then commits column IDs to the account. Successful backup restoration has no integration test.
- **Current developer cost:** Recovery changes require reading more than 400 lines of a general route file and reasoning about R2, DO metadata/Yjs, owner order, shared indexes, and public mappings.
- **Conflict with velocity tenets:** Destructive multi-store behavior is not cohesive or protected at the cheapest trustworthy boundary.
- **Recommended improvement:** Extract two named workflows:
    - `cloneColumnSnapshot`, shared by account import and clone restore;
    - `restoreColumnBackup`, owning checksum validation, pre-restore backup, DO import, and projection repair.
      Commit the account projection only after successful DO writes. Expose write-boundary observers like existing lifecycle workflows.
- **Expected benefit:** One tested implementation for recovery invariants and smaller route handlers.
- **Implementation effort:** Medium
- **Migration risk:** Medium–high because recovery is destructive.
- **Confidence:** High
- **Suggested automated guardrail:** Failure injection after every R2, DO, account KV, shared-index, and public-index write; assert retries converge without duplicate columns or lost access.

### F5. Persisted-record validation is incomplete and has competing definitions

- **Severity:** Medium
- **Category:** Validation, source of truth
- **Evidence:** Strong Zod ingress schemas exist at [index.tsx:516](/Users/lukasmurdock/Documents/GitHub/todoflare/src/index.tsx:516), but persisted parsers at [persistence-records.ts:27](/Users/lukasmurdock/Documents/GitHub/todoflare/src/server/persistence-records.ts:27) only check that arrays exist—not their element types, ID validity, finiteness, or limits. Shared index arrays are raw `JSON.parse` results in the Worker, agent API, and three workflows. DO SQL metadata is cast after parsing at [column-room.ts:87](/Users/lukasmurdock/Documents/GitHub/todoflare/src/durable-objects/column-room.ts:87).
- **Current developer cost:** Every new stored field must be updated in interfaces, Zod schemas, hand-written record parsers, agent schemas, and sometimes DO loading.
- **Conflict with velocity tenets:** Validation happens at real boundaries, but each boundary uses an independent semantic definition.
- **Recommended improvement:** Make shared runtime schemas authoritative for persisted `Account`, `ColumnMeta`, trash, shared indexes, and backup payloads. Infer server types from them or verify existing types against them. Browser imports should remain type-only so server validation code is not bundled.
- **Expected benefit:** Corrupt records fail consistently and schema changes have one obvious edit point.
- **Implementation effort:** Medium
- **Migration risk:** Medium; stricter parsing may expose existing malformed records.
- **Confidence:** High
- **Suggested automated guardrail:** Table-driven parser tests for wrong array members, malformed IDs, non-finite timestamps, unsupported versions, and corrupt shared indexes.

### F6. API authoring has two paths, and contract types drift

- **Severity:** Medium
- **Category:** Transport, duplicated schemas
- **Evidence:** `index.tsx` defines 22 raw routes with custom validation. [agent-api.ts](/Users/lukasmurdock/Documents/GitHub/todoflare/src/agent-api.ts:209) defines 3 `createRoute` contracts and requires `c: any` plus `as any` for each handler. `agentColumnMetaSchema` at line 58 copies `ColumnMeta` but omits `schemaVersion`, even though handlers return actual `ColumnMeta`. `AccountExportPayload` exists in both [types/account.ts:85](/Users/lukasmurdock/Documents/GitHub/todoflare/src/types/account.ts:85) and [index.tsx:506](/Users/lukasmurdock/Documents/GitHub/todoflare/src/index.tsx:506). `AppType` is exported but unused.
- **Current developer cost:** A developer adding an endpoint cannot infer whether raw Hono or OpenAPI is preferred, and API model changes require synchronized edits.
- **Conflict with velocity tenets:** Two authoring conventions exist without a documented boundary.
- **Recommended improvement:** Do not migrate all routes merely for consistency. Declare a narrow rule:
    - versioned agent API: `createRoute` and OpenAPI;
    - same-deployment browser API: raw Hono with shared schemas.

    Remove handler `any` casts, derive agent schemas from shared runtime schemas, and delete unused RPC types if Hono RPC is not being adopted.

- **Expected benefit:** One obvious path per boundary, without forcing OpenAPI ceremony onto internal browser routes.
- **Implementation effort:** Low–medium
- **Migration risk:** Low
- **Confidence:** High
- **Suggested automated guardrail:** Architecture check asserting that `/api/agent/v1` routes are declarative and production route handlers contain no `any` casts.

### F7. Sharing metadata is represented in three client caches

- **Severity:** Medium
- **Category:** State management
- **Evidence:** Server metadata enters `sharedColumns`; replay effects create `sharedWithByColumn` and `publicLinksByColumn` overlays in [sync-context.tsx:385](/Users/lukasmurdock/Documents/GitHub/todoflare/src/contexts/sync-context.tsx:385); `useColumns` merges those at [useColumns.ts:269](/Users/lukasmurdock/Documents/GitHub/todoflare/src/hooks/useColumns.ts:269); then `ShareMenu` copies them again into `localSharedWith`, `localPublicId`, and `publicUrl` at [ShareMenu.tsx:36](/Users/lukasmurdock/Documents/GitHub/todoflare/src/components/column/ShareMenu.tsx:36).
- **Current developer cost:** A share/public-link change touches executor effects, context overlays, projection merging, component synchronization, and E2E behavior.
- **Conflict with velocity tenets:** The same server state is manually synchronized at three levels.
- **Recommended improvement:** Keep exactly one optimistic metadata projection in the synchronization layer. `ShareMenu` should render `columnMeta` directly and own only form, pending, error, and clipboard state. Derive public URL from `publicId`.
- **Expected benefit:** Removes synchronization effects and makes replay outcomes visible through one state path.
- **Implementation effort:** Low–medium
- **Migration risk:** Medium because offline replay behavior must remain unchanged.
- **Confidence:** High
- **Suggested automated guardrail:** Component or browser tests for immediate share, queued share, replayed revoke, and public-link enable/disable using the same rendered projection.

### F8. React closure correctness is not automatically checked

- **Severity:** Medium
- **Category:** Automated guardrails
- **Evidence:** There is no lint command or lint dependency. `useColumns` reads `accountId` inside `removeColumn` but omits it from the dependency list at [useColumns.ts:159](/Users/lukasmurdock/Documents/GitHub/todoflare/src/hooks/useColumns.ts:159); the `columns` memo also reads it without listing it at line 269. The provider alone has approximately 40 callbacks and 12 effects.
- **Current developer cost:** Reviewers must manually audit closure dependencies in the most stateful part of the application.
- **Conflict with velocity tenets:** A cheap correctness rule is enforced only by convention.
- **Recommended improvement:** Add a narrowly scoped ESLint gate with TypeScript parsing and `react-hooks/rules-of-hooks` plus `react-hooks/exhaustive-deps`. Avoid a broad stylistic lint migration in the same increment.
- **Expected benefit:** Faster feedback for a recurring class of stale-state bugs.
- **Implementation effort:** Low–medium
- **Migration risk:** Low if existing findings are fixed rather than suppressed.
- **Confidence:** High
- **Suggested automated guardrail:** `pnpm lint:hooks`, included in `verify:checks`.

### F9. Small duplicated and dead surfaces obscure ownership

- **Severity:** Low
- **Category:** Competing paths, dead code
- **Evidence:** `useAccount` explicitly describes itself as a convenience wrapper over `useSyncContext` at [useAccount.ts:3](/Users/lukasmurdock/Documents/GitHub/todoflare/src/hooks/useAccount.ts:3), while other features consume the context directly. `generateId`, `CreateColumnResponse`, `ShareColumnRequest`, `AppType`, and `resetLocalFirstDbForTests` have no external consumers. The `todoflare-columns` key appears in three production modules, with separate parsing logic.
- **Current developer cost:** Small but recurring uncertainty about which API or constant owns account and guest-storage behavior.
- **Conflict with velocity tenets:** Pass-through and obsolete surfaces create second names without independent policy.
- **Recommended improvement:** Delete confirmed dead exports. Consolidate guest storage keys and parsing into the existing column-storage area. Decide whether `useAccount` is the domain-facing API or remove it after `SyncProvider` extraction; do not retain both indefinitely.
- **Expected benefit:** A smaller searchable API and one guest-storage owner.
- **Implementation effort:** Low
- **Migration risk:** Low
- **Confidence:** High for dead symbols and storage duplication; medium for removing `useAccount`.
- **Suggested automated guardrail:** Add a dead-export check only after the existing false-positive policy is understood; otherwise use `noUnusedLocals` for internal symbols and periodic review.

## 4. Representative workflow traces

### Account hydration — read-only workflow

- **Entry:** [sync-context.tsx:1193](/Users/lukasmurdock/Documents/GitHub/todoflare/src/contexts/sync-context.tsx:1193)
- **Path:** `fetchAccount` → `GET /api/account/:id` → account KV → shared-index KV → one DO `/meta` per shared column → persistence parsers → React account/shared/deleted state → IndexedDB snapshot → `useColumns` projection.
- **Files/layers:** About 6 core files.
- **Trust boundaries:** HTTP path, KV records, DO response, IndexedDB snapshot.
- **Authoritative schemas:** HTTP Zod schema; hand-written account/column/trash record parsers.
- **Invariant owner:** Split between route hydration reconciliation and `SyncProvider`.
- **Tests:** Route schema/reconciliation tests and offline snapshot E2E.
- **Unnecessary handoff:** Server result may overwrite newer local optimistic state without a request revision.

### Create column — optimistic write workflow

- **Entry:** [TodoApp.tsx:23](/Users/lukasmurdock/Documents/GitHub/todoflare/src/components/todo/TodoApp.tsx:23)
- **Path:** `TodoApp` → `useColumns.addColumn` → `SyncProvider.createColumn` → command contract → mutation queue → account-command executor → `POST /api/column` → DO `/meta`/`init` → account KV → replay effect/reconciliation → rendered projection.
- **Files/layers:** Approximately 8 production files plus 4 test files.
- **Trust boundaries:** Persisted outbox, HTTP body, KV account record, DO response.
- **Invariant owner:** Route currently owns “DO column plus owner order eventually converge.”
- **Tests:** Executor contract, queue FIFO/retry, route idempotency, first-keystroke E2E.
- **Unnecessary handoffs:** Queue results are cached by queue ID in the provider, then separately summarized into account state.

### Share/revoke — form and lifecycle workflow

- **Entry:** [ShareMenu.tsx:60](/Users/lukasmurdock/Documents/GitHub/todoflare/src/components/column/ShareMenu.tsx:60)
- **Path:** form validation → context operation → command queue → executor → validated route → named share/revoke workflow → DO authoritative `sharedWith` → KV discovery projection → executor effect → context overlay → `useColumns` → component-local cache.
- **Files/layers:** Approximately 9 production files.
- **Trust boundaries:** Form input, persisted command, HTTP, target account KV, DO metadata.
- **Invariant owner:** Named server workflows correctly own write ordering and repair.
- **Tests:** Boundary-by-boundary failure injection, route authorization, queue replay, sharing E2E.
- **Unnecessary handoffs:** Three client representations; duplicated normalization; current gate failure.

### Delete and restore — lifecycle-sensitive workflow

- **Entry:** `useColumns.removeColumn` or garbage-can UI.
- **Path:** optimistic state → queued command → executor → idempotent route → named `deleteColumn`/`restoreColumn` workflow → owner KV, shared indexes, public mapping, DO metadata, trash → replay reconciliation.
- **Files/layers:** Approximately 8 production files.
- **Invariant owner:** [delete-column.ts](/Users/lukasmurdock/Documents/GitHub/todoflare/src/server/workflows/delete-column.ts:37) and [restore-column.ts](/Users/lukasmurdock/Documents/GitHub/todoflare/src/server/workflows/restore-column.ts:31).
- **Tests:** Strong failure-injection coverage at every declared write boundary and browser replay coverage.
- **Assessment:** This is the best example of the intended paved road. The workflow abstraction owns meaningful policy and should be retained.

### Scheduled purge — background workflow

- **Entry:** [index.tsx:2135](/Users/lukasmurdock/Documents/GitHub/todoflare/src/index.tsx:2135)
- **Path:** Cloudflare scheduled event → `purgeExpiredTrashedColumns` → account enumeration → trash parser → DO deletion → trash projection update.
- **Trust boundaries:** Cron invocation, KV records, DO response.
- **Invariant owner:** Named purge workflow.
- **Tests:** Successful deletion, non-OK retry, thrown failures, partial batches.
- **Assessment:** Cohesive and appropriately direct.

### Public read-only loading — browser-facing workflow

- **Entry:** [client.tsx:18](/Users/lukasmurdock/Documents/GitHub/todoflare/src/client.tsx:18)
- **Path:** pathname match → `PublicView` → `usePublicColumnSync` → `/api/p/:publicId/ws` → public KV mapping → DO validates public ID → initial Yjs state → static editor projection.
- **Files/layers:** About 5 production files.
- **Trust boundaries:** URL public ID and WebSocket upgrade.
- **Invariant owner:** DO public ID validation.
- **Tests:** Public-link browser journey and Worker upgrade routing.
- **Justified exception:** Separate from account `SyncProvider` because it intentionally excludes account state, queues, and editable collaboration.

### Agent snapshot — recently added read workflow

- **Entry:** [agent-api.ts:414](/Users/lukasmurdock/Documents/GitHub/todoflare/src/agent-api.ts:414)
- **Path:** OpenAPI route validation → account KV → DO `/export` → column parser → capability calculation → Yjs-to-markdown projection.
- **Trust boundaries:** Versioned HTTP API, persisted account, DO export.
- **Tests:** OpenAPI presence, authorization, invalid schemas, snapshot shape.
- **Unnecessary duplication:** Agent capability calculation and `ColumnMeta` schema are separate from the normal API’s semantics.

## 5. Prioritized improvement plan

| Rank | Improvement                                                    | Developer impact | Cognitive reduction | Change-surface reduction | Correctness | Effort      | Migration risk |
| ---: | -------------------------------------------------------------- | ---------------- | ------------------- | ------------------------ | ----------- | ----------- | -------------- |
|    1 | Fix hydration race and restore `pnpm verify`                   | High             | Medium              | Medium                   | High        | Medium      | Medium         |
|    2 | Centralize account/column access semantics                     | High             | High                | High                     | High        | Low–medium  | Low            |
|    3 | Extract and test import/backup workflows                       | Medium           | High                | High                     | High        | Medium      | Medium–high    |
|    4 | Add focused React Hooks linting                                | High             | Medium              | Low                      | High        | Low–medium  | Low            |
|    5 | Consolidate persisted runtime schemas and shared-index parsing | Medium           | High                | High                     | High        | Medium      | Medium         |
|    6 | Reduce sharing state to one client projection                  | Medium           | Medium              | High                     | Medium      | Low–medium  | Medium         |
|    7 | Extract cohesive sections from `SyncProvider`                  | High             | High                | Medium                   | Medium      | Medium–high | Medium         |
|    8 | Define the raw-Hono versus OpenAPI boundary                    | Medium           | Medium              | Medium                   | Medium      | Low–medium  | Low            |
|    9 | Remove dead exports and duplicated storage constants           | Low              | Low                 | Low                      | Low         | Low         | Low            |

### Immediate removals and consolidations

- Delete confirmed dead exports and the duplicate `SyncMode` declaration.
- Remove `ShareMenu`’s copied metadata after the single optimistic projection is established.
- Consolidate guest storage constants and parsing.
- Remove the duplicate server `AccountExportPayload`.

### Guardrails that prevent new divergence

- React Hooks linting.
- Normalized-ID access tests.
- Shared runtime parser tests.
- No-`any` guard for route handlers.
- Failure injection for every recovery write boundary.

### Focused workflow simplifications

- Monotonic account hydration.
- Shared access predicates.
- Named snapshot clone/restore workflows.
- Cohesive extraction from `SyncProvider` without changing its external context API.

### Verification-speed improvements

No broad speed project is justified now:

- Checks already complete in 8.78 seconds.
- Build is 1.42 seconds.
- Browser coverage ran in 24.46 seconds before failing.
- Full verification already builds once and isolates state.

Fix correctness and determinism first. A second “fast default” browser path would create another competing gate without evidence of need.

### Larger staged migrations

- Shared runtime schemas for TypeScript, persistence, and OpenAPI.
- `SyncProvider` decomposition.
- IndexedDB migration strategy, only after the open product decision is resolved.

## 6. Proposed increments

### Increment 1 — Restore monotonic account convergence

- **Observable outcome:** Creating or sharing a column during account hydration cannot make it disappear; `pnpm verify` passes.
- **Scope:** Account fetch lifecycle and optimistic command reconciliation.
- **Likely areas:** `sync-context.tsx`, sharing E2E, possibly a new pure reconciliation module.
- **Behavior unchanged:** Offline startup, FIFO replay, optimistic creation, server-authoritative convergence.
- **Tests:** Delayed hydration race; existing sharing and offline suites.
- **Verification:** `pnpm test:e2e:run e2e/sharing.spec.ts e2e/column-init-race.spec.ts`, then `pnpm verify`.
- **Rollout:** Add the failing race test first, then use request generation/reconciliation.
- **Complete when:** The current failing test and new delayed-hydration test pass repeatedly, followed by a green full gate.
- **Dependencies:** None.

### Increment 2 — One account-access semantic

- **Observable outcome:** Formatted and normalized IDs behave identically for owner, collaborator, presence, and revocation decisions.
- **Scope:** Pure access predicates and callers.
- **Likely areas:** `lib/account.ts` or a small `lib/column-access.ts`, DO, agent API, workflows, Worker routes, `useColumns`.
- **Behavior unchanged:** Owners and current collaborators retain access; revoked users are disconnected.
- **Tests:** Normalized-session DO test; workflow and route authorization tables.
- **Verification:** `pnpm test:run -- test/column-room-sql.test.ts test/routes.test.ts test/column-lifecycle-workflows.test.ts`, then `pnpm verify:fast`.
- **Rollout:** Characterize existing intended cases before replacing conditionals.
- **Complete when:** All access decisions call shared predicates and raw account-ID membership comparisons are absent.
- **Dependencies:** None.

### Increment 3 — Add React lifecycle guardrails

- **Observable outcome:** Hook dependency errors fail locally and in CI.
- **Scope:** Focused ESLint setup and existing violations.
- **Likely areas:** `package.json`, lint config, `useColumns`, `sync-context`.
- **Behavior unchanged:** All UI and sync behavior.
- **Tests/checks:** `lint:hooks`.
- **Verification:** `pnpm lint:hooks && pnpm verify:fast`.
- **Rollout:** Enable only hooks rules initially; do not mix formatting cleanup into this increment.
- **Complete when:** No suppressions are needed for ordinary callbacks and `verify:checks` invokes the rule.
- **Dependencies:** Preferably Increment 1, so stale-state fixes are characterized first.

### Increment 4 — Establish authoritative persisted schemas

- **Observable outcome:** Accounts, column metadata, trash, shared indexes, and backup envelopes use one runtime definition per record.
- **Scope:** Persistence boundaries only.
- **Likely areas:** `persistence-records.ts`, shared schema module, `agent-api.ts`, `column-room.ts`, lifecycle workflows.
- **Behavior unchanged:** Current version-1 records remain readable.
- **Tests:** Valid v1 fixtures and malformed field/ID/array/version tables.
- **Verification:** `pnpm test:run -- test/routes.test.ts test/column-room-sql.test.ts test/column-lifecycle-workflows.test.ts && pnpm typecheck`.
- **Rollout:** Parse existing records permissively only where an explicit compatibility case is documented; report corrupt projections rather than crashing.
- **Complete when:** No production `JSON.parse(sharedColumnsData) as string[]` remains.
- **Dependencies:** Increment 2, so ID semantics are available to parsers.

### Increment 5 — Name and protect snapshot cloning/restoration

- **Observable outcome:** Account import and backup restore commit projections only after verified DO writes and repair cleanly after partial failure.
- **Scope:** Recovery workflows, not general route refactoring.
- **Likely areas:** New named workflow files, the import and backup route sections of `index.tsx`, integration tests.
- **Behavior unchanged:** Clone remains the safe default; in-place restore still creates a pre-restore backup.
- **Tests:** Failure injection for R2 read, checksum, pre-backup, DO init/import, owner KV, shared KV, and public KV.
- **Verification:** Focused Workers tests, `pnpm verify:fast`, then one successful browser/API smoke if UI import is exercised.
- **Rollout:** Extract clone first, then in-place restore, then account-wide restore.
- **Complete when:** Route handlers only validate/authenticate/shape responses and all recovery write boundaries have retry tests.
- **Dependencies:** Increment 4.

### Increment 6 — Collapse sharing metadata to one client projection

- **Observable outcome:** `ShareMenu` renders synchronized metadata directly and owns no copy of `sharedWith` or `publicId`.
- **Scope:** Sharing/public-link client state only.
- **Likely areas:** `ShareMenu`, `useColumns`, command-effect reconciliation.
- **Behavior unchanged:** Immediate online feedback and queued offline replay.
- **Tests:** Online share/revoke, offline share/revoke, public enable/disable.
- **Verification:** Relevant sharing/outage Playwright tests, then `pnpm verify`.
- **Rollout:** First ensure replay effects update the authoritative projection; then remove component-local copies.
- **Complete when:** No “sync props into local metadata state” effect remains.
- **Dependencies:** Increment 1.

### Increment 7 — Decompose `SyncProvider` by cohesive workflow

- **Observable outcome:** UI consumers retain the same context API, while hydration, metadata replay, and column connection lifecycle can each be understood independently.
- **Scope:** Internal extraction only.
- **Likely areas:** `sync-context.tsx` and existing `lib/sync` modules.
- **Behavior unchanged:** All five sync modes, queue persistence, access-loss behavior, reconnection, telemetry.
- **Tests:** Existing pure tests plus race and connection lifecycle characterization.
- **Verification:** `pnpm verify`.
- **Rollout:** Extract one responsibility per change, starting with pure hydration/reconciliation, then connections; delete old code in the same increment.
- **Complete when:** `SyncProvider` is primarily composition and context assembly, without introducing a generic `SyncRuntime` facade.
- **Dependencies:** Increments 1–3.

## 7. Exceptions and unresolved questions

### Existing justified exceptions

- **Public read-only synchronization:** Its separate hook is justified because it intentionally avoids account queues, editable presence, and authenticated state.
- **Named lifecycle workflows:** These are not repository/service ceremony; they own write ordering, idempotent repair, authorization, and failure-injection boundaries.
- **OpenAPI agent routes:** A separate route style is justified if the versioned agent API is a real external contract. It should remain narrow and explicitly documented.
- **HTTP status fallback:** Justified for compatibility with older deployments. Remove only when the oldest supported client/server combination cannot emit uncoded failures.
- **Direct DO `fetch` calls:** Appropriate for the chosen Cloudflare stack. A generic repository around them would add ceremony.

### Exceptions lacking evidence

- The agent API is versioned and documented, but [PLAN.md:128](/Users/lukasmurdock/Documents/GitHub/todoflare/PLAN.md:128) still lists separate contract versioning as an open decision. Resolve whether OpenAPI stability is a supported external promise.
- Keeping both `useAccount` and direct `useSyncContext` consumption has no documented selection rule.
- The “Regenerate” public-link UI calls an idempotent enable operation that intentionally reuses the existing public ID; the product meaning is unclear.

### Measurements or investigation still needed

- Instrument the failing sharing journey to prove whether stale hydration is the exact overwrite source.
- Test production-normalized WebSocket IDs before estimating the user impact of the revocation mismatch.
- Inspect real persisted shared-index and IndexedDB records before enforcing stricter parsing.
- Measure IndexedDB collection size/write frequency before replacing the whole-collection `PersistedMap` strategy.

### Intentionally deferred

- Replacing the custom IndexedDB store with RxDB, TanStack DB, or another state library.
- Introducing a generic repository, service facade, dependency-injection container, or `SyncRuntime`.
- Splitting the browser bundle solely because Vite reports a 500 kB warning; the build is already fast and no product latency measurement was provided.
- Increasing E2E parallelism; the current browser run is short, and deterministic state matters more.
- Migrating all browser APIs to OpenAPI for architectural symmetry.
- Adding endpoint-per-component data loading or another client cache.
