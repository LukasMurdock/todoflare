# 0001: Local-first, with separate planes for metadata and content

Status: Accepted. Date: 2026-07-19. Source: [history/PLAN.md](../history/PLAN.md).

## Context

The app must accept edits offline and never lose them, including across
reloads and multiple tabs. Two kinds of state behave very differently:
column content is concurrently edited text, while metadata (create, order,
share, public link, delete, restore) is a set of operations the server must
authorize and that can be refused.

## Decision

Keep two planes with different conflict models:

- **Content**: Yjs documents. Concurrent edits merge; there is no "rejection".
  Updates go through a durable Yjs outbox until the server acknowledges them.
- **Metadata**: typed commands in one durable FIFO queue, each with an
  idempotency key. The server stays authoritative; the client shows
  server state plus pending commands.

Presence is a third, ephemeral plane that is never replayed.

## Consequences

- One command table (`src/lib/api/account-commands.ts`) drives the outbox
  parser, executor and server routes.
- A refused command must have an explicit, typed outcome (see
  [0007](0007-stable-error-codes-drive-replay.md)); content never does.
- Guest mode is a separate, simpler path (localStorage), not a degraded
  account mode.
