-- Distinguish sessions issued by the retired bearer credential. Such sessions
-- stop authorizing immediately when a passkey exists, even across racing logins.
ALTER TABLE "session" ADD COLUMN "legacyEnrollment" INTEGER NOT NULL DEFAULT 0;
