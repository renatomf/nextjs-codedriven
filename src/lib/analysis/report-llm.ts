import { createHash } from "node:crypto";

import { dataBlock, newDataBoundary } from "@/shared/prompt-data";

import { getStructuredLanguageModel, structuredLanguageModelId } from "@/lib/ai/llm";
import type { ReportIssue } from "@/lib/analysis/report-types";
import {
  REVIEW_BUDGET,
  REVIEW_PROMPT_VERSION,
  reviewInstructions,
  sampleForReview,
  verifyEvidence,
} from "@/modules/analysis";
import { APICallError, generateText, Output } from "ai";
import { z } from "zod";

// A slow provider must not hold the analysis request (TD-29).
const LLM_TIMEOUT_MS = 120_000;
// Per-analysis ceiling (roadmap Phase 4): about 3x the longest review in the
// evals of 2026-09-30 (2.9k output tokens). The input is already bounded by
// REVIEW_BUDGET.
const MAX_OUTPUT_TOKENS = 8_000;
// The prompt asks for at most 10; the server enforces it (stored in reports).
const MAX_ISSUES = 10;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 1_000;

/**
 * Groq answers 400 json_validate_failed when the model writes invalid JSON
 * (seen with quotes holding an unbalanced "{"). Groq recommends a retry.
 */
function isInvalidJsonGeneration(error: unknown): boolean {
  return (
    APICallError.isInstance(error) &&
    error.statusCode === 400 &&
    (error.responseBody ?? "").includes("json_validate_failed")
  );
}

const reportSchema = z.object({
  architectureSummary: z.string(),
  securitySummary: z.string(),
  performanceSummary: z.string(),
  issues: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      severity: z.enum(["critical", "high", "medium", "low"]),
      category: z.enum(["architecture", "security", "performance"]),
      filePath: z.string().nullable(),
      // Verbatim code; verified against what was sent (verifyEvidence).
      quote: z.string().nullable(),
    }),
  ),
});

/** The code is untrusted (TD-28): one data block per chunk. */
function formatChunks(
  chunks: Array<{
    filePath: string;
    content: string;
    startLine: number | null;
    endLine: number | null;
  }>,
  boundary: string,
): string {
  return chunks
    .map((chunk, index) => {
      const lines =
        chunk.startLine && chunk.endLine
          ? `L${chunk.startLine}-L${chunk.endLine}`
          : "lines unknown";
      // Chunks are cut by size, sometimes mid-statement (TD-48): say so, so a
      // cut is not taken for broken code.
      const cut = chunk.content.length > REVIEW_BUDGET.chunkChars;
      return dataBlock(
        boundary,
        `Chunk ${index + 1}. File: ${chunk.filePath} (${lines}, an excerpt: the file goes on before and after it)`,
        cut
          ? `${chunk.content.slice(0, REVIEW_BUDGET.chunkChars)}\n… [excerpt cut here]`
          : chunk.content,
      );
    })
    .join("\n\n");
}

export type LlmReportResult = {
  architectureSummary: string;
  securitySummary: string;
  performanceSummary: string;
  issues: ReportIssue[];
  /** Issues dropped because their quote was not found in the cited file. */
  droppedUnverified: number;
  /** For the evals: which files the model saw, and the tokens it used. */
  sentFilePaths: string[];
  sentRanges: Array<{ filePath: string; startLine: number | null; endLine: number | null }>;
  usage: { inputTokens?: number; outputTokens?: number };
};

export type ReviewInput = {
  projectName: string;
  framework: string | null;
  chunks: Array<{
    filePath: string;
    content: string;
    startLine: number | null;
    endLine: number | null;
  }>;
};

/**
 * Fingerprint of everything the review model receives: model, prompt
 * version, project name, framework and the sampled code (cut as it is sent).
 * The data boundary is left out: it is random per call and changes nothing
 * the model reviews. Same hash → reuse the stored review (TD-43).
 */
export function reviewInputHash(options: ReviewInput): string {
  const sampled = sampleForReview(options.chunks);
  const input = [
    structuredLanguageModelId(),
    REVIEW_PROMPT_VERSION,
    options.projectName,
    options.framework,
    sampled.map((chunk) => [
      chunk.filePath,
      chunk.startLine,
      chunk.endLine,
      chunk.content.slice(0, REVIEW_BUDGET.chunkChars),
    ]),
  ];
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export async function runLlmHealthReview(options: ReviewInput): Promise<LlmReportResult> {
  const sampled = sampleForReview(options.chunks);

  const review = () => {
    const boundary = newDataBoundary();
    return generateText({
      model: getStructuredLanguageModel(),
      output: Output.object({ schema: reportSchema }),
      // Same code, same review: needed for a stable report and a fair eval.
      temperature: 0,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      instructions: reviewInstructions(boundary),
      prompt: [
        `Project: ${options.projectName}`,
        `Framework: ${options.framework ?? "Unknown"}`,
        "",
        "Code snippets:",
        formatChunks(sampled, boundary),
      ].join("\n"),
    });
  };

  // One retry, only for invalid JSON; other errors (auth, quota) fail fast.
  const { output: object, usage } = await review().catch((error: unknown) => {
    if (isInvalidJsonGeneration(error)) return review();
    throw error;
  });

  // Evidence or out: issues whose quote is not in the code they cite go.
  const verified = verifyEvidence(object.issues, sampled);

  return {
    architectureSummary: object.architectureSummary,
    securitySummary: object.securitySummary,
    performanceSummary: object.performanceSummary,
    issues: verified.findings.slice(0, MAX_ISSUES).map((issue) => ({
      ...issue,
      title: issue.title.slice(0, MAX_TITLE),
      description: issue.description.slice(0, MAX_DESCRIPTION),
    })),
    droppedUnverified: verified.dropped.length,
    sentFilePaths: [...new Set(sampled.map((chunk) => chunk.filePath))],
    sentRanges: sampled.map(({ filePath, startLine, endLine }) => ({ filePath, startLine, endLine })),
    usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
  };
}
