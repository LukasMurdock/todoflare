# 0002: One SQLite Durable Object and Yjs document per column

Status: Accepted. Date: 2026-07-19. Source: [history/PLAN.md](../history/PLAN.md).

## Context

Collaborative columns need a single serialization point for updates, a
WebSocket room, and durable storage, without a separate database server.
Sharing and public links are per column.

## Decision

Each column is one `ColumnRoomSql` Durable Object (SQLite-backed). It stores
the Yjs snapshot and update log, the column's metadata (owner, collaborators,
public ID, lifecycle), WebSocket tickets, received-outbox digests and the
agent change log, and relays content and presence over hibernatable sockets.

## Consequences

- Access checks for a column happen in the same object, and the same
  transaction, as writes to it, including agent writes.
- Cross-column operations (account order, sharing indexes) live elsewhere and
  must be reconciled (see [0005](0005-metadata-authority-by-domain.md),
  [0008](0008-named-workflows-for-multi-store-writes.md)).
- The legacy `ColumnRoom` and a second private sync client were
  removed; there is one authenticated client path.
