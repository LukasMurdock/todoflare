-- Delegated access for AI agents. A connection is one agent an account has
-- authorized; it can reach only the columns it holds a grant for, and only
-- while the granting account itself still has access to them.
--
-- userId deliberately has no foreign key: test and legacy accounts exist in
-- KV without a Better Auth user row. Grants and tokens cascade from their
-- connection, so revoking or deleting a connection removes every credential.
CREATE TABLE IF NOT EXISTS "agent_connection" (
	"id" TEXT PRIMARY KEY NOT NULL,
	"userId" TEXT NOT NULL,
	"name" TEXT NOT NULL,
	"createdAt" INTEGER NOT NULL,
	"expiresAt" INTEGER NOT NULL,
	"revokedAt" INTEGER,
	"lastUsedAt" INTEGER
);
CREATE INDEX IF NOT EXISTS "agent_connection_userId_idx" ON "agent_connection" ("userId");

-- Only SHA-256 hashes of bearer tokens are stored.
CREATE TABLE IF NOT EXISTS "agent_token" (
	"tokenHash" TEXT PRIMARY KEY NOT NULL,
	"connectionId" TEXT NOT NULL REFERENCES "agent_connection" ("id") ON DELETE CASCADE,
	"kind" TEXT NOT NULL CHECK ("kind" IN ('personal', 'access', 'refresh')),
	"createdAt" INTEGER NOT NULL,
	"expiresAt" INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "agent_token_connectionId_idx" ON "agent_token" ("connectionId");

CREATE TABLE IF NOT EXISTS "agent_grant" (
	"connectionId" TEXT NOT NULL REFERENCES "agent_connection" ("id") ON DELETE CASCADE,
	"columnId" TEXT NOT NULL,
	"level" TEXT NOT NULL CHECK ("level" IN ('read', 'append', 'edit')),
	"createdAt" INTEGER NOT NULL,
	"updatedAt" INTEGER NOT NULL,
	"expiresAt" INTEGER,
	PRIMARY KEY ("connectionId", "columnId")
);
CREATE INDEX IF NOT EXISTS "agent_grant_columnId_idx" ON "agent_grant" ("columnId");
