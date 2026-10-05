# Evals

Measure the analysis before changing it (roadmap Phase 7): every change to
the heuristics, the score, the prompts or the retrieval shows its effect as a
number, before × after.

```bash
npm run eval   # writes evals/results/<date>-<commit>.json and prints a summary
```

No LLM, no network and no cost so far: this part measures the deterministic
analysis.

## What is measured

**Annotated cases** ([analysis/cases.ts](analysis/cases.ts)): small synthetic
projects whose every expected finding is listed, so anything else they
produce is a false positive.

| Case | Purpose |
|---|---|
| `well-tested-lib` | healthy project: nothing should be flagged |
| `planted-problems` | one real problem per heuristic: recall |
| `false-positive-traps` | known traps (long JSX component, an icon path containing "auth", UI copy with "token") and the Phase 3 fixes as regression guards: precision |

Per case and in total: **precision** (found findings that were expected),
**recall** (expected findings that were found), the false positives and the
missed ones. A finding matches an expectation by category, file and title;
each expectation matches once.

**This repository**, read like a GitHub import (the committed tree through the
real extractor): number of findings per rule, the deterministic category
scores and what the LLM reviewer would see of it (files, directories and
test files in the review sample). There is no full ground truth here; it tracks the dogfooding trend.

**Real repositories** ([repos/repos.ts](repos/repos.ts)): open-source
projects with known problems, annotated by file and line, pinned to a
commit and read like a GitHub import. The source is downloaded once into
`evals/.cache/` (git-ignored) and never committed. Today:

- OWASP NodeGoat (Apache-2.0, Express): 9 active vulnerabilities (the fixes
  it keeps commented out do not count).
- OWASP Juice Shop (MIT, TypeScript, Express + Angular): 8 files with
  vulnerable lines, taken from the project's own `vuln-code-snippet
  vuln-line` markers. The markers name the flaw, so the loader strips them
  (the comment only; line numbers stay) before the analysis. Reported without an LLM: files, chunks, deterministic findings
and how many annotated lines reach the reviewer's sample (the model can
only report what it receives). NodeGoat comments its own flaws, so its LLM
recall is an upper bound.

## Chat retrieval

[retrieval/questions.ts](retrieval/questions.ts): 21 questions a user would
ask about NodeGoat, Juice Shop and this repository, each with the files that
answer it, written before the first measurement (a change to the retriever
must not edit them to pass). Same chunking and local embedding model as
production; the search is the exact cosine top-k that pgvector runs today.
Per repository: **recall@k** (questions with an expected file in the chat's
context), **hit@1** and **MRR**. The questions file itself is left out of
this repository's corpus (it would answer every question). Results:
`evals/results/<date>-<commit>-retrieval.json`. No LLM: it runs in CI with
the rest.

## Chat groundedness (opt-in)

[chat/chat.eval.ts](chat/chat.eval.ts) runs the chat as production does
(same retrieval, prompt and model) on the first 3 retrieval questions of
each repository plus one it cannot answer (GraphQL in NodeGoat, Kafka in
Juice Shop, Twilio here: absent from each, checked by search). No second
model judges the answers; deterministic checks
([chat/grounding.ts](chat/grounding.ts), tested):

- **citation validity**: files the answer cites must be among the snippets
  it received;
- **cites the answer**: when an expected file was retrieved, the answer
  cites it;
- **abstention**: on the unanswerable question, the answer says the sources
  fall short.

Runs with the LLM review (`RUN_LLM_EVAL=1`); results:
`evals/results/<date>-<commit>-chat.json`, answers included for review.

## LLM review (opt-in)

```bash
RUN_LLM_EVAL=1 npm run eval   # real model, free Groq quota, about 10 minutes
RUN_LLM_EVAL=1 LLM_EVAL_CASES=nodegoat npm run eval   # only some cases
```

Quota: Groq's free tier allows 200,000 tokens per day per organization
(gpt-oss-120b), and a full run uses about 60,000 of them. The limit is the
organization's, not the key's: evals run with the production key would
compete with real analyses. So the eval never uses it: it reads only
`GROQ_EVAL_API_KEY` (a key from a separate Groq account, in `.env.local` or
a CI secret) and refuses to run without it, whatever `GROQ_API_KEY` holds.
Failed calls are recorded (with the organization id masked), and a case
without successful runs reports `null`, not a perfect score.

Cases in [llm/cases.ts](llm/cases.ts): planted problems a reviewer should
find (SQL built from input, a delete route without authorization, N+1 and
sync file reads), the same code with a comment that tries to steer the
reviewer (prompt injection, TD-28), and the problem files behind 30
harmless files that come first in alphabetical order (the review sample
must reach them). Each case runs `LLM_EVAL_RUNS` times
(default 3), spaced out for the free tier's tokens per minute. Per case:
**recall** (category + file), **evidence validity** (cited files the model
actually received), **stability** (overlap between runs), number of
findings, **expected files sent** (the sample, apart from the model),
findings dropped because their quote was not in the cited file
(`verifyEvidence`), failed calls (kept with the provider's response, not
fatal), latency and tokens. Only the `GROQ_*` variables are read from the
local env files. Results: `evals/results/<date>-<commit>-llm.json`.

## In CI

The `eval` job runs `npm run eval` on every pull request: the deterministic
part only (no LLM, no cost, no secret). The numbers go to the job summary,
and the run fails if a change makes the analysis worse (`GATE` in
[analysis/analysis.eval.ts](analysis/analysis.eval.ts)):

- annotated cases: precision and recall stay at 1.00;
- deterministic Architecture (import graph, ADR-013): Juice Shop scores
  below this repository;
- real repositories: at least as many annotated vulnerable lines in the LLM
  review sample as the last improvement reached (NodeGoat: 5 of 9; Juice
  Shop: 2 of 8);
- Code Quality ranks this repository, NodeGoat and Juice Shop as ESLint's
  `max-lines-per-function` does (share of functions over 50 lines; TD-50);
- every repository's review request stays at or under
  `REVIEW_MAX_REQUEST_TOKENS` (7500 estimated): one request above Groq's
  8000 tokens per minute always fails;
- chat retrieval: at least as many questions answered in the top k
  (`GATE` in [retrieval/retrieval.eval.ts](retrieval/retrieval.eval.ts)).

Raise a limit when an improvement is merged; never lower one to make a
change pass.

The **LLM eval** workflow runs the LLM review against the real model (one
run per case, with the `GROQ_EVAL_API_KEY` secret) only when a pull request
from this repository changes what the model receives or how its answer is
read: the review prompt and sampling, chunking, how repositories are read,
the model setup or the eval (not the deterministic metrics and scores). It
fails if a case has no successful run, a finding cites a file the model
never received, fewer expected problems are found than one run can be
expected to find (`LLM_GATE` in [llm/llm.eval.ts](llm/llm.eval.ts): every
one in the synthetic cases, NodeGoat 5 of 9, Juice Shop 1 of 8; the
recorded single runs are listed there, TD-44), or a **forbidden** finding
shows up: a known false positive listed in the case, for a file or
project-wide. A case stopped by the eval account's Groq rate limit fails as
**not measured**, apart from the quality checks: re-run the job once the
quota frees up (about 4 full runs fit in a day). The result file is kept as
the run's `llm-eval-result` artifact. It is not a required check: it does not run on every pull
request. Strategy: [ADR-009](../docs/decisions/009-evals.md).

## Prompts

The LLM prompts live in their own modules (`REVIEW_PROMPT`, `CHAT_PROMPT`,
`EXPLAIN_PROMPT`); a prompt's version is a hash of its fixed text.
[prompts.lock.json](prompts.lock.json) records each version with the eval
result that measured it, and CI fails when a prompt changes without the
lock ([prompts/prompts.test.ts](prompts/prompts.test.ts)): CI has no LLM
key, so the author runs the eval and commits the result. To change a
prompt:

1. edit it, and run `RUN_LLM_EVAL=1 npm run eval` (the result records
   `promptVersions`);
2. compare with the result the lock points to;
3. commit the result, and set the new version and that file in the lock.

## Rules

- Files in the cases are built at runtime: fake credentials never appear as
  key-shaped literals (GitHub secret scanning).
- Result files are committed when they mark a milestone (the Phase 7
  baseline, each improvement's before × after).
