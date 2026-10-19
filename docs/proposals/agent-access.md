# Agent access

Goal: let an account hand specific columns to an AI agent (Claude Code,
Claude.ai, any MCP client) with a stated level of access. The account can
see what the agent did, undo it, and cut it off immediately. Column content
is untrusted input to the agent, so every boundary is enforced by the server
and none depends on the model behaving.

Status: all four steps are implemented. Agent access is on in staging and
production (`AGENT_ACCESS_ENABLED`); see [Production](#production).

## Model

| Concept | Where | Notes |
| --- | --- | --- |
| Connection | D1 `agent_connection` | One authorized agent. Belongs to one account. Always expires (default 30 days, at most 365). |
| Token | D1 `agent_token` | Only SHA-256 hashes are stored. `personal` tokens last as long as the connection; OAuth `access` tokens last 1 hour and `refresh` tokens rotate (see [OAuth](#oauth)). |
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

The whole surface is behind `AGENT_ACCESS_ENABLED` (`"true"` in production,
staging and tests). Setting it to `"false"` turns every agent route into a 404
without touching stored grants.

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
3. **Write tools** *(done)*. See [Writes](#writes).
4. **OAuth and UI** *(done)*. See [OAuth](#oauth) and [UI](#ui).

## Writes

| Tool | Level | Notes |
| --- | --- | --- |
| `append_items` | append | At the end (above trailing blank lines) or after an item. Never alters existing items. |
| `set_checked` | edit | |
| `update_item` | edit | Text via `find`/`replaceWith`, or whole `text` with `expectedText`. |
| `delete_items` | edit | Requires the column `expectedVersion`. |
| `replace_column` | edit | Requires `expectedVersion`. Pass an item's `id` to keep its identity. |
| `undo_change` | the change's own level | Only the agent's own changes. |

Every edit is a Yjs transaction, built exactly as the editor's slate-yjs
binding would, so it merges with concurrent typing. The column's Durable
Object:

1. Rechecks membership and trash. It is authoritative for both, so this
   holds even if the Worker's check were bypassed.
2. Computes the edit on a scratch copy of the document.
3. Persists the update and its change record in one SQL transaction.
4. Only then applies the update to the live document and broadcasts it to
   connected people.

None of this yields, so no WebSocket message can interleave between an
`expectedVersion` check and its write. This is also why the content version
is a synchronous hash: an `await` inside the object would let other events
in.

**No silent overwrites.** Text edits are either an exact span replacement on
the current text (`find`/`replaceWith`, which rebases onto concurrent edits)
or a whole-text write that states what it read (`expectedText`). A
whole-text write against a stale read is refused, not applied. This was
found by an end-to-end test: an earlier "set the text to X" deleted a
person's words typed after the agent's read. Only the changed span is ever
rewritten, so the person's own characters, not copies of them, survive.

**Change log and undo.** Each change is recorded in the column
(`agent_changes`: who, which agent, tool, summary, items; kept 30 days, at
most 1000, pruned whenever a change is recorded and when the column compacts;
listing returns the newest 200). Any member can list changes (`GET /api/column/:id/agent-changes`)
and undo them (`POST …/:changeId/undo`). Agents can undo their own changes.
Undo is **compare-and-revert**: it reverts a field or item only while it
still holds what the agent wrote, and reports what it kept because a person
changed it since. True Yjs undo is not durable, because garbage collection
discards deleted content once the object reloads. A blind snapshot rollback
would erase later human work. Undo can only see what the server has
received: an edit a person has made but not yet synced can still be lost if
an undo removes the item it is in.

**Verified by:**

- A seeded property test (`test/agent-edit-convergence.test.ts`): 10,000
  runs of two people and an agent editing one column, with out-of-order
  delivery. It requires convergence, and that every character a person typed
  survives *as their own character*, not a copy, unless they deleted it or
  an agent deliberately removed its item. Nothing a person deleted may
  reappear. Coverage counters assert the runs reach undos that keep human
  work, rewrites during concurrent typing, stale-read writes, and
  out-of-order delivery. Mutation-checked:
  - a whole-text rewrite (deleted text reappears)
  - undo ignoring later edits
  - ignoring `expectedText`
- The end-to-end permission table, extended to `append_items` and
  `update_item` in both protocol eras.
- The real Claude Code smoke test, with edit access and every tool, against
  a column whose text instructs it to delete everything.

## OAuth

The Worker is its own OAuth 2.1 authorization server, built to the MCP
2026-07-28 authorization specification
(`src/server/oauth/authorization-server.ts`, `src/server/routes/oauth.ts`).

- **Discovery.** A 401 from `/api/mcp` carries
  `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/api/mcp"`.
  Protected Resource Metadata is also served at the root well-known path.
  Authorization server metadata (`/.well-known/oauth-authorization-server`)
  advertises:
  - S256 only
  - public clients only
  - `client_id_metadata_document_supported`
  - `authorization_response_iss_parameter_supported`

  All of `/.well-known/*` runs Worker-first. A narrower glob silently served
  the SPA for the path-suffixed document, which only the browser suite could
  see.
- **Clients.**
  - **Client ID Metadata Documents, preferred.** An HTTPS `client_id` with a
    path is fetched and cached for 10 minutes. The fetch never follows
    redirects, times out after 5 s and is capped at 5 KB. It never reaches
    loopback, private, link-local, single-label or `.local`/`.internal`
    hosts, or any IP literal. The document's `client_id` must equal its URL.
  - **Dynamic Client Registration, deprecated in the spec but widely used.**
    Rate limited per IP.
  - **Redirect URIs** must be HTTPS or loopback HTTP and are matched exactly,
    except that loopback ports may vary (RFC 8252).
- **Consent is the grant.** `/oauth/authorize` is a page in the app. It
  shows:
  - the client's name and whether it is verified (published at a metadata
    URL) or self-registered
  - the host you will be returned to, with a warning for localhost clients
  - a column list with a level for each, nothing selected by default

  Approval creates the connection and its grants. The page refuses to render
  in a frame, and `/oauth/*` is served with `frame-ancestors 'none'`. A
  request whose client or redirect cannot be trusted never redirects;
  anything else redirects back with `error`, `state` and `iss`.
- **Codes and tokens.**
  - Codes are single use and live 2 minutes. They are bound to client,
    redirect, PKCE challenge and resource (RFC 8707). A replayed code
    revokes the connection.
  - Access tokens (`tfa_…`) last 1 hour. Refresh tokens (`tfr_…`, never
    accepted by `/api/mcp`) rotate on each use, are bound to their client,
    and never outlive the connection.
  - An approval whose code is never redeemed is revoked when it expires.
  - Disconnecting a connection deletes all its tokens at once.

## UI

- **Account menu → Agents:** a guided, numbered setup per app (Claude Code,
  Claude.ai, another app or script)
  - token apps choose their columns *before* the token exists; creation
    grants them in the same request, so no connection starts with nothing
  - Claude Code gets one copyable `claude mcp add --scope user …` command
    (user scope, so it works in every folder), shown once
  - Claude.ai gets the address, a link to its connector settings and the
    remaining steps; the column choice happens on the consent page
  - every connection, with its columns and levels, last use and expiry
  - two-step disconnect
- **Each column:** an agent button (marked when an agent has access) with
  - per-agent access levels for that column
  - the column's recent agent changes, with undo; it reports what undo kept
    because someone edited it since
- **Lazy loading:** the dialog and the consent page load on demand. The
  board's initial JavaScript grows by 3.6 KiB gzip. Total client JS is
  418.4 KiB against a budget raised from 415 to 420 KiB.

Verified in the browser (`e2e/agents.spec.ts`):

- A person connects an agent with a token and grants read. The agent's write
  is refused; the person raises the level from the column; the agent's item
  appears live in the person's editor; the change is listed and undone; the
  person disconnects and the agent gets 401.
- A full OAuth flow: discovery from the 401, registration, consent with a
  chosen column and level, code and `iss` on the callback, token exchange,
  then exactly that grant on `list_columns`.
- Declining, and an untrustworthy request that never redirects.

`e2e/agents-oauth-sdk.spec.ts` runs the same flow with the **official MCP
SDK's OAuth client** doing discovery, registration, PKCE, token exchange and
refresh itself.

## Staging

Staging runs agent access (`AGENT_ACCESS_ENABLED=true`). Migrations 0003 and
0004 were applied there on 2026-10-19, and `reset-data` clears the agent and
OAuth tables along with the accounts they belong to.

`pnpm test:staging:agents` (`e2e/agents-staging.spec.ts`, excluded from
`pnpm verify`; one real model call) runs on the deployed HTTPS origin with a
real passkey session:

1. The person creates a token and grants edit in the Agents dialog.
2. The real `claude` CLI adds an item, which appears live in the person's
   editor.
3. The column popover lists the change, and undo removes it.
4. The official MCP SDK's OAuth client connects through discovery,
   registration and consent, gets exactly the chosen read level, and has a
   write refused.
5. Disconnecting both makes both tokens 401.

The staging recovery drill (`pnpm test:staging`) and `pnpm test:staging:auth`
also pass with agent access deployed.

## Production

Rolled out on 2026-10-19 through the standard [release procedure](../staging.md#release-procedure):
preflight snapshot (4 accounts, 16 documents), migrations 0003 and 0004
applied to `todoflare-auth`, frozen deploy `4a8fb34b-b793-478a-945c-87fdc192ca75`
verified unchanged, backups mirrored, writable deploy
`02a30095-bcf2-4418-8fd7-28537524bd00` verified live, backup health current.
No synthetic agent account was created in production; the read-only checks
confirmed `/api/mcp` answers 401 with the `resource_metadata` challenge, both
metadata documents are served, and `/oauth/authorize` is served with framing
denied. To turn it off, set `AGENT_ACCESS_ENABLED` to `"false"` and release;
the tables are additive and can stay.

The guided setup was released the same day the same way: frozen
`0b102ddb-03c2-4249-9bf4-fa56774c2d0b` verified unchanged (4 accounts, 17
documents), writable `39b94ce0-9e69-433f-b967-d0f8ad6de794` verified live.
The note that column access can change later followed: frozen
`6ecbac7e-ec46-40bb-b7a7-d1d1bb3928ef`, writable
`d2e3bc65-9f0c-4057-b66f-8d57914aa2e1`, both verified.
Showing the server's message instead of an error code: frozen
`41c1f05e-bdfe-48eb-b583-c7af33a25f0f`, writable
`95f64341-72f7-4787-a8dd-0bbaeab4630f`, both verified.
Accepting ChatGPT (its metadata document lists `none` among its methods):
frozen `2acf6222-ef7c-42ca-b908-e693a5b37da0`, writable
`8ecf7e34-5a34-44a1-b91d-4d6dd7cfad9a`. The first frozen verification failed
on one request and the second passed; the likely cause was the verifier
trusting a single `/api/clock` response during propagation, now fixed.
Pruning the change log to 30 days and 1000 entries (`50d927e`): frozen
`5b81aa39-3246-48f4-a997-d641726622e9` verified unchanged (4 accounts, 17
documents), writable `574cabbb-c6e2-487e-82c6-7593d53e39d0` verified live.

## Connecting an agent

Account menu → Agents walks through each app step by step. Claude.ai and
other OAuth-capable clients: add `<origin>/api/mcp` as a custom connector and
approve the columns on the consent page. ChatGPT: Plugins → Add → Add custom
MCP server; the dialog gives the name, description, server URL and an icon
(`public/todoflare-icon.png`, a 256 px PNG under ChatGPT's 10 KB limit), with
Authentication left on OAuth. ChatGPT has no link that pre-fills that form;
only a listing in its plugin directory would make it one click. Claude Code:
choose the columns, then run the command the dialog shows:

```sh
claude mcp add --scope user --transport http todoflare https://todo.tamesystems.org/api/mcp \
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
