@AGENTS.md

# Project context
- v1 (the tutorial https://github.com/AliSadeghi-dev/AI-Code-Analyzer, adapted from Prisma to Drizzle ORM + Neon Postgres) is finished and frozen at tag `v1-tutorial`. The original is now only a reference, not a spec.
- v2 follows `docs/roadmap-v2.md`, one phase at a time, within its closed scope. Before starting work, check the current phase and its checklist; mark items done and keep `docs/technical-debt.md` (TD-xx) up to date in the same PR.
- Roadmap rules apply to every change: no refactoring without a test net; one module at a time (strangler); Clean Architecture/DDD only where there is business logic; a port/interface only when there are 2+ implementations or a test needs a fake; measure before optimizing (numbers only with date and method, see `docs/baseline.md`). Every new abstraction must be justified by the roadmap or an ADR in `docs/decisions/` — no speculative layers (no overengineering). Minimal never means skipping security.

# Security (always, in every change)
- Always apply security best practices for auth (NextAuth v5) and Postgres/Neon (verified TLS, parameterized queries, no secrets in plain text, least privilege).
- Always apply security best practices for API routes and server actions: check the session on the server in every handler, scope every query by the session's userId (no IDOR), validate all input with zod, return generic error messages (no stack traces or internals), rate-limit expensive endpoints, verify webhook signatures, and never trust client-sent ids/prices/plans.
- Never put business or security rules only in the frontend. Every rule (auth, permissions, plan limits, validation, pricing) must be enforced on the server; client-side checks are UX only and always duplicated on the backend.
- Use Drizzle for all data access (`@/lib/db`, schema in `@/db/schema`); never use `sql.raw` or string-built SQL with user input.
- Test-only switches (e.g. `E2E_FAKE_LLM`, `DATABASE_SSL=disable`) must require an explicit flag and fail loudly outside their environment.

# Workflow
- Work on a branch and open a PR; `main` requires the CI checks (lint/typecheck/tests/build, integration, E2E, OSV). PR titles use conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `ci:`).
- Schema changes: `npm run db:generate`, review the SQL, commit `drizzle/`; apply to the `preview` branch, then production — see `docs/runbooks/migrations.md`. Never run migrations or tests against production by accident: `.env.local` may point to the production database.
- Integration tests only against a local, disposable Postgres (the setup refuses remote hosts).
- Vercel env vars: to give an environment its own value, uncheck it on the shared variable and create a new one with *Add New* — editing a shared variable changes every environment it has (see TD-36).

# UI
- The codedriven layout: `ca-*` classes and `--ca-*` tokens in `globals.css`, and the shadcn components in `src/components/ui/` (restyled; Button has an extra `night` variant and `bar` prop). Page shell: `landing-shell ca-guides` + `ca-container` (see `dashboard/page.tsx`).
- Components folders: `src/components/ui/` holds only shadcn components; project components reused by more than one screen go in `src/components/shared/` (e.g. `confirm-dialog.tsx`, `action-alert.tsx`, `hero-silk.tsx`); screen/feature-specific ones stay in their feature folder (`projects/`, `billing/`, ...).

# Pending reminders (tracked in the roadmap)
- Analysis-quality fixes (score caps, grouping repeated findings, chunk sampling, LLM evidence, heuristic false positives): roadmap Phase 7 and TD-31.
- v2.1 = score calibration (TD-50) and the remaining LLM false positives (TD-51): roadmap section "v2.1 — Calibração das notas", one item at a time, each with the eval's before × after.
