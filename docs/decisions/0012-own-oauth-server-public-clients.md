# 0012: Todoflare is its own OAuth server, for public clients only

Status: Accepted. Date: 2026-10-19. Source: [proposals/agent-access.md](../proposals/agent-access.md#oauth).

## Context

Claude.ai, ChatGPT and other remote MCP clients connect with OAuth 2.1 per the
MCP authorization specification. There is no external identity provider, and
the consent decision (which columns, at which level) is specific to Todoflare.

## Decision

- The Worker is the authorization server (`src/server/oauth/`). Consent is a
  page in the app, and approving it creates the connection and its grants.
- Only public clients (`token_endpoint_auth_method: none`) with PKCE S256 and
  an RFC 8707 `resource` bound to `/api/mcp`.
- Client ID Metadata Documents are preferred and fetched defensively (no
  redirects, 5 s, 5 KB, no private or IP-literal hosts). A client is accepted
  if `none` is among its supported methods, even if it prefers another
  (ChatGPT prefers `private_key_jwt`). Dynamic registration is kept for older
  clients, rate limited.
- Codes are single use and short-lived; a replayed code revokes the
  connection. Access tokens last an hour; refresh tokens rotate.

## Consequences

- No client secrets or signing keys to manage.
- No RFC 7009 revocation endpoint yet; disconnecting in the app revokes all
  of a connection's tokens.
