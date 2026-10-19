# Todoflare

A local-first, collaborative todo board of rich-text columns. It works in one
browser with no account; sign in with a passkey to sync across devices, edit
together in real time, share read-only public links, recover deleted columns,
and let AI agents read or edit the columns you choose.

## Design goals

- **Never lose an edit.** Edits are accepted instantly and kept durably in
  the browser, even offline, until the server acknowledges them
  ([0001](docs/decisions/0001-local-first-two-state-planes.md)).
- **Collaborate without conflicts.** Each column is a Yjs document with one
  Durable Object as its authority
  ([0002](docs/decisions/0002-one-durable-object-per-column.md)).
- **No passwords, no email.** Passkeys authenticate; the Account ID you share
  with people is public ([0003](docs/decisions/0003-passkeys-and-public-account-ids.md)).
- **Agents get exactly what you grant.** Per-column access levels, enforced by
  the server rather than by the agent behaving
  ([0010](docs/decisions/0010-agent-access-model.md)).
- **Recoverable.** Hourly backups, a 30-day trash, and releases that verify
  production data before reopening writes
  ([0013](docs/decisions/0013-frozen-release-verification.md)).

## System at a glance

```text
Browser (React SPA, Plate + Yjs editor)
  ├─ guest: localStorage
  └─ signed in: IndexedDB snapshot + durable outboxes
        │  HTTPS metadata commands      │  WebSocket Yjs updates
        ▼                               ▼
Cloudflare Worker (Hono) ──► one Durable Object per column (content + access)
        ├─► D1: Better Auth passkeys and sessions, agent grants, OAuth
        ├─► KV: account order, trash, sharing indexes
        └─► R2: hourly backups
MCP clients (Claude, ChatGPT, …) ──► /api/mcp with OAuth or a personal token
```

## Start here

- [Architecture](docs/architecture.md): the map, runtime flows and invariants
- [Domain](docs/domain.md): what the terms mean
- [Development](docs/development.md): run, test, debug, common changes
- [Decisions](docs/decisions/): why it is built this way
- [Operations](docs/operations.md): releases, read-only mode, backups, restore
- [All docs](docs/README.md)

## Quick start

Requires Node 24 and pnpm 12.

```bash
pnpm install
pnpm auth:migrate:local
pnpm dev            # http://localhost:5173, Worker and storage run locally
pnpm verify:fast    # checks, typecheck, unit/Worker tests, build
pnpm verify         # the full gate CI runs: adds Playwright and host tests
```

## Connecting an agent

Signed in, open **Account menu → Agents** and follow the steps for your app.
Claude.ai, ChatGPT and other OAuth clients add
`https://todo.tamesystems.org/api/mcp` as a connector and choose columns on a
consent page; Claude Code uses a personal token from the dialog. Access can be
changed or revoked at any time, and agent edits can be undone from the
column's agent menu. See [agent access](docs/proposals/agent-access.md).

## Deployment

Production is https://todo.tamesystems.org and staging is
https://staging.todo.tamesystems.org. Every production release deploys
read-only first and reopens writes only after verifying the exact build
against fresh data snapshots; see [operations](docs/operations.md#releasing).
