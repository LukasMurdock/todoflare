# 0006: A project-owned IndexedDB store, not RxDB or TanStack DB

Status: Accepted; long-term fitness is an open question. Date: 2026-07-19.
Source: [history/PLAN.md](../history/PLAN.md).

## Context

The original local-first plan proposed TanStack DB and RxDB, a `SyncRuntime`
facade, and six collections.

## Decision

Use a small IndexedDB-backed `PersistedMap` (`src/lib/local-first/`) whose
collections all have production readers: `accountSnapshot`, `columnDocument`
(the document cache), `mutationOutbox`, `yjsUpdateOutbox`, `syncState`, and
`quarantine` for records that fail migration or parsing. A
localStorage journal covers writes before IndexedDB opens, and the store
falls back to memory (and pauses editing) if IndexedDB is unavailable.

## Consequences

- No query layer or reactive store; React projections are derived in
  `SyncProvider` and hooks.
- Do not add RxDB or TanStack DB, or a facade hierarchy, without a new
  decision based on measured need.
- Open: whether the current schema and migration strategy is enough for a
  long-lived store.
