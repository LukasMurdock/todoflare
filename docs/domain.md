# Domain

The vocabulary of Todoflare and how the concepts relate. Where a word has two
meanings in the codebase, both are listed.

## Concept map

```text
Account ─── identified by ──► Account ID (public, 16 digits)
   │        authenticated by ► Passkey session  (or Recovery code)
   │
   ├── owns (ordered) ───────► Column ◄── shared with ── other Accounts (Collaborators)
   │                             │  ├── content: one Yjs document
   │                             │  ├── may have a Public link (read-only, anyone)
   │                             │  └── deleted → Trash (30 days) → Purged
   ├── hides ────────────────► shared Columns it does not want listed
   │
   └── authorizes ───────────► Agent connection ── holds ──► Tokens
                                     └── has Grants ──► Column at read ⊂ append ⊂ edit
                                                         └── writes recorded as Agent changes (undoable)

Guest ── no account ── Columns in localStorage only (never synced)
```

## People and identity

**Guest**: someone using Todoflare without an account. Their columns live
only in this browser's localStorage, with hourly local checkpoints. Nothing is
sent to the server.

**Account**: a signed-in identity that owns columns. Exists in two stores: a
Better Auth user in D1 and an `account:<id>` record in KV.

**Account ID**: the 16-digit number that identifies an account. It is
**public**: you give it to people so they can share with you. It never
authenticates. It is also the Better Auth user id.

**Provisional user**: a Better Auth anonymous user created at the start of
sign-up, before a passkey exists. Cannot share or sync. Deleted after 7 days if
never finished. `provisioning` is the next state: passkey added, KV account
record not yet written.

**Passkey**: the only everyday credential. It must be user-verified (PIN or
biometric) to register or sign in. Signing in creates an HttpOnly **session**
cookie (7 days, renewed daily while used).

**Recent sign-in**: a session created in the last 5 minutes. Adding or
removing a passkey and creating a recovery code require one; the user
confirms with a passkey to get it. An account's first passkey is exempt.

**Recovery code**: an emergency credential for when every passkey is lost.
Stored hashed; rotated each time it is used. Using it signs out every other
session.

**Synthetic email**: the undeliverable `account-…@accounts.invalid` address
Better Auth requires. An implementation detail that must never be shown,
exported or logged.

## Columns

**Column**: one todo list on the board. Has an id (UUID), an owner, content and
metadata.

**Content / column document**: the column's rich text as a Yjs document
(Plate blocks as `Y.XmlText`). Items are paragraphs or list entries, with
attributes such as `checked` and `indent`.

**Metadata**: who owns the column, who it is shared with, its public ID, and
whether it is in trash. The column's Durable Object is the authority.

**Owner**: the account that created the column. Only the owner can share,
publish, delete or restore it.

**Collaborator** (`sharedWith`): another account the owner shared the column
with. Can read and edit content, sees presence, and can hide the column from
their own board.

**Hidden shared column**: a column shared with you that you removed from your
board. Removing a shared column hides it; it does not delete it.

**Public link / public ID**: an optional read-only URL `/p/:publicId` for one
column, viewable without an account. Re-enabling keeps the same ID.

**Trash**: a deleted column stays restorable for 30 days from its first
deletion, then is **purged** (permanently deleted, after a final backup).
Deleting it again while it is in trash does not move that date.

**Presence / awareness**: who is in a column right now (presence, derived by
the server) and their cursors (awareness, relayed). Never stored durably.

## Sync

**Client mode**: what the browser runtime is doing: `guest_local`,
`account_offline`, `account_syncing`, `account_realtime`, or
`account_auth_required` (session expired, local work kept).

**Metadata command**: a typed operation such as `column.create`,
`column.share`, `column.delete`, `column.reorder`. Defined once in
`ACCOUNT_COMMANDS`.

**Mutation queue / metadata outbox**: the durable FIFO queue of metadata
commands waiting for the server. Each command carries an **idempotency key**
so replaying it twice has one effect.

**Replay**: sending queued commands to the server, oldest first. Each ends
**acknowledged**, **retried** (transient failure, with backoff) or
**terminal** (dropped with a typed reason such as `revoked` or `not_found`).

**Yjs update outbox**: the durable queue of content updates. An entry stays
until the column's DO **acknowledges** it, which means the update is committed.

**Projection**: two senses.
- Client: what the UI shows, computed as the last server state plus pending
  commands.
- Server: a KV index derived from authoritative DO metadata
  (`shared:<account>`, `public:<id>`, `column-registry:<id>`), always
  repairable.

**Convergence**: the client pipeline that loads local state, hydrates from
the server, replays queued commands, reconciles results and confirms.

**Access loss**: the column was unshared from you or deleted. The client drops
that column's cached document and queued work, removes it from the board, and
tells you. This is the only case where local work is discarded.

**WebSocket ticket**: a single-use, 45-second credential that lets the browser
open a column's WebSocket without putting a cookie or Account ID in the URL.

## Agents

**Agent**: an AI client (Claude Code, Claude.ai, ChatGPT, any MCP client)
acting for an account through the MCP endpoint `/api/mcp`.

**Agent connection**: one authorized agent, belonging to one account. Always
expires (default 30 days). Disconnecting revokes it and all its tokens at once.

**Personal token**: a `tfa_…` bearer token shown once in the Agents dialog,
for clients configured by hand (Claude Code).

**OAuth client**: an app that connects through the consent page instead.
Identified by a **Client ID Metadata Document** (a URL it publishes) or by
dynamic registration. Gets short-lived `tfa_…` access tokens and rotating
`tfr_…` refresh tokens.

**Grant**: permission for one connection on one column, at a **level**:
- **read**: see the items
- **append**: also add new items
- **edit**: also change, check off, reorder and delete items

Levels are cumulative. A grant never exceeds what the account itself can
currently reach. There is no account-wide grant: "All columns" in the column
list sets each listed column's grant at once, and columns created later are
not included.

**Agent change**: a record of one agent write in the column (who, which tool,
what changed). Any member can **undo** it; undo reverts only what is still as
the agent left it, and keeps later human edits. The column's agent menu shows
each change as a **diff**: items added, removed, or changed (old → new), built
from the same record undo uses.

## Operations

**Read-only mode** (the **freeze**): a deployment flag that stops every write,
including scheduled jobs, while keeping reads, public links and sign-in.
Used for incidents, restores and every production release.

**Frozen release**: deploying a build read-only, verifying data against fresh
snapshots, then deploying the same build writable.

**Checkpoint**: two senses.
- Guest: the hourly local copy `todoflare-backup-YYYYMMDDHH` in localStorage.
- Release: `.wrangler/production-release-checkpoint.json`, proof that the
  frozen build was verified, valid for one hour.

**Column backup / account backup**: checksummed R2 copies, hourly. A column
backup holds metadata and the full Yjs state; an account backup holds the
account's order, sharing, trash and D1 user/passkey rows, but no sessions or
agent credentials. A **raw copy** preserves bytes of a corrupt column for
forensics and does not count as a usable backup. A **pre-restore copy** is
taken before any in-place restore.

**Restore**: `clone` (default) creates a new private column from a backup;
`in_place` overwrites the original and requires read-only mode.

**Lifecycle journal**: a KV entry written before a multi-store operation and
removed when it finishes, so the hourly reconcile can complete interrupted
work.

## Code roles

**Host**: an app that embeds `@todoflare/board` and supplies documents,
storage and chrome. Todoflare is one host (`TodoApp.tsx`); `examples/` has two
more.

**Board**: the embeddable editor package. Knows columns and documents, not
accounts.

**Workflow**: a named server module that performs one multi-store operation
in a deliberate order (`src/server/workflows/`).
