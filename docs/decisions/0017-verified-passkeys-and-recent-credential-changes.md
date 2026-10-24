# 0017: Passkeys must be user-verified; credential changes need a recent sign-in

Status: Accepted. Date: 2026-10-24. Extends
[0003](0003-passkeys-and-public-account-ids.md).

## Context

A passkey is an account's only everyday credential, so it must be two factors
in one: the device and the user's PIN or biometric. Better Auth's passkey
plugin (1.7.10) asks authenticators for verification only as `preferred` at
sign-in and verifies both ceremonies with `requireUserVerification: false`, so
a security key that was only touched could sign in.

A session cookie lives for 7 days, renewed while used. Only passkey deletion
required a recent sign-in; a stale or stolen session could add its own passkey
or mint a recovery code, both of which outlive the session. Recovering an
account left every other session, including a thief's, signed in.

## Decision

- One table, `AUTH_ENDPOINTS` in `src/server/auth-policy.ts`, lists every
  Better Auth endpoint reachable over HTTP and the policy each must satisfy.
  The auth route applies it to every request; an unlisted endpoint answers
  404. Better Auth's plugins define about 40 endpoints (email, social,
  account linking, user updates) and Todoflare uses 12, so the reachable
  surface is the table, not the plugin set.
- **User verification.** Verification ceremonies are refused with
  `user_verification_required` unless their authenticator data reports UV,
  and sign-in options are rewritten to ask for it. At sign-in the assertion
  signature the plugin verifies covers the flag, so it cannot be forged. At
  registration, with `"none"` attestation, it is what the browser reports: it
  stops an honest client registering an unverified authenticator, not a
  modified client, which would need the account's recent sign-in anyway.
- **Recent sign-in.** Rows marked `recentSignIn` need a session created in the
  last 5 minutes (`recent_authentication_required`). An account with no
  passkey and no recovery code is exempt from enrolling its first passkey.
  Better Auth's own freshness check (`session.freshAge`, 24 hours) is turned
  off, because it would refuse that first passkey on a sign-up resumed a day
  later, so the table is the only freshness policy;
  `test/auth-policy.test.ts` fails if a listed endpoint that Better Auth
  marks fresh has no `recentSignIn` rule.
- **Expected account.** Rows marked `expectedAccount` are refused with
  `account_mismatch` when `X-Todoflare-Expected-Account` names another account
  than the session's, so a change queued in one tab cannot land on an account
  another tab signed in to. Sign-up and the credential manager send it. The
  client answers `recent_authentication_required` with a passkey confirmation
  (a fresh sign-in, limited to the account's own passkeys), checks it signed
  in the same account, and retries the change.
- Recovery with a code deletes every session of the account before issuing
  its own. The credential manager can sign out other sessions.

## Consequences

- Authenticators without user verification cannot be used. Every platform
  passkey provider and every PIN-capable security key qualifies.
- Exposing another Better Auth endpoint is one new row, with its policy
  decided in the same place.
- These checks sit outside Better Auth, so an upgrade must keep its endpoint
  paths and the request body shapes the policy parses.
  `test/auth-policy.test.ts` checks each row against Better Auth's endpoints;
  `test/passkey-security.test.ts` runs real ceremonies with a software
  authenticator.
- Revoking sessions does not close WebSockets already open; they end at the
  next reconnect, which needs a ticket and so a live session
  ([0004](0004-single-use-websocket-tickets.md)).
