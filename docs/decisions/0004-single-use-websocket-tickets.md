# 0004: Single-use tickets for authenticated WebSockets

Status: Accepted. Source: [history/PLAN.md](../history/PLAN.md), [proposals/passkey-authentication.md](../proposals/passkey-authentication.md).

## Context

Browsers cannot set headers on a WebSocket upgrade, and URLs leak into logs,
history and referrers. Neither the session cookie nor the Account ID may
appear in a URL.

## Decision

A cookie-authenticated `POST /api/column/:id/ws-ticket` asks the column's DO
for a ticket: 32 random bytes, stored only as a SHA-256 hash, valid for 45
seconds. The upgrade URL carries only the ticket. The DO deletes the ticket
row on first use, valid or not, then checks expiry and access.

## Consequences

- Each reconnect needs a fresh ticket, so a revoked collaborator cannot
  reconnect.
- `check:sensitive-url-observability` forbids account IDs in URLs and keeps
  Worker logs off.
