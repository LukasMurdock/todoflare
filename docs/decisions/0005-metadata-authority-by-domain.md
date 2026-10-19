# 0005: Metadata authority is scoped by domain; KV indexes are projections

Status: Accepted. Date: 2026-07-19. Source: [history/PLAN.md](../history/PLAN.md).

## Context

Column metadata is needed both per column (who may open it) and per account
(which columns to list). KV is eventually consistent and cannot update two
keys atomically; a column's DO is strongly consistent for that column.

## Decision

- The column DO is authoritative for column existence, ownership,
  collaborators and public-link identity.
- Account KV records (through `AccountCoordinatorSql`) are authoritative for
  account existence, owned-column order, hidden shared columns and trash.
- `shared:*`, `public:*` and `column-registry:*` are derived discovery
  projections.

## Consequences

- Lifecycle operations update the authority, then repair projections
  idempotently. Retrying a share repairs a missing index without rotating
  anything; retrying public-link enable reuses the existing public ID.
- Readers verify projections: hydration drops `shared:` entries the DO no
  longer grants; the DO refuses a public socket whose ID it does not hold.
