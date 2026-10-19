# 0003: Passkeys authenticate; Account IDs are public

Status: Accepted. Date: 2026-07-22, completed 2026-10-01.
Supersedes: the original "account number is the credential" decision
(Mullvad-style; recorded in [history/PLAN.md](../history/PLAN.md)).
Source: [proposals/passkey-authentication.md](../proposals/passkey-authentication.md).

## Context

The 16-digit account number was both the identity used in sharing ACLs and
presence, and the bearer secret for the whole account. Sharing a column meant
disclosing a value that could take over the account.

## Decision

- The Account ID stays as the stable, public identity (it is the Better Auth
  user id). It never authenticates.
- Passkeys authenticate, through Better Auth's passkey plugin, with an
  HttpOnly session cookie. A recovery code (stored hashed) covers loss of all
  passkeys.
- Better Auth stores its data in D1 (`AUTH_DB`), not KV: credentials need
  relational lookup, one-time challenges and consistent session mutation, and
  a custom adapter would reimplement exactly the security-sensitive parts.
- Better Auth requires an email; it gets a synthetic, undeliverable
  `account-<uuid>@accounts.invalid` that is stripped from every response.

## Consequences

- No email, password or social login exists.
- Account creation spans D1 (user, passkey) and KV (account record);
  `GET /api/auth-status` exposes the half-finished `provisional` and
  `provisioning` states so the client can finish them.
- The release verifier asserts that Account-ID headers and bearer tokens
  return 401.
