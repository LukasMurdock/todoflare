# 0018: Passkeys name their account to password managers

Status: Accepted. Date: 2026-10-24. Builds on
[0017](0017-verified-passkeys-and-recent-credential-changes.md).

## Context

Better Auth's passkey plugin gives each new passkey a random WebAuthn user
handle and takes the user name from the request's passkey label. Every
Todoflare passkey therefore appeared in password managers as "Primary
passkey", so two accounts were indistinguishable in the picker, and no
handle connected an account's passkeys. Without a stable handle the WebAuthn
Signal API cannot tell a password manager that a passkey was deleted or that
its account's name changed.

The W3C Passkey Endpoints draft lets credential managers discover where a
relying party enrolls and manages passkeys, at
`/.well-known/passkey-endpoints` on the RP ID.

## Decision

- `passkeyUser(accountId)` in `src/lib/passkey-identity.ts` is the WebAuthn
  user for an account: the formatted Account ID as name and display name,
  and a user handle that encodes the Account ID. WebAuthn recommends random
  handles that identify nobody, since an authenticator may reveal a handle
  before user verification. Here a revealed handle links the passkey to the
  account's public Account ID, which the passkey's name already shows; a
  random handle would need storing per account for no other gain.
- The `generate-register-options` row of `AUTH_ENDPOINTS` rewrites the
  plugin's `user` to `passkeyUser`. The plugin never reads the handle back;
  it finds passkeys by credential ID.
- The client signals through the Signal API, best effort and only where the
  browser has it: `signalCurrentUserDetails` after a passkey sign-in, and
  `signalUnknownCredential` for a passkey the server has just deleted, so it
  leaves the password manager too. It never sends
  `signalAllAcceptedCredentials`: that needs a provably complete list, and the
  plugin's list stops at 100 rows and can be read just before another tab
  registers a passkey. A manager may act on it irreversibly.
- `/.well-known/passkey-endpoints` serves `{}`: passkeys are supported, but
  enrollment and management are dialogs, not pages a manager could link to.
  It names `enroll` and `manage` once those exist as routes.

## Consequences

- Passkeys registered before this change keep their random handle and
  "Primary passkey" name; the name signal cannot reach them, though deleting
  one still removes it from the password manager.
- A passkey deleted from another device, or before this change, can stay in
  the password manager until the user removes it there: a failed sign-in
  does not signal it.
- The client uses the page's hostname as RP ID for signals. That matches the
  server while each deployment's `AUTH_RP_ID` is its hostname; if they ever
  differ, signals stop reaching passkeys without breaking anything.
- Two passkeys of one account cannot live in one password manager, since a
  manager keeps one passkey per RP and handle. The plugin's
  `excludeCredentials` already prevents registering a second one there.
