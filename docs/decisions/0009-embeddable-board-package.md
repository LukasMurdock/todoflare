# 0009: The editor is an embeddable package the app consumes by its public API

Status: Accepted. Date: 2026-10-18. Source: [proposals/embeddable-board.md](../proposals/embeddable-board.md).

## Context

Editing behavior was entangled with accounts, sync and storage, so changes
to the editor touched the sync runtime and the reverse.

## Decision

`packages/board` (`@todoflare/board`) owns editing: columns of Plate
editors over Yjs documents it gets from a host-supplied `DocumentAdapter`.
The host owns identity, storage, transport, sharing and page chrome.
Todoflare consumes only the package entry, like any other host; two more
hosts (`examples/minimal`, `examples/void` with SSR) prove the boundary.

## Consequences

- `check:board-boundary` and `check:board-api` enforce the boundary and the
  exact exported API (`packages/board/api-report.md`).
- Account-specific UI enters through slots (`renderTopBar`,
  `renderColumnActions`) and intents (`onCreateColumn`, …).
