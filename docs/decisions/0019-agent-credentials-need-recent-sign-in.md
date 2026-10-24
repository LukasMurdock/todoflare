# 0019: Agent connections and grants need a recent sign-in

Status: Accepted. Date: 2026-10-24. Extends
[0017](0017-verified-passkeys-and-recent-credential-changes.md) to the agent
access model of [0010](0010-agent-access-model.md).

## Context

0017 requires a recent sign-in before adding a passkey or creating a recovery
code, because both outlive the session that makes them. An agent connection
does too: its bearer token, or the OAuth refresh token an approval leads to,
keeps working after the session ends. A stale or stolen session could
connect its own agent, or widen an existing agent's grants, and keep reading
or editing the account's columns.

## Decision

- Creating an agent connection, setting a grant level, and approving an
  OAuth client call `requireRecentSignIn` (`src/lib/http-account-auth.ts`)
  after `requireAccountCredential`, and refuse a session older than 5 minutes
  with `recent_authentication_required`.
- Narrowing stays open to any session: removing a grant, disconnecting an
  agent, declining an OAuth client. Cutting access off is never what an
  attacker needs.
- On the client, `useRecentSignIn` (`src/hooks/use-recent-sign-in.ts`) keeps
  a refused change and `ConfirmSignIn` asks for the account's passkey from a
  click, since Safari allows a passkey prompt only from one, then retries it.
  The credential manager, the agents dialog, the column agents menu and the
  consent page share it. The retry repeats the change as submitted, so the UI
  is locked while it waits; cancelling, navigating away or switching account
  drops it, even mid-confirmation.

## Consequences

- Setting any grant level, including a lower one, can ask for a passkey: the
  route does not compare the new level with the old.
- The consent page rarely asks: a person usually signs in on it just before
  approving.
- The Vitest and E2E fixture accounts have no session, so they skip the check;
  `test/agent-recent-sign-in.test.ts` uses real passkey sessions.
