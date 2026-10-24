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

- The auth route (`src/server/routes/auth.ts`) reads the UV flag from the
  authenticator data of `verify-registration` and `verify-authentication`
  (`src/server/passkey-policy.ts`) and refuses an unverified ceremony with
  `user_verification_required`. Sign-in options are rewritten to
  `userVerification: "required"`. At sign-in the UV flag is covered by the
  assertion signature the plugin verifies, so it cannot be forged. At
  registration, with `"none"` attestation, it is only what the browser
  reports: it stops an honest client registering an unverified authenticator,
  not a modified client, which would need the account's recent sign-in anyway.
- Issuing a registration challenge, deleting a passkey and creating a recovery
  code require a session created in the last 5 minutes
  (`recent_authentication_required`). The exception is the first passkey of an
  account with no passkey and no recovery code. Gating the challenge gates
  `verify-registration`, since that needs the single-use challenge.
- Better Auth's own freshness check (`session.freshAge`, 24 hours by default)
  is turned off, because it would refuse the first passkey of a sign-up
  resumed a day later; the route owns freshness, including for the other
  endpoints that had it, `unlink-account` and `list-sessions` (which returns
  session tokens).
- Credential changes may name the account the client shows in
  `X-Todoflare-Expected-Account`; a different session user gets
  `account_mismatch`. Sign-up sends it for the provisional account on
  `verify-registration` and `POST /api/account`. The client answers `recent_authentication_required`
  with a passkey confirmation (a fresh sign-in, limited to the account's own
  passkeys), checks it signed in the same account, and retries the change.
- Recovery with a code deletes every session of the account before issuing
  its own. The credential manager can sign out other sessions.

## Consequences

- Authenticators without user verification cannot be used. Every platform
  passkey provider and every PIN-capable security key qualifies.
- These checks sit outside Better Auth, so a plugin upgrade must keep the
  request body shapes the policy parses; `test/passkey-security.test.ts` runs
  real ceremonies with a software authenticator to catch that.
- Revoking sessions does not close WebSockets already open; they end at the
  next reconnect, which needs a ticket and so a live session
  ([0004](0004-single-use-websocket-tickets.md)).
