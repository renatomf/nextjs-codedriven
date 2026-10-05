import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import tsParser from "@typescript-eslint/parser";
import { ESLint } from "eslint";
import { expect, it } from "vitest";

import { chunkProjectFiles } from "@/lib/analysis/chunking";
import { buildReviewRequest } from "@/lib/analysis/report-llm";
import { computeProjectMetrics, type DeterministicMetrics, type SourceFile } from "@/lib/analysis/metrics";
import {
  buildReportFindings,
  diminishingPenaltyPolicy,
  linearPenaltyPolicy,
  LONG_FUNCTION_LINES,
  estimateRequestTokens,
  REVIEW_BUDGET,
  REVIEW_MAX_REQUEST_TOKENS,
  sampleForReview,
} from "@/modules/analysis";
import { isTestFile } from "@/modules/analysis/domain/paths";

import { loadRepo, loadThisRepository, REPO_CASES, type RepoCase } from "../repos/repos";
import { ANALYSIS_CASES } from "./cases";
import { scoreCase } from "./score";

// Deterministic analysis eval (no LLM, no cost): the annotated cases give
// precision and recall; this repository, read exactly like a GitHub import
// (the committed tree through the real extractor), gives the findings and
// the deterministic scores to follow over time. `npm run eval` writes the
// result to evals/results/<date>-<commit>.json.

const git = (...args: string[]) => execFileSync("git", args, { maxBuffer: 256 * 1024 * 1024 });

// ESLint's `max-lines-per-function` with max 0 reports every function with
// its length: the reference the Code Quality score is calibrated against
// (TD-50). Files ESLint cannot parse are left out of its count.
const eslint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ["**/*.{js,jsx,ts,tsx}"],
      languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
      rules: { "max-lines-per-function": ["error", { max: 0, IIFEs: true }] },
    },
  ],
});

async function eslintLongFunctionPercent(files: SourceFile[]): Promise<number> {
  let functions = 0;
  let long = 0;
  for (const file of files.filter((f) => !isTestFile(f.relativePath))) {
    const [result] = await eslint.lintText(file.content, { filePath: file.relativePath });
    if (result.messages.some((m) => m.fatal)) continue;
    for (const message of result.messages) {
      const lines = Number(message.message.match(/too many lines \((\d+)\)/)?.[1]);
      if (!lines) continue;
      functions += 1;
      if (lines > LONG_FUNCTION_LINES) long += 1;
    }
  }
  return functions === 0 ? 0 : round1((100 * long) / functions);
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/** The deterministic Code Quality score next to its reference (TD-50). */
async function codeQuality(files: SourceFile[], metrics: DeterministicMetrics) {
  const { categoryScores } = diminishingPenaltyPolicy({
    measures: metrics,
    findings: buildReportFindings(metrics.issues, []),
  });
  return {
    score: categoryScores.codeQuality,
    functions: metrics.functionCount,
    longFunctionPercent: metrics.functionCount === 0 ? 0 : round1((100 * metrics.longFunctionCount) / metrics.functionCount),
    eslintLongFunctionPercent: await eslintLongFunctionPercent(files),
  };
}

/**
 * A real repository with annotated problems, read like a GitHub import:
 * what the deterministic analysis finds and which annotated lines reach the
 * LLM reviewer's sample (the model can only report what it receives).
 */
/** Estimated tokens of the review request for a sample (TD-50 item 2). */
const requestTokens = (projectName: string, sample: ReturnType<typeof chunkProjectFiles>) =>
  estimateRequestTokens(buildReviewRequest({ projectName, framework: null, chunks: [] }, sample));

async function realRepository(repoCase: RepoCase) {
  const files = await loadRepo(repoCase);
  const metrics = computeProjectMetrics(files);
  const chunks = chunkProjectFiles(files).sort(
    (a, b) => a.filePath.localeCompare(b.filePath) || (a.startLine ?? 0) - (b.startLine ?? 0),
  );
  const sample = sampleForReview(chunks);
  const byRule: Record<string, number> = {};
  for (const finding of metrics.issues) {
    const rule = finding.title.replace(/ \(.*\)$/, "").replace(/^Complex function .*/, "Complex function");
    byRule[rule] = (byRule[rule] ?? 0) + 1;
  }
  const expected = repoCase.expected.map((e) => ({
    filePath: e.filePath,
    lines: e.lines,
    inSample: sample.some(
      (c) =>
        c.filePath === e.filePath &&
        e.lines.some((line) => (c.startLine ?? 0) <= line && line <= (c.endLine ?? 0)),
    ),
  }));

  return {
    name: repoCase.name,
    commit: repoCase.commit,
    sourceFiles: files.length,
    chunks: chunks.length,
    findings: metrics.issues.length,
    findingsByRule: byRule,
    reviewSample: {
      chunks: sample.length,
      files: new Set(sample.map((c) => c.filePath)).size,
      requestTokens: requestTokens(repoCase.name, sample),
      filePaths: [...new Set(sample.map((c) => c.filePath))],
    },
    expectedInSample: expected.filter((e) => e.inSample).length,
    expectedTotal: expected.length,
    expected,
    codeQuality: await codeQuality(files, metrics),
    issues: metrics.issues.map(({ title, severity, category, filePath }) => ({
      title,
      severity,
      category,
      filePath,
    })),
  };
}

async function thisRepository() {
  const files = await loadThisRepository();

  const metrics = computeProjectMetrics(files);
  // As the report shows them: grouped (ADR-010).
  const findings = buildReportFindings(metrics.issues, []);
  const current = diminishingPenaltyPolicy({ measures: metrics, findings });
  const v1 = linearPenaltyPolicy({ measures: metrics, findings: metrics.issues });
  const byTitle: Record<string, number> = {};
  for (const finding of metrics.issues) {
    const rule = finding.title.replace(/ \(.*\)$/, "").replace(/^Complex function .*/, "Complex function");
    byTitle[rule] = (byTitle[rule] ?? 0) + 1;
  }
  // What the LLM reviewer would see of this repository (roadmap Phase 7
  // item 2): chunks in the order the report reads them, then the sampler.
  const chunks = chunkProjectFiles(files).sort(
    (a, b) => a.filePath.localeCompare(b.filePath) || (a.startLine ?? 0) - (b.startLine ?? 0),
  );
  const sample = sampleForReview(chunks);
  const sampledFiles = [...new Set(sample.map((chunk) => chunk.filePath))];
  const directory = (filePath: string) => filePath.slice(0, filePath.lastIndexOf("/") + 1);

  return {
    sourceFiles: files.length,
    reviewSample: {
      chunks: sample.length,
      chars: sample.reduce((sum, c) => sum + Math.min(c.content.length, REVIEW_BUDGET.chunkChars), 0),
      requestTokens: requestTokens("nextjs-codedriven", sample),
      files: sampledFiles.length,
      directories: new Set(sampledFiles.map(directory)).size,
      testFiles: sampledFiles.filter((f) => /\.(test|spec)\.|(^|\/)(e2e|tests?|__tests__)\//.test(f)).length,
      filePaths: sampledFiles,
    },
    findings: metrics.issues.length,
    reportFindings: findings.length,
    findingsByRule: byTitle,
    // Deterministic part only: architecture and performance come from the
    // LLM in the product, so here they stay at their base score. `v1` is the
    // linear policy, kept for comparison.
    codeQuality: await codeQuality(files, metrics),
    deterministicCategoryScores: current.categoryScores,
    deterministicHealthScore: current.healthScore,
    v1DeterministicCategoryScores: v1.categoryScores,
    v1DeterministicHealthScore: v1.healthScore,
    issues: metrics.issues.map(({ title, severity, category, filePath }) => ({
      title,
      severity,
      category,
      filePath,
    })),
  };
}

it("measures the deterministic analysis", async () => {
  const cases = ANALYSIS_CASES.map((evalCase) => {
    const findings = buildReportFindings(computeProjectMetrics(evalCase.files).issues, []);
    const score = scoreCase(findings, evalCase.expected);
    return {
      name: evalCase.name,
      expected: evalCase.expected.length,
      found: findings.length,
      truePositives: score.truePositives,
      precision: score.precision,
      recall: score.recall,
      falsePositives: score.falsePositives.map(({ title, filePath }) => ({ title, filePath })),
      missed: score.missed.map(({ title, filePath }) => ({ title: title.source, filePath })),
    };
  });

  const tp = cases.reduce((sum, c) => sum + c.truePositives, 0);
  const fp = cases.reduce((sum, c) => sum + c.falsePositives.length, 0);
  const expected = cases.reduce((sum, c) => sum + c.expected, 0);

  const result = {
    date: new Date().toISOString(),
    commit: git("rev-parse", "--short", "HEAD").toString().trim(),
    // The repository part reads the committed tree, not uncommitted edits.
    analysis: {
      cases,
      totals: {
        truePositives: tp,
        falsePositives: fp,
        missed: expected - tp,
        precision: tp + fp === 0 ? 1 : tp / (tp + fp),
        recall: expected === 0 ? 1 : tp / expected,
      },
      thisRepository: await thisRepository(),
      realRepositories: await Promise.all(REPO_CASES.map(realRepository)),
    },
  };

  const dir = join(process.cwd(), "evals", "results");
  mkdirSync(dir, { recursive: true });
  // Date + commit: several measurements on the same day never overwrite each other.
  const file = join(dir, `${result.date.slice(0, 10)}-${result.commit}.json`);
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);

  console.log(
    [
      `analysis eval @ ${result.commit} → ${file}`,
      ...cases.map(
        (c) =>
          `  ${c.name}: precision ${c.precision.toFixed(2)}, recall ${c.recall.toFixed(2)}, ` +
          `${c.falsePositives.length} false positive(s), ${c.missed.length} missed`,
      ),
      `  total: precision ${result.analysis.totals.precision.toFixed(2)}, recall ${result.analysis.totals.recall.toFixed(2)}`,
      `  this repository: ${result.analysis.thisRepository.findings} findings in ${result.analysis.thisRepository.reportFindings} report lines, deterministic health ${result.analysis.thisRepository.deterministicHealthScore} (v1: ${result.analysis.thisRepository.v1DeterministicHealthScore}), ${codeQualityLine(result.analysis.thisRepository.codeQuality)}`,
      ...result.analysis.realRepositories.map(
        (r) =>
          `  ${r.name}: ${r.sourceFiles} files, ${r.chunks} chunks, ${r.findings} findings; annotated lines in the review sample: ${r.expectedInSample}/${r.expectedTotal}; ${codeQualityLine(r.codeQuality)}`,
      ),
      `  review sample: ${result.analysis.thisRepository.reviewSample.chunks} chunks from ${result.analysis.thisRepository.reviewSample.files} files in ${result.analysis.thisRepository.reviewSample.directories} directories (${result.analysis.thisRepository.reviewSample.testFiles} test files)`,
    ].join("\n"),
  );

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, markdownSummary(result));

  expect(cases).toHaveLength(ANALYSIS_CASES.length);
  // Quality gate (also in CI): a change may not make the analysis worse.
  expect(result.analysis.totals.precision).toBeGreaterThanOrEqual(GATE.minPrecision);
  expect(result.analysis.totals.recall).toBeGreaterThanOrEqual(GATE.minRecall);
  for (const repo of result.analysis.realRepositories) {
    expect(repo.expectedInSample, `${repo.name}: annotated lines in the review sample`).toBeGreaterThanOrEqual(
      GATE.minExpectedInSample[repo.name] ?? 0,
    );
  }
  // TD-50 item 2: no review request above Groq's per-request limit.
  for (const { name, tokens } of [
    { name: "this repository", tokens: result.analysis.thisRepository.reviewSample.requestTokens },
    ...result.analysis.realRepositories.map((r) => ({ name: r.name, tokens: r.reviewSample.requestTokens })),
  ]) {
    expect(tokens, `${name}: estimated review request tokens`).toBeLessThanOrEqual(REVIEW_MAX_REQUEST_TOKENS);
  }
  // TD-50: Code Quality ranks the repositories as ESLint's long-function
  // share does (fewer long functions, higher score).
  const ranked = [
    { name: "this repository", ...result.analysis.thisRepository.codeQuality },
    ...result.analysis.realRepositories.map((r) => ({ name: r.name, ...r.codeQuality })),
  ].sort((a, b) => a.eslintLongFunctionPercent - b.eslintLongFunctionPercent);
  for (let i = 1; i < ranked.length; i += 1) {
    expect(ranked[i].score, `Code Quality: ${ranked[i - 1].name} vs ${ranked[i].name}`).toBeLessThan(
      ranked[i - 1].score,
    );
  }
}, 120_000);

/**
 * Raise these when an improvement is merged, never lower them to make a
 * change pass. Annotated cases: every expected finding, no false positive.
 * Real repositories: annotated lines that reach the LLM review sample.
 */
const GATE = {
  minPrecision: 1,
  minRecall: 1,
  minExpectedInSample: { nodegoat: 5, "juice-shop": 2 } as Record<string, number>,
};

type CodeQuality = { score: number; longFunctionPercent: number; eslintLongFunctionPercent: number };

const codeQualityLine = (c: CodeQuality) =>
  `Code Quality ${c.score} (${c.longFunctionPercent}% of functions over ${LONG_FUNCTION_LINES} lines; ESLint ${c.eslintLongFunctionPercent}%)`;

type EvalResult = {
  commit: string;
  analysis: {
    cases: Array<{ name: string; precision: number; recall: number; falsePositives: unknown[]; missed: unknown[] }>;
    totals: { precision: number; recall: number };
    thisRepository: {
      findings: number;
      reportFindings: number;
      deterministicHealthScore: number;
      codeQuality: CodeQuality;
      reviewSample: { files: number; directories: number; testFiles: number };
    };
    realRepositories: Array<{
      name: string;
      findings: number;
      expectedInSample: number;
      expectedTotal: number;
      codeQuality: CodeQuality;
    }>;
  };
};

/** The GitHub Actions job summary: the numbers of this change, at a glance. */
function markdownSummary(result: EvalResult): string {
  const { cases, totals, thisRepository, realRepositories } = result.analysis;
  const pct = (value: number) => value.toFixed(2);
  return [
    `## Analysis eval @ \`${result.commit}\``,
    "",
    "| Annotated case | Precision | Recall | False positives | Missed |",
    "|---|---|---|---|---|",
    ...cases.map(
      (c) => `| ${c.name} | ${pct(c.precision)} | ${pct(c.recall)} | ${c.falsePositives.length} | ${c.missed.length} |`,
    ),
    `| **Total** | **${pct(totals.precision)}** | **${pct(totals.recall)}** | | |`,
    "",
    "| Repository | Findings | Vulnerable lines in the LLM sample | Code Quality (long functions; ESLint) |",
    "|---|---|---|---|",
    ...realRepositories.map(
      (r) =>
        `| ${r.name} | ${r.findings} | ${r.expectedInSample}/${r.expectedTotal} (gate ≥ ${GATE.minExpectedInSample[r.name] ?? 0}) | ${r.codeQuality.score} (${r.codeQuality.longFunctionPercent}%; ${r.codeQuality.eslintLongFunctionPercent}%) |`,
    ),
    "",
    `**This repository (dogfooding):** deterministic health ${thisRepository.deterministicHealthScore}, ` +
      `${thisRepository.findings} findings in ${thisRepository.reportFindings} report lines; ` +
      `review sample of ${thisRepository.reviewSample.files} files in ${thisRepository.reviewSample.directories} directories ` +
      `(${thisRepository.reviewSample.testFiles} tests); ${codeQualityLine(thisRepository.codeQuality)}.`,
    "",
    `Gate: precision ≥ ${GATE.minPrecision}, recall ≥ ${GATE.minRecall}; Code Quality ranks the repositories as ESLint does. No LLM runs in CI (no cost, no quota).`,
    "",
  ].join("\n");
}
