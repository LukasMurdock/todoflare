# 0007: Stable error codes, not HTTP status, decide replay

Status: Accepted. Date: 2026-07-19. Source: [history/PLAN.md](../history/PLAN.md).

## Context

A queued command can fail permanently (the column is gone, access was
revoked) or temporarily (rate limit, read-only mode, a DO unavailable). A
generic 403 or 404 does not say which, and mistaking a transient failure for
revocation would delete a user's queued work.

## Decision

Server errors carry a stable `code` (`src/lib/api/errors.ts`), and
`src/lib/sync/replay-response.ts` maps codes to outcomes: drop with a typed
reason, pause for authentication, or retry with backoff. Status-only
mapping remains only for older deployments.

## Consequences

- Adding a server error means choosing its replay outcome.
- Only `access_revoked` triggers the column-wide local discard.
