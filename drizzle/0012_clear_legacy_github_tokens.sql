-- ADR-007, step 3a: repository access is the read-only GitHub App's; the
-- legacy OAuth tokens (repo scope, write access) are no longer read. Clear
-- them. Data only: the column is dropped in a later migration (contract).
UPDATE "users" SET "github_access_token" = NULL WHERE "github_access_token" IS NOT NULL;
