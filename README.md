# codedriven

An AI senior-developer assistant for JavaScript/TypeScript codebases: import a
repository from GitHub (or upload a ZIP) and get a health report, a
prioritized list of issues, a code explorer that explains any file, and a chat
grounded in the real code (RAG).

> **Status:** v2 in progress. v1 (tag `v1-tutorial`) is a finished tutorial
> project; v2 evolves it into a production-grade, well-tested codebase with a
> modular architecture. Plan and progress: [docs/roadmap-v2.md](docs/roadmap-v2.md).
> The current health score is known to be noisy — see
> [docs/baseline.md](docs/baseline.md).

**Live demo report** (no sign-up): [a real health report, shared through a
public read-only link](https://nextjs-codedriven.vercel.app/r/dEVSu6Ax3931oUeMuQ8aBd-maFvYFt0vE3-WX2yHRpw). It shows the report only — never the source
code — with secrets redacted.

## Dogfooding

The analyzer measures itself: every pull request runs the analysis eval on
this repository and on two deliberately vulnerable open-source apps (OWASP
NodeGoat and Juice Shop), and fails if the analysis gets worse
([evals/README.md](evals/README.md)).

![This repository's deterministic health score in every committed eval result](docs/assets/dogfooding.svg)

The **deterministic** score leaves the LLM's categories (architecture,
performance) at their base value, so it is comparable across results. The
dashed line is the same measure under the v1 formula: the first jump (53 →
64) is the new scoring formula ([ADR-010](docs/decisions/010-score-formula.md)),
the next (64 → 68, with v1 53 → 60) is the analysis getting more accurate
(heuristic false positives fixed). A full report from before v2 scored this
repository 30/100, mostly on false positives ([baseline](docs/baseline.md)).
Regenerate with `npm run eval:chart` when a new result is committed.

## Features

- **Import** a GitHub repository (OAuth) or a ZIP upload, with hardened
  extraction (zip-slip, symlinks, zip bombs, secret files never read).
- **Health report:** deterministic metrics plus an LLM review, scored by
  category (architecture, security, performance, code quality, testing).
- **Issues dashboard** with filters, and a **code explorer** with per-file
  AI explanations.
- **Chat with the codebase:** Tree-sitter chunking, local embeddings
  (MiniLM) in pgvector, answers streamed with their sources.
- **Plans and billing** with Stripe Checkout and a signed webhook.
- **Public report links:** share a read-only report (revocable, optional
  expiry, only a hash of the token stored, not indexed by search engines).

## Tech stack

| Area | Choice |
|---|---|
| App | Next.js 16 (App Router, Server Actions), React 19, TypeScript |
| UI | Tailwind CSS 4, shadcn/ui (Base UI) |
| Auth | Auth.js (NextAuth v5): email/password, GitHub, Google |
| Data | Neon Postgres + pgvector, Drizzle ORM |
| AI | AI SDK 7 + Groq (LLM); `@huggingface/transformers` + ONNX (embeddings) |
| Code parsing | Tree-sitter (JS/TS/TSX) |
| Billing | Stripe |
| Tests | Vitest (unit + integration on real Postgres), Playwright (E2E) |
| Delivery | Vercel, GitHub Actions |

Architecture (C4 diagrams, flows, coupling map):
[docs/architecture.md](docs/architecture.md).

## Getting started

**Prerequisites:** Node.js 24, npm, and a Postgres 16+ database with the
`pgvector` extension (a free [Neon](https://neon.tech) project works).

```bash
npm ci
cp .env.example .env.local   # then fill in the values (see below)
DATABASE_URL_UNPOOLED="<direct connection string>" npm run db:migrate
npm run dev                  # http://localhost:3000
```

> Use a **development database** (for example a Neon branch), never the
> production one: migrations and local data go wherever `.env.local` points.
> See [docs/runbooks/migrations.md](docs/runbooks/migrations.md).

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection (pooled) used by the app |
| `DATABASE_URL_UNPOOLED` | for migrations | Direct connection used by `drizzle-kit` |
| `AUTH_SECRET` | yes | Auth.js session signing (`npx auth secret`) |
| `AUTH_URL` | production | Public URL of the app |
| `GROQ_API_KEY` | yes | LLM for reports, chat and explanations (free tier) |
| `GROQ_MODEL`, `GROQ_STRUCTURED_MODEL` | no | Override the default model |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | for GitHub login | OAuth sign-in (profile and email only) |
| `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG` | for repository import | Read-only GitHub App, one per environment ([runbook](docs/runbooks/github-app.md)) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | for Google | OAuth login |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_PREMIUM`, `STRIPE_WEBHOOK_SECRET` | for billing | Checkout and the signed webhook |
| `NEXT_PUBLIC_APP_URL` | no | Fallback public URL (Stripe return URLs) |
| `PLAN_FREE_*`, `PLAN_PREMIUM_*`, `NEXT_PUBLIC_PLAN_PREMIUM_*` | no | Override plan limits and labels |

## Scripts and tests

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js dev server, production build, production server |
| `npm run lint` / `typecheck` | ESLint; Next route types + `tsc` |
| `npm test` | Unit tests (Vitest) |
| `npm run test:integration` | Integration tests on a **local, disposable** Postgres (refuses remote hosts) |
| `npm run test:e2e` | Playwright; the full-flow test needs the CI setup (fake LLM, fresh DB) |
| `npm run db:generate` / `db:migrate` / `db:studio` | Drizzle migrations and studio |
| `npm run eval` / `eval:chart` | Analysis and chat retrieval evals with quality gates ([evals/README.md](evals/README.md)); the dogfooding chart |

Integration tests locally (Docker):

```bash
docker run -d --rm --name it-pg -e POSTGRES_USER=app -e POSTGRES_PASSWORD=app \
  -e POSTGRES_DB=app -p 5432:5432 pgvector/pgvector:0.8.6-pg18
DATABASE_URL="postgresql://app:app@localhost:5432/app" npm run test:integration
```

Every pull request runs lint, typecheck, a schema-vs-migrations check,
unit tests, the build, integration tests, the E2E main flow, the analysis
eval with its quality gates and a dependency vulnerability scan (OSV).

## Security highlights

- Session checked on the server in every page, action and route; every data
  query scoped by the session's user id — tenant isolation is tested against
  a real database.
- GitHub tokens encrypted with AES-256-GCM (bound to their owner); signed,
  expiring OAuth state.
- Postgres-backed rate limiting (login, registration, chat, analysis,
  billing); generic error messages; private code served with `no-store`.
- Signed Stripe webhook; previews run on an isolated, schema-only database
  with their own secrets.

Known gaps are tracked openly in [docs/technical-debt.md](docs/technical-debt.md).

## Origin

Built from the tutorial
[AliSadeghi-dev/AI-Code-Analyzer](https://github.com/AliSadeghi-dev/AI-Code-Analyzer),
adapted from Prisma to **Drizzle ORM + Neon**, with a security layer added on
top of the original (tokens encryption, hardened ZIP extraction, rate
limiting, tenant isolation, previews isolation) and the test and CI safety
net of v2.

## Documentation

- [Roadmap v2](docs/roadmap-v2.md) — phases, scope and exit criteria
- [Architecture](docs/architecture.md) — how the system works today
- [Baseline](docs/baseline.md) — measured "before" of the v2 refactoring
- [Technical debt](docs/technical-debt.md) — known issues and their plan
- [Migrations runbook](docs/runbooks/migrations.md)
