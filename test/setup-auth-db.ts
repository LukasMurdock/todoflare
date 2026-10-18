// Every test file gets the auth tables production has. better-auth 1.7
// verifies its schema on the first request and fails every request (500)
// when tables are missing, so routes need them even when they never use auth.
// applyD1Migrations skips migrations that are already applied.
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.AUTH_DB, env.TEST_AUTH_MIGRATIONS);
