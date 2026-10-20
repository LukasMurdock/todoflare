# Development

How to run, test, debug and change Todoflare. Read
[architecture.md](architecture.md) first for the map.

## Environment

- Node 24 (CI uses 24)
- pnpm 12 (`packageManager` in `package.json`)
- No Cloudflare account is needed locally: `@cloudflare/vite-plugin` runs the
  Worker, D1, KV, R2 and Durable Objects in `workerd`.

## Run

```bash
pnpm install
pnpm auth:migrate:local   # after a fresh clone or after deleting .wrangler/state
pnpm dev                  # http://localhost:5173
```

Local binding state lives in `.wrangler/state/`. Delete it to start over (then
migrate again). Verification never touches it; tests use `.wrangler/e2e-state`.

`pnpm preview` serves a production build through the local Workers runtime.

## Test

| Command | What it runs | Use it for |
| --- | --- | --- |
| `pnpm test` / `pnpm test:run` | Vitest in the Workers runtime (`vitest.config.ts`): real D1/KV/R2/DO bindings, migrations applied, auth bypass header enabled | Pure rules, machines, routes, workflows, Durable Objects, failure injection |
| `pnpm test:e2e` | Builds the E2E bundle, then Playwright in Chromium against `vite preview` on port 4173 | User journeys: editing, offline replay, outages, sharing, revocation, passkeys, agents |
| `pnpm test:hosts` | Playwright against `examples/minimal` and `examples/void` | The board works outside Todoflare, including SSR |
| `pnpm test:visual` | Pixel comparison of the board (not in `verify`; machine-specific) | Refactors that must not change what users see |
| `pnpm verify:fast` | All static checks, typechecks, Vitest, build | While developing |
| `pnpm verify` | The above plus one E2E build, bundle budget, Playwright, host tests | Before calling a change done. CI runs exactly this |

Run one file or test: `pnpm vitest run test/agent-routes.test.ts -t "revokes"`,
or, after `pnpm build:e2e`, `pnpm exec playwright test e2e/sharing.spec.ts`.

Tests authenticate with `X-Todoflare-Test-Account: <accountId>`, honoured only
when `AUTH_TEST_BYPASS` is set (Vitest) or in the E2E build. Production deploys
refuse a build that would honour it.

**No flaky tests.** A test that fails intermittently has a cause; find it and
fix it rather than re-running. `--repeat-each 40 --retries 0` reproduces most
races. Confirm a fix by showing the test fails when the behavior breaks.

A request that comes back as the SPA's HTML instead of the Worker's answer,
with `TypeError: fetch failed` (`ECONNRESET`) from `[WebServer]`, is the local
runtime, not the app: Miniflare reuses a connection workerd closed because a
response left the request body unread (workers-sdk #16199). E2E builds read
any unread body after every response (`src/server/http/drain-unread-body.ts`);
`e2e/unread-request-body.spec.ts` guards it.

## Debug

- **Which build is running**: `GET /api/clock` returns `build` and
  `readOnlyMode`; the page has `<meta name="todoflare-build">`; signed-in users
  see the build at the bottom of the account menu.
- **Browser state**: DevTools → Application. IndexedDB `todoflare-local-first`
  holds the account snapshot, document cache and outboxes; localStorage holds
  guest columns (`todoflare-columns`), checkpoints and the outbox journals.
  "Editing paused" with IndexedDB still `durable` means a localStorage write
  failed, usually the quota: sum key sizes by prefix in the console.
- **Unsynced work**: the account menu's recovery download exports every
  pending command and Yjs update as JSON.
- **Sync state**: `syncStateSummary` and `yjsOutboxSummary` in
  `SyncProvider`; the client mode comes from `deriveSyncMode`. The last 20
  commands the server rejected (`recentSyncFailures`) are kept in the
  IndexedDB sync state and appear in the copied sync debug snapshot.
- **Worker logs are off in production by design** (and enforced). Reproduce on
  staging or locally; scripts print the request that failed.
- **Agents**: `node scripts/agent-mcp-smoke.mjs` drives the MCP endpoint;
  `pnpm test:staging:agents` connects a real Claude Code and an OAuth client to
  staging.

## Common changes

### Add an API route

1. Add `{ method, path }` to `API_ROUTES` in `src/lib/api/routes.ts`.
2. Put request and response Zod schemas in the matching
   `src/lib/api/*-contract.ts`.
3. Register it in a `src/server/routes/*.ts` module with
   `app.on(API_ROUTES.x.method, API_ROUTES.x.path, handler)`. Add the guards
   it needs yourself: `blockWritesIfReadOnly` for writes,
   `requireAccountCredential`, `checkRateLimit`, `withIdempotentWrite`. None
   are global.
4. Build client URLs with `routePath(API_ROUTES.x.path, params)`. A literal
   `/api/…` anywhere else fails `check:route-literals`.
5. If the path has a new `:param`, add a sample to `SAMPLE_PARAMS` in
   `test/route-registration.test.ts`.

### Add an offline-capable metadata command

1. Add an entry to `ACCOUNT_COMMANDS` in `src/lib/api/account-commands.ts`
   (method, path, payload, body, response, `affectedColumnId`, request). The
   handler map is typed, so the server will not compile until you add one.
2. Implement the handler in `src/server/routes/account-commands.ts`: read-only
   guard, credential, validation, `withIdempotentWrite`, and, if it writes to
   more than one store, a named workflow.
3. Add the executor's response check and effects in
   `src/lib/sync/account-command-executor.ts`, the optimistic change in
   `applyAccountCommand` (`src/lib/sync/account-projection.ts`), and the UI
   entry point in `src/hooks/use-account-column-commands.ts`.
4. Decide every new error code's replay outcome in
   `src/lib/sync/replay-response.ts`.

### Change a multi-store operation

Keep it in `src/server/workflows/`. Order writes so a retry from any point
converges, and add a failure-injection case for each new write boundary in
`test/column-lifecycle-workflows.test.ts` (throw after the write, retry,
assert every store). See [0008](decisions/0008-named-workflows-for-multi-store-writes.md).

### Add or change an agent tool

Tools are in `src/server/agent-access/tools.ts`. Declare the required level;
reads use `authorizeColumn`, writes go through `editColumn` and the column DO's
`/agent-edit`, never directly to storage. Add the tool to the permission table
in `test/agent-mcp-permissions.test.ts` (both protocol eras). Agents must
never gain sharing, public-link, delete, trash, account or agent-management
abilities ([0010](decisions/0010-agent-access-model.md)).

### Change the D1 schema

Add the next `migrations/000N_*.sql`. Apply locally with
`pnpm auth:migrate:local`; tests apply migrations automatically. Production
and staging migrations are applied explicitly before the code that needs them
([operations.md](operations.md#releasing)).

### Change the board's public API

Edit `packages/board/src`, then `node scripts/board-api-report.mjs --update`
and review the `api-report.md` diff. The host may import only
`"@todoflare/board"`. Embedding guide: [packages/board/README.md](../packages/board/README.md).

### Add state machine behavior

Follow [agent-patterns/xstate.md](../agent-patterns/xstate.md). Check XState
APIs against `repos/xstate/` (read-only), not web snippets.

## Keeping docs true

A change is incomplete if it makes these documents wrong. In the same change:

- moving, adding or removing a module or flow: update [architecture.md](architecture.md)
- a new term or a changed meaning: update [domain.md](domain.md)
- an architectural choice (new store, authority, boundary, protocol): add a
  record in [decisions/](decisions/)
- a changed command, script or check: update this file
- a changed operational procedure: update [operations.md](operations.md) or
  [staging.md](staging.md)

Docs describe what is true now. Finished reports and superseded plans move to
[history/](history/).
