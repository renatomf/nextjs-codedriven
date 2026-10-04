-- ADR-007, step 3b (contract): nothing reads the legacy GitHub OAuth token
-- since step 3a, and migration 0012 already cleared it. Apply only after
-- the step 3a code is in production.
ALTER TABLE "users" DROP COLUMN "github_access_token";
