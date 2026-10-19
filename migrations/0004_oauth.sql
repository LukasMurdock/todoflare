-- OAuth 2.1 for MCP clients. A connection created through OAuth records the
-- client it was issued to, so refresh tokens only work for that client.
ALTER TABLE "agent_connection" ADD COLUMN "clientId" TEXT;

-- Clients known to the authorization server: registered dynamically
-- (RFC 7591, kind 'registered') or described by a Client ID Metadata
-- Document fetched from their HTTPS client_id (kind 'metadata', cached).
CREATE TABLE IF NOT EXISTS "oauth_client" (
	"clientId" TEXT PRIMARY KEY NOT NULL,
	"kind" TEXT NOT NULL CHECK ("kind" IN ('registered', 'metadata')),
	"name" TEXT NOT NULL,
	"clientUri" TEXT,
	"redirectUris" TEXT NOT NULL,
	"createdAt" INTEGER NOT NULL,
	"fetchedAt" INTEGER
);

-- Authorization codes, stored hashed. Single use: "usedAt" is set atomically
-- on redemption, and a second redemption revokes the connection it created.
CREATE TABLE IF NOT EXISTS "oauth_code" (
	"codeHash" TEXT PRIMARY KEY NOT NULL,
	"clientId" TEXT NOT NULL,
	"redirectUri" TEXT NOT NULL,
	"codeChallenge" TEXT NOT NULL,
	"resource" TEXT NOT NULL,
	"connectionId" TEXT NOT NULL REFERENCES "agent_connection" ("id") ON DELETE CASCADE,
	"expiresAt" INTEGER NOT NULL,
	"usedAt" INTEGER
);
CREATE INDEX IF NOT EXISTS "oauth_code_expiresAt_idx" ON "oauth_code" ("expiresAt");
