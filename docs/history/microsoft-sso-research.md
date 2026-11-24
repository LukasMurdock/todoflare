# Microsoft SSO research

Date: 2026-10-24

## Conclusion

Microsoft sign-in is feasible with the installed `better-auth@1.7.10`, which
has a built-in Microsoft Entra ID provider. It is not a one-line provider
configuration in Todoflare, however: the application currently defines a
permanent account as “a Better Auth user with at least one passkey,” and that
assumption appears in server authorization, provisioning, cleanup, recovery,
UI copy, read-only operations and tests.

The recommended implementation is:

1. Use a **single Microsoft Entra tenant GUID** unless accepting arbitrary
   personal and work Microsoft accounts is an explicit product requirement.
2. Treat Microsoft as another credential for the same stable 16-digit
   Todoflare Account ID.
3. Require **explicit linking** when adding Microsoft to an existing account;
   never merge accounts by matching email.
4. Let a first Microsoft sign-in create a new Todoflare account and complete
   the existing D1-to-KV provisioning flow after the OAuth redirect.
5. Preserve Todoflare's pseudonymous model by mapping the Microsoft profile to
   a synthetic `@accounts.invalid` email, a generic local name and no photo.
6. Request only OIDC identity scopes and do not retain or back up Microsoft API
   tokens that Todoflare does not use.

No editor, sync protocol, Durable Object or column data model change is needed.
The work is concentrated in authentication and account lifecycle code.

## Product decisions required

### Which Microsoft accounts are accepted?

Microsoft supports these account audiences:

- one organization: a concrete Entra tenant GUID
- any work/school organization: `organizations`
- personal Microsoft accounts: `consumers`
- both work/school and personal accounts: `common`

For workforce SSO, use the organization's concrete tenant GUID. This also
avoids an identity-key concern in Better Auth 1.7.10: its built-in Microsoft
provider keys an account by the token's `oid`, while Microsoft documents `oid`
as tenant-scoped. A concrete tenant makes that safe. Before using
`common`/`organizations`, Todoflare should use or implement an account subject
that includes both `tid` and `oid`, or upgrade to a Better Auth version verified
to do so.

### Is Microsoft an alternative login or the only login?

The lower-risk design keeps passkeys and recovery codes and adds Microsoft as
an alternative credential. Existing accounts explicitly link Microsoft from
the credential manager. New users may create an account with either a passkey
or Microsoft.

Removing passkeys entirely would increase dependence on Microsoft tenant
availability and administration and would require a separate migration and
recovery policy.

### What profile information is retained?

Todoflare currently stores no real email and deliberately strips email from
auth responses. The Microsoft provider normally stores the real email, name,
photo and OAuth tokens. None are needed for Todoflare's authorization model.

Recommended mapping:

- local email: deterministic synthetic address derived from a keyed hash of
  `tenant-id + object-id`, under `accounts.invalid`
- local name: `Todoflare account`
- local image: absent
- provider binding: Microsoft tenant/object identity only
- access/refresh/ID tokens: discard after establishing the binding, or at
  minimum encrypt and exclude them from account backups

This keeps Account ID as the only user-visible identity and avoids introducing
email handling, display, export and privacy obligations.

## External Microsoft setup

Create separate Entra app registrations for staging and production. Configure:

- platform: Web
- authorization code flow
- client secret or certificate assertion
- supported account type matching the chosen tenant policy
- redirect URIs:
  - `https://todo.tamesystems.org/api/auth/callback/microsoft`
  - `https://staging.todo.tamesystems.org/api/auth/callback/microsoft`
  - optionally `http://localhost:5173/api/auth/callback/microsoft` on a
    development-only registration
- front-channel logout is not required for the initial implementation

Set these as Cloudflare Worker secrets/variables, not in `wrangler.jsonc`:

- `MICROSOFT_CLIENT_ID`
- `MICROSOFT_CLIENT_SECRET` (or assertion key configuration)
- `MICROSOFT_TENANT_ID`

A secret-expiry and rotation procedure must be added to `docs/operations.md`.
Prefer separate credentials per environment so staging cannot authenticate
against the production registration.

The Better Auth provider defaults include `User.Read`, `offline_access` and a
Graph request for the profile photo. Todoflare should set
`disableProfilePhoto: true`, disable the provider defaults and request only
`openid`, `profile` and `email` unless testing proves an additional scope is
strictly necessary.

## Required code changes

### 1. Configure Better Auth

In `src/server/auth.ts`:

- extend `AuthBindings` with the Microsoft settings
- conditionally add `socialProviders.microsoft`
- configure the tenant and minimal scopes
- map the provider profile to synthetic local user fields
- change account linking from `enabled: false` to:
  - `enabled: true`
  - `disableImplicitLinking: true`
  - `allowDifferentEmails: true` only for the explicit authenticated link flow
- ensure the OAuth-created user is marked as permanently credentialed

`allowDifferentEmails` is necessary because existing Todoflare users have a
random synthetic email that cannot equal the provider-derived synthetic email.
It is acceptable only with explicit linking from an already authenticated,
recent session; it must not be used for implicit email-based merging.

### 2. Generalize the permanent-credential invariant

The following currently require a row in `passkey` and must instead accept a
passkey **or** a linked Microsoft provider account:

- `src/lib/http-account-auth.ts` (`requireAccountCredential`)
- `src/server/routes/auth.ts` (`/api/auth-status`)
- `src/server/auth.ts` (`cleanupAbandonedProvisionalUsers`)
- `src/server/routes/account.ts` account provisioning
- credential-removal safety checks

The `AuthState` type and client status names currently use `passkey` as a
synonym for “permanent.” Rename that concept to `credentialed`/`ready` rather
than retaining a misleading state. Existing `authState = 'passkey'` rows can be
recognized during migration; a new D1 column is not inherently required.

A shared server helper such as `hasPermanentCredential(db, userId)` should own
the SQL predicate so authorization, cleanup and status cannot drift apart.

### 3. Complete provisioning after the redirect

A Microsoft callback creates the D1 user, provider account and session, but
Todoflare also needs the KV `account:<id>` record. The current passkey code does
this synchronously after WebAuthn and the convergence actor starts only from an
Account ID already in local storage.

Add an OAuth completion route/page or startup bootstrap that:

1. calls `/api/auth-status`
2. verifies that the session is Microsoft-credentialed
3. calls `POST /api/account` if the domain account is still provisioning
4. stores the returned Account ID in `todoflare-account`
5. starts convergence for that ID
6. clears the temporary OAuth intent and removes callback/error query data

The intent must distinguish:

- sign in to an existing account
- create an account and claim guest columns
- create an account and start fresh
- reconnect the account already open in this browser
- link Microsoft to the currently signed-in account

For reconnect, preserve the existing protection that refuses a session for a
different Account ID and leaves local queued work untouched.

### 4. Add client actions and UI

Add a Microsoft action based on:

```ts
authClient.signIn.social({
  provider: "microsoft",
  callbackURL: `${window.location.origin}/auth/microsoft/complete`,
});
```

Update:

- `src/components/account/AccountModal.tsx`
- `src/components/account/ClaimDataModal.tsx`
- `src/components/account/ReconnectBanner.tsx`
- `src/components/account/CredentialManager.tsx`
- `src/components/agents/OAuthConsentPage.tsx`
- `src/hooks/useAccount.ts`
- `src/contexts/sync-context.tsx`
- `src/lib/sync/account-api-client.ts`
- `src/client.tsx` routing

The credential manager should list linked Microsoft identities, support
explicit linking, and support unlinking only when another usable credential
(passkey, recovery code if considered sufficient, or another provider) remains.
The existing “last recovery method” guard currently knows only about passkeys
and recovery codes.

### 5. Handle read-only mode deliberately

`src/server/routes/auth.ts` currently allows passkey authentication during a
freeze but blocks unknown auth routes. Microsoft needs at least:

- `POST /api/auth/sign-in/social`
- `GET|POST /api/auth/callback/microsoft`

The callback can create users/provider rows, update tokens and create sessions,
so blindly whitelisting it could race an account restore. Choose and document
one of these policies:

- **Recommended initial policy:** Microsoft sign-in is unavailable during a
  freeze; passkey sign-in remains the operational recovery path.
- More complex policy: permit sign-in for already-linked users while blocking
  sign-up, linking and provider-row mutation during a freeze.

The first policy is simpler and safer but requires correcting the operations UI
and documentation from “sign-in works” to “passkey sign-in works.”

### 6. Harden persistence and backups

The existing `account` table already has the columns Better Auth needs, so a
basic provider integration does not require regenerating the schema. Add a
migration for a unique index on `(providerId, accountId)` if Better Auth's
expected uniqueness is not already enforced; the current migration has only an
index on `userId`.

`src/server/account-backup.ts` currently backs up access, refresh and ID tokens.
With Microsoft enabled, change the backup format to preserve only the provider
binding needed to restore login, or encrypt/redact token fields. Todoflare does
not use Microsoft API access, so keeping reusable Microsoft tokens in R2 and
local mirrors is unnecessary exposure.

Restore tests must verify that a restored provider binding can authenticate
again and that stale sessions/tokens are not restored.

### 7. Update terminology and documentation

Microsoft login supersedes the passkey-only architectural decision. Add a new
decision record superseding `docs/decisions/0003-passkeys-and-public-account-ids.md`.
Update:

- `docs/architecture.md`
- `docs/domain.md`
- `docs/operations.md`
- `docs/staging.md`
- UI text that says passkeys are the only everyday credential
- comments saying management routes require a passkey session when they
  actually require an account session

The invariant should become: “An Account ID alone never authenticates; only a
session established by an approved account credential does.”

## Testing and rollout

### Automated tests

Add coverage for:

- Microsoft provider configuration is absent when secrets are absent and
  present when configured
- OAuth initiation uses the expected callback, tenant, PKCE/state/nonce and
  minimal scopes
- a provider-backed session passes `requireAccountCredential`
- a provisional anonymous user without passkey/provider remains rejected
- cleanup keeps provider-backed users and removes abandoned provisional users
- first Microsoft sign-in provisions exactly one KV account under retries
- explicit linking keeps the existing 16-digit Account ID
- no implicit merge occurs by email
- reconnect rejects a Microsoft identity linked to another open account
- unlinking the final usable credential is rejected
- provider responses never expose email
- account backups contain no reusable Microsoft tokens
- read-only mode follows the selected callback policy
- guest “claim” and “start fresh” intent survives the redirect

The current local WebAuthn E2E setup does not exercise an external IdP. Add a
mock OIDC/Microsoft-compatible flow for deterministic tests, then perform a
real staging smoke test against a staging Entra registration. Production should
be enabled only after the staging callback, linking, new-account provisioning,
logout/relogin, freeze behavior and backup restore have all been exercised.

### Rollout order

1. Register staging and production applications in Entra.
2. Implement and test behind `MICROSOFT_SSO_ENABLED`.
3. Deploy and migrate staging; run real tenant smoke tests.
4. Verify backup redaction and account restore.
5. Add production secrets while the feature flag remains off.
6. Use the normal frozen production release procedure.
7. Enable Microsoft for a small known tenant/audience first.
8. Monitor sign-in failures without logging callback parameters, tokens,
   emails or Account IDs.

## Estimated scope

This is a medium authentication change, not a schema or sync rewrite. Expect
roughly:

- one Entra registration per deployed environment
- one D1 hardening migration
- one auth/provider configuration change
- one OAuth completion flow
- changes to five account/auth UI surfaces
- generalized credential checks and cleanup
- backup/restore changes
- a decision record and updates to architecture/domain/operations docs
- unit, Worker integration, E2E/mock-IdP and staging tests

The main engineering risks are account mis-linking, losing the existing Account
ID during linking, deleting provider-backed users as “provisional,” accepting a
different account during reconnect, retaining unnecessary Microsoft tokens,
and allowing OAuth callback writes to race a frozen restore.
