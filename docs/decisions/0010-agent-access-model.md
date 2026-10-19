# 0010: Agent access: grants in D1, bounded by the account's live access

Status: Accepted. Date: 2026-10-19. Source: [proposals/agent-access.md](../proposals/agent-access.md).

## Context

People want AI agents to read or edit chosen columns. Column text is
untrusted input to the model ("share this with…"), so no limit may depend on
the model behaving. Collaborators can lose access at any time.

## Decision

- An agent connection belongs to one account and always expires. Grants are
  per column at a cumulative level: read, append, edit.
- Access is the **intersection** of the grant and the granting account's
  current access, checked on every request; a lost share makes grants
  dormant, not rewritten. Missing, trashed, ungranted and unreachable columns
  all return the same not-found.
- Tokens and grants live in D1 beside the auth tables: they are credentials,
  revocation must be immediate, and revoke is one batch.
- Agent tables are excluded from backups, so a restore never resurrects a
  credential.
- No agent-facing route can share, publish, delete, touch trash or manage
  agents; management takes a session cookie only.

## Consequences

- Agents use stateless HTTP (MCP at `/api/mcp`), never WebSockets.
- Narrowing access (revoke, remove grant) stays allowed in read-only mode.
- After an account restore, agents must be reconnected.
