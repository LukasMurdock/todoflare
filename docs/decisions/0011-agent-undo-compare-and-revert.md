# 0011: Agent undo is compare-and-revert

Status: Accepted. Date: 2026-10-19. Source: [proposals/agent-access.md](../proposals/agent-access.md#writes).

## Context

People need to undo what an agent did, possibly after they have kept
editing. Yjs undo is not durable (garbage collection discards deleted content
once the object reloads), and rolling back to a snapshot would erase later
human work.

## Decision

Each agent write records an undo record in the column's `agent_changes`.
Undo reverts a field or item only while it still holds exactly what the agent
wrote, and reports what it kept because a person changed it since.

## Consequences

- Undo can only see what the server has received: an unsynced human edit
  inside an item an undo removes can still be lost.
- Verified by a seeded property test (`test/agent-edit-convergence.test.ts`)
  that requires every character a person typed to survive.
