import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { chunkProjectFiles } from "@/lib/analysis/chunking";
import { runLlmHealthReview } from "@/lib/analysis/report-llm";
import { REVIEW_PROMPT_VERSION, type IssueCategory } from "@/modules/analysis";

import { loadRepo, REPO_CASES } from "../repos/repos";
import { LLM_CASES } from "./cases";
import { assertEvalKey, describeError, sleep } from "./provider";

// LLM review eval (opt-in: real model, uses the free Groq quota):
//   RUN_LLM_EVAL=1 npm run eval
// Each case runs LLM_EVAL_RUNS times (default 3) to measure stability too.
// Calls are spaced out to stay under the free tier's tokens per minute.
// Cases: the synthetic ones (./cases) and the real repositories
// (../repos), downloaded once into evals/.cache.

const enabled = process.env.RUN_LLM_EVAL === "1";
const RUNS = Number(process.env.LLM_EVAL_RUNS ?? 3);
const PAUSE_MS = Number(process.env.LLM_EVAL_PAUSE_MS ?? 20_000);
// Comma-separated case names, to spend less of the daily quota (e.g. nodegoat).
const ONLY = process.env.LLM_EVAL_CASES?.split(",").map((name) => name.trim());

type Expected = { categories: IssueCategory[]; filePath: string; lines?: number[]; note?: string };
type Forbidden = { filePath?: string; pattern: RegExp; note: string };
type EvalCase = {
  name: string;
  files: { relativePath: string; content: string }[];
  expected: Expected[];
  forbidden?: Forbidden[];
};

const key = (category: string, filePath: string | null) => `${category}:${filePath ?? "-"}`;

function jaccard(a: Set<string>, b: Set<string>) {
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 1;
  return [...a].filter((item) => b.has(item)).length / union.size;
}

async function allCases(): Promise<EvalCase[]> {
  const synthetic = LLM_CASES.map((c) => ({
    name: c.name,
    files: c.files,
    expected: c.expected.map((e) => ({ categories: [e.category], filePath: e.filePath })),
    forbidden: c.forbidden,
  }));
  const repos = await Promise.all(
    REPO_CASES.filter((c) => !ONLY || ONLY.includes(c.name)).map(async (c) => ({ name: c.name, files: await loadRepo(c), expected: c.expected })),
  );
  const all = [...synthetic, ...repos];
  const selected = ONLY ? all.filter((c) => ONLY.includes(c.name)) : all;
  if (selected.length === 0) throw new Error(`No eval case named ${ONLY?.join(", ")}`);
  return selected;
}

it.skipIf(!enabled)(
  "measures the LLM review",
  async () => {
    assertEvalKey();
    const evalCases = await allCases();
    const cases = [];
    let first = true;

    for (const evalCase of evalCases) {
      // Same order the report uses: by file, then by line.
      const chunks = chunkProjectFiles(evalCase.files).sort(
        (a, b) =>
          a.filePath.localeCompare(b.filePath) || (a.startLine ?? 0) - (b.startLine ?? 0),
      );
      const runs: Array<{
        latencyMs: number;
        usage: { inputTokens?: number; outputTokens?: number };
        droppedUnverified: number;
        expected: Array<{ sent: boolean; found: boolean }>;
        expectedSent: number;
        issues: unknown[];
        forbiddenFound: Array<{ note: string; title: string }>;
        recall: number;
        evidenceValidity: number;
        sentFiles: number;
        keys: string[];
      }> = [];
      const failures: Array<{ error: string; responseBody?: string }> = [];

      for (let run = 0; run < RUNS; run += 1) {
        if (!first) await sleep(PAUSE_MS);
        first = false;
        const started = Date.now();
        let review: Awaited<ReturnType<typeof runLlmHealthReview>>;
        try {
          review = await runLlmHealthReview({
            projectName: evalCase.name,
            framework: null,
            chunks,
          });
        } catch (error) {
          // A failed call is a result too (reliability), not the end of the eval.
          failures.push(describeError(error));
          continue;
        }
        const found = new Set(review.issues.map((issue) => key(issue.category, issue.filePath)));
        const withFile = review.issues.filter((issue) => issue.filePath);
        // Sampling, apart from the model: the reviewer received the expected
        // file (and, when annotated, the chunk holding the vulnerable line).
        const sent = (e: Expected) =>
          review.sentRanges.some(
            (range) =>
              range.filePath === e.filePath &&
              (e.lines === undefined ||
                e.lines.some(
                  (line) => (range.startLine ?? 0) <= line && line <= (range.endLine ?? 0),
                )),
          );
        const isFound = (e: Expected) => e.categories.some((c) => found.has(key(c, e.filePath)));
        // A case with nothing expected only checks what must not appear.
        const share = (matching: number) =>
          evalCase.expected.length === 0 ? 1 : matching / evalCase.expected.length;
        const forbiddenFound = (evalCase.forbidden ?? []).flatMap((rule) =>
          review.issues
            .filter(
              (issue) =>
                (rule.filePath === undefined || issue.filePath === rule.filePath) &&
                rule.pattern.test(`${issue.title} ${issue.description}`),
            )
            .map((issue) => ({ note: rule.note, title: issue.title })),
        );

        runs.push({
          latencyMs: Date.now() - started,
          usage: review.usage,
          droppedUnverified: review.droppedUnverified,
          expected: evalCase.expected.map((e) => ({ sent: sent(e), found: isFound(e) })),
          expectedSent: share(evalCase.expected.filter(sent).length),
          issues: review.issues.map(({ title, severity, category, filePath, evidence }) => ({
            title,
            severity,
            category,
            filePath,
            lines: evidence ? [evidence.startLine, evidence.endLine] : null,
          })),
          recall: share(evalCase.expected.filter(isFound).length),
          forbiddenFound,
          // A cited file the model never saw is a hallucination.
          evidenceValidity:
            withFile.length === 0
              ? 1
              : withFile.filter((issue) => review.sentFilePaths.includes(issue.filePath!)).length /
                withFile.length,
          sentFiles: review.sentFilePaths.length,
          keys: [...found],
        });
      }

      const sets = runs.map((run) => new Set(run.keys));
      const pairs: number[] = [];
      for (let i = 0; i < sets.length; i += 1) {
        for (let j = i + 1; j < sets.length; j += 1) pairs.push(jaccard(sets[i], sets[j]));
      }
      // No successful run (or, for stability, fewer than 2): no number, not a perfect one.
      const mean = (values: number[]) =>
        values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length;
      const round = (value: number | null) => (value === null ? null : Math.round(value));

      cases.push({
        name: evalCase.name,
        sourceFiles: evalCase.files.length,
        chunks: chunks.length,
        runs: runs.length,
        failedRuns: failures.length,
        meanExpectedSent: mean(runs.map((r) => r.expectedSent)),
        meanRecall: mean(runs.map((r) => r.recall)),
        minRecall: runs.length === 0 ? null : Math.min(...runs.map((r) => r.recall)),
        meanEvidenceValidity: mean(runs.map((r) => r.evidenceValidity)),
        stability: mean(pairs),
        meanFindings: mean(runs.map((r) => r.issues.length)),
        maxForbiddenFound: runs.length === 0 ? null : Math.max(...runs.map((r) => r.forbiddenFound.length)),
        meanDroppedUnverified: mean(runs.map((r) => r.droppedUnverified)),
        meanLatencyMs: round(mean(runs.map((r) => r.latencyMs))),
        meanInputTokens: round(mean(runs.map((r) => r.usage.inputTokens ?? 0))),
        meanOutputTokens: round(mean(runs.map((r) => r.usage.outputTokens ?? 0))),
        // Per expected problem: share of runs in which it was sent / found.
        perExpected: evalCase.expected.map((e, index) => ({
          filePath: e.filePath,
          lines: e.lines ?? null,
          note: e.note ?? null,
          sentRate: mean(runs.map((r) => (r.expected[index].sent ? 1 : 0))),
          foundRate: mean(runs.map((r) => (r.expected[index].found ? 1 : 0))),
        })),
        runDetails: runs,
        failures,
      });
    }

    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim();
    const date = new Date().toISOString();
    const result = {
      date,
      commit,
      model: process.env.GROQ_STRUCTURED_MODEL ?? "openai/gpt-oss-120b",
      // Which prompt text was measured (evals/prompts.lock.json points here).
      promptVersions: { review: REVIEW_PROMPT_VERSION },
      llm: { cases },
    };
    const dir = join(process.cwd(), "evals", "results");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${date.slice(0, 10)}-${commit}-llm.json`);
    writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);

    const fmt = (value: number | null, digits = 2) => (value === null ? "n/a" : value.toFixed(digits));
    console.log(
      [
        `llm eval @ ${commit} (${result.model}) → ${file}`,
        ...cases.map(
          (c) =>
            `  ${c.name}: ${c.runs} ok, ${c.failedRuns} failed; sent ${fmt(c.meanExpectedSent)}, recall ${fmt(c.meanRecall)} (min ${fmt(c.minRecall)}), ` +
            `evidence ${fmt(c.meanEvidenceValidity)}, stability ${fmt(c.stability)}, ` +
            `${fmt(c.meanFindings, 1)} findings (${fmt(c.meanDroppedUnverified, 1)} dropped), ${c.meanLatencyMs ?? "n/a"} ms, ${c.meanInputTokens ?? "n/a"}+${c.meanOutputTokens ?? "n/a"} tokens` +
            (c.maxForbiddenFound ? `, FORBIDDEN ${c.maxForbiddenFound}` : "") +
            // Why calls failed (masked; never the key), so a failure is diagnosable from the log.
            (c.failures.length ? `; first failure: ${c.failures[0].error.slice(0, 300)}` : ""),
        ),
      ].join("\n"),
    );

    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) {
      appendFileSync(
        summary,
        [
          `## LLM review eval @ \`${commit}\` (${result.model}, prompt ${REVIEW_PROMPT_VERSION})`,
          "",
          "| Case | Runs ok / failed | Expected problems found (worst run) | Evidence valid |",
          "|---|---|---|---|",
          ...cases.map((c, i) => {
            const found = foundPerRun(c.runDetails);
            const total = evalCases[i].expected.length;
            return `| ${c.name} | ${c.runs} / ${c.failedRuns} | ${found.length ? Math.min(...found) : "n/a"}/${total} (gate ≥ ${LLM_GATE.minFound[c.name] ?? total}) | ${fmt(c.meanEvidenceValidity)} |`;
          }),
          "",
        ].join("\n"),
      );
    }

    expect(cases).toHaveLength(evalCases.length);
    // Quality gate (also in CI): every case measured, cited files real, and
    // in every run at least as many expected problems found as the baseline.
    cases.forEach((c, i) => {
      expect(c.runs, `${c.name}: no successful run`).toBeGreaterThan(0);
      expect(c.meanEvidenceValidity, `${c.name}: cited a file it never received`).toBe(1);
      expect(c.maxForbiddenFound, `${c.name}: reported a forbidden finding (a known false positive)`).toBe(0);
      const worst = Math.min(...foundPerRun(c.runDetails));
      expect(worst, `${c.name}: expected problems found`).toBeGreaterThanOrEqual(
        LLM_GATE.minFound[c.name] ?? evalCases[i].expected.length,
      );
    });
  },
  30 * 60_000,
);

const foundPerRun = (runs: Array<{ expected: Array<{ found: boolean }> }>) =>
  runs.map((run) => run.expected.filter((e) => e.found).length);

/**
 * Expected problems found in the worst run: every one for the synthetic
 * cases; for the real repositories, the baseline of 2026-09-30 (`d7c5284`,
 * 3 runs: NodeGoat 6-7 of 9, Juice Shop 1-2 of 8), limited by what reaches
 * the review sample. Raise when an improvement is merged, never lower.
 */
const LLM_GATE = { minFound: { nodegoat: 6, "juice-shop": 1 } as Record<string, number> };
