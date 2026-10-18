# Change locality: baseline and shortlist

Baseline commit: `ad9b078f`. Everything here is reproducible:

```sh
node scripts/analysis/change-cost.mjs      # scripted sample changes, ~15s
node scripts/analysis/fact-inventory.mjs   # where each fact is restated
node scripts/analysis/change-coupling.mjs  # git co-change and hotspots
```

## How to read the numbers

`change-cost.mjs` applies a one-line seed edit (the declaration a developer
would change first) to a scratch worktree of HEAD and runs both TypeScript
projects.

- **required**: files that must change. This is the union of the files the
  compiler flags and every file that restates an existing sibling of the same
  kind (for example, every file that mentions `column.public.disable`).
- **guided**: required files the compiler points to.
- **silent**: required files the compiler does not point to. Forgetting one of
  these produces no build error.

The sibling footprint is an upper bound for "required". A file that only
*produces* a sibling value (for example, an endpoint that returns `not_found`)
may not need to change for a new member. Silent counts below were checked by
hand and the over-counts are noted.

## Baseline

| Scenario | Required src files (incl. seed) | Guided | Silent | Silent: consequence if forgotten |
| --- | ---: | ---: | ---: | --- |
| Add account command | 7 | 3 | 3 | `account-command-parser.ts` hits `default: return null`, so a queued command is **quarantined on next reload** and stops syncing. The `index.tsx` route and the `sync-context.tsx` caller are missing, but nothing reports it. |
| Add `ColumnMeta` field | 10 | 7 | 2 | `account-contract.ts` and `persistence-contract.ts` use `.strict()` zod objects that **reject** the new key at runtime: server responses fail `server_contract_invalid`, and local snapshots are quarantined. |
| Add terminal replay reason | 4 | 0 | 1 (real) | `persistence-contract.ts` `terminalReasonSchema` rejects it, so the outbox record is quarantined. (Executor and replay-response are producers: over-counted.) |
| Add sync mode | n/a | | 1 | `syncStateSchema.mode` z.enum restates `SyncMode` (same failure shape). |
| Add websocket message | 5 | 0 | 4 | Opcode table, encoder/decoder `switch … default`, socket actor and server have no link to the `SyncMessage` union. |
| Add HTTP route | 3 | 0 | 2 | No shared declaration. The client URL and server pattern are separate strings, and unit tests copy the client's string, so a mismatch is only caught by e2e. |
| Add API error code | 2 | 0 | 1 | Producer only; low value. |

Fact inventory, condensed:

- **Account command**: 9 members. Each is restated in 6 src files (14 total).
  Payload shape is declared twice: the TS `AccountCommandPayloadMap` and the
  hand-written validator in `account-command-parser.ts`.
- **Record shapes**: `Account` and `ColumnMeta` are each declared 4 times
  independently: the interface in `types/account.ts`, the API contract
  schema, the local persistence schema, and the import input schema in
  `index.tsx`. **They have already drifted.** The contract requires `publicId`
  to match `^[0-9A-Za-z]{8}$` and ids to be 128 chars or less, while local
  persistence accepts any string. (`server/persistence-records.ts` correctly
  derives via `.extend`.)
- **HTTP routes**: 29 routes declared only in `index.tsx`. 17 are restated as
  literal strings in client, test, e2e or scripts.

Structure and history (41 code commits; most are large, so co-change is weak
evidence):

| Hotspot (revisions x lines) | Revisions | Lines |
| --- | ---: | ---: |
| `src/index.tsx` | 22 | 2451 |
| `src/contexts/sync-context.tsx` | 18 | 1294 |
| `src/durable-objects/column-room.ts` | 12 | 985 |
| `src/components/todo/TodoColumn.tsx` | 11 | 795 |

Strongest distant co-change: `AccountBadge.tsx` with `useAccount.ts`
(Jaccard 0.90, 9 commits), and `sync-context.tsx` with `column-room.ts`
(10 commits).

## Ranked shortlist

Ranked by silent sites x how often the concept changes x consequence.

### 1. Account command registry *(highest value)*

One declaration per command: a payload zod schema, plus HTTP method/path,
response schema and effect mapping. From it, derive:

- `AccountCommandPayloadMap` (`z.infer`)
- the persisted-outbox parser (replaces the hand-written switch and its
  `default: return null`)
- the executor's request/response plumbing

The server registers each command's route from the same entry, keyed by a
`satisfies Record<AccountCommandType, …>` map.

- Target: add-account-command goes from **7 required / 3 silent** to **3 or
  fewer required / 0 silent in lib** (registry entry, server handler body, UI
  caller).
- Adversarial check: a registry must not become a god file that every command
  edit conflicts in. Keep one small entry per command. Generic types must stay
  readable, so each executor case body stays plain code and only the plumbing
  is derived.

### 2. Record shapes from one schema

Make `columnMetaContractSchema` / `accountContractSchema` the source. Types
come from `z.infer`. Local persistence and import input schemas are built with
`.extend` / `.pick`, or are at minimum type-linked
(`satisfies z.ZodType<ColumnMeta>`, which flags missing keys).

- Target: add-column-meta-field silent goes from **2 to 0**.
- **Decision needed from you:** is the looser local-persistence validation
  deliberate (tolerate old or odd local data rather than quarantine it), or is
  it drift? That decides whether local derives the strict contract or a
  documented relaxed variant.

### 3. Persisted unions from const arrays *(small, cheap)*

`TERMINAL_REPLAY_REASONS` and `SYNC_MODES` become `as const` arrays. Both the
union type and the persistence `z.enum` derive from them, matching the
existing `ACCOUNT_COMMAND_TYPES` / `API_ERROR_CODES` pattern.

- Target: 1 silent site each goes to **0**.

### 4. Shared route table

A `src/lib/api/routes.ts` of `{ method, pattern, path(params) }` used by the
Hono registration and by every client fetch, and by tests where they assert the
client's request.

- Target: a client/server path mismatch becomes a compile error instead of an
  e2e failure. Literal `/api/` strings in `src` drop from 17 restatements to 0.
- Adversarial check: e2e specs and `scripts/*.mjs` stay hard-coded on purpose,
  as black-box tests of the public contract. Listed as deliberate duplicates.
- Overlaps with #1, which already covers the command routes. Do #1 first.

### 5. Split `index.tsx` by feature *(largest local-reasoning win, most churn)*

Split into `server/routes/{account,column,public,admin-backups}.ts` with each
feature's request schemas beside its handlers. This removes the 2,451-line
hotspot (2.3x the next one). It is mostly a move, so behavior risk is low but
the diff is large. Best done after #1 and #4 so the files are cut once, along
their final seams.

### Considered and deferred

- **Websocket protocol** (4 silent sites). It is real, but the protocol is
  versioned (`todoflare-yjs-v1`) and rarely changes. An exhaustive
  `Record<SyncMessage["type"], opcode>` is a cheap follow-up if wanted.
- **API error codes**: the silent site is the producer, which is inherent.
- **`sync-context.tsx` split / `AccountBadge` + `useAccount` coupling**: needs
  a closer read before proposing. It may fall out of #1, since command
  submission lives in sync-context.

## Deliberate duplicates (will not remove)

- e2e specs and `scripts/*.mjs` restate URLs and payloads as black-box checks
  of the deployed contract.
- Server-side request validation and client-side response validation of the
  same contract on either side of the trust boundary. The goal is that both
  derive from one schema, not that one side stops validating.
