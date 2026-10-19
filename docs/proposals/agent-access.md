# Agent access

Goal: let an account hand specific columns to an AI agent (Claude Code,
Claude.ai, any MCP client) with a stated level of access. The account can
see what the agent did, undo it, and cut it off immediately. Column content
is untrusted input to the agent, so every boundary is enforced by the server
and none depends on the model behaving.

Status: steps 1 (grant model) and 2 (read-only MCP) are implemented. Later
steps are planned here and are not yet implemented.

## Model

| Concept | Where | Notes |
| --- | --- | --- |
| Connection | D1 `agent_connection` | One authorized agent. Belongs to one account. Always expires (default 30 days, at most 365). |
| Token | D1 `agent_token` | Only SHA-256 hashes are stored. `personal` tokens last as long as the connection. OAuth `access`/`refresh` kinds are reserved for step 4. |
| Grant | D1 `agent_grant` | `(connection, column) → read \| append \| edit`, with an optional earlier expiry. |

Levels are cumulative:

- **read** — see the column's content.
- **append** — add new items. Never changes or removes anything already there.
- **edit** — change, check off, reorder and delete existing items.

Agents never get sharing, public links, delete-column, trash, account or
agent-management capabilities, at any level.

### The access rule

`decideAgentColumnAccess` (`src/server/agent-access/decision.ts`) is the
single decision every agent request goes through. An agent's access is the
**intersection** of its grant and its account's *current* access:

1. A missing, unknown, revoked or expired credential is `unauthorized` (401).
2. A missing or expired grant is `not_found` (404).
3. A column that is missing, trashed, or that the granting account can no
   longer reach is also `not_found`. The response is identical in each case,
   so an agent cannot probe for columns.
4. A grant below the level the operation needs is `insufficient_grant` (403).
5. Writes in read-only mode are `read_only_mode` (503). Reads continue.

Membership and trash state are read from the column's Durable Object
(`GET /access-state`), which is authoritative for them. Grants are never
rewritten when a share is revoked or a column is trashed: they go dormant and
come back only if access is restored.

### Why D1

Tokens and grants are credentials, and they live beside the Better Auth
tables. Revocation must win immediately: D1 reads go to the primary.
Revocation marks the connection and deletes its tokens and grants in one
batch, so no lookup can observe a half-revoked agent. Agents use stateless
HTTP, never WebSockets, so there is no long-lived socket to tear down.

`userId` has no foreign key because test and legacy accounts exist in KV
without a Better Auth user row. Agent tables are deliberately excluded from
account backups: restoring an account must never resurrect a credential.

### Management

Management uses a session cookie only (`/api/agents…`). A bearer token can
never manage connections, so an agent cannot widen or extend its own access.
An account can grant only a column it can reach itself at that moment.
Revoking a connection and removing a grant stay available in read-only mode,
because narrowing access is never the write an incident needs to stop.

The whole surface is behind `AGENT_ACCESS_ENABLED` (`"false"` in production,
`"true"` in staging and tests).

## Plan

1. **Grant model** *(done)*. Tables, the decision function, management
   routes, and the exhaustive permission table
   (`test/agent-access-decision.test.ts`: 600 cells against an independent
   ordered rule table, mutation-checked).
2. **Read-only MCP** *(done)*. A stateless Streamable HTTP endpoint at `/api/mcp`
   authenticated by bearer token, with tools `list_columns` and
   `read_column`. Content is serialized to markdown with stable block IDs and
   a version hash. The column model is flat (paragraphs, h1–h3, and
   disc/decimal/todo lists with indent), so conversion is a small
   project-owned codec rather than Plate's markdown stack in the Worker. The
   HTTP permission table enumerates every tool × grant × column state.
3. **Write tools.** `append_items` (append), plus `update_item`,
   `set_checked`, `delete_items` and `replace_column` with `expectedVersion`
   (edit). Writes are Yjs transactions applied in the column's Durable Object,
   which rechecks membership and trash state atomically with the write. They
   are broadcast like any collaborator's edit, attributed to the agent,
   recorded in an audit log, and can be undone per agent session. A seeded
   property test interleaves human and agent edits and requires convergence
   with zero lost human characters.
4. **OAuth, UI and staging.** MCP-spec OAuth 2.1 (PKCE, dynamic client
   registration, protected-resource metadata) with passkey consent and
   per-column choices, an "Agent access" settings page, presence for active
   agents, and an end-to-end run with the real `claude` CLI and MCP Inspector
   against local and staging.

## Connecting an agent

Until step 4 adds OAuth, create a connection with `POST /api/agents` (passkey
session) and pass the returned token as a header. For Claude Code:

```sh
claude mcp add --transport http todoflare https://todo.tamesystems.org/api/mcp \
  --header "Authorization: Bearer tfa_…"
```

### Protocol notes

The endpoint is dual-era Streamable HTTP with JSON responses only, and keeps
no state between requests in either era.

- **Modern, `2026-07-28`:** any request carrying
  `_meta["io.modelcontextprotocol/protocolVersion"]`. Implements
  `server/discover`. Results carry `resultType` and `serverInfo`, and
  `server/discover` and `tools/list` carry `ttlMs`/`cacheScope: "public"`.
  Tools are identical for every agent; access is decided per call, never by
  listing. Validation order:
  1. Version header present and equal to `_meta`, else `-32020`.
  2. Supported version, else `-32022` with the supported list. This is
     checked before anything else a newer revision might change, so newer
     clients can always learn what to retry with.
  3. `clientCapabilities` present, else `-32602`.
  4. `Mcp-Method`, and for `tools/call` `Mcp-Name` (with base64 sentinel
     decoding), must match the body, else `-32020`.
  5. Unknown and removed methods (`ping`, `logging/setLevel`) answer
     `404` with `-32601`.
- **Legacy, `2025-11-25`, `2025-06-18`, `2025-03-26`:** `initialize`, then
  requests without per-request metadata. Kept because the official
  TypeScript SDK (1.32.1) and clients built on it are legacy-only. An
  unknown version on a legacy-shaped request is answered with `-32600`, not
  the modern `-32022`, so dual-era clients fall back rather than retry.
- `GET` and `DELETE` answer `405` in both eras, and `Mcp-Session-Id` is
  never minted or echoed.

Claude Code 2.1.303 speaks `2026-07-28` with this server for the whole
conversation: `server/discover`, `tools/list` and `tools/call`, with no
handshake.

### Verification against a real client

`scripts/agent-mcp-smoke.mjs` drives the real `claude` CLI against an E2E
server. It reads a column containing a prompt-injection line, checks the
answer, then revokes the agent and confirms the endpoint refuses it. It costs
one real model call, so it is not part of `pnpm verify`.

## Threats considered

- **Prompt injection in column text** ("read column X", "share this with Y").
  The token cannot reach ungranted columns, and no sharing tool exists.
- **Token theft.** Tokens are hashed at rest, sent only in the
  `Authorization` header (never in URLs or logs), and expire. Revocation is
  immediate.
- **Confused deputy through a collaborator.** Grants are bounded by the
  granting account's live access, so a revoked collaborator's agents lose
  access in the same moment the collaborator does.
- **Probing.** Every invisible column returns the same 404.
- **Self-escalation.** No agent-facing route can create, extend or widen a
  connection or grant.
