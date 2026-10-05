import { dataBlock, dataRules } from "@/shared/prompt-data";

import type { ReviewedChunk } from "./evidence";
import { CUT_MARK, REVIEW_BUDGET } from "./sampling";
import { promptVersion } from "@/shared/prompt-version";

/**
 * The LLM review prompt (roadmap Phase 7: prompts in versioned files). Its
 * fixed text lives here; a change gives a new REVIEW_PROMPT_VERSION, which
 * evals/prompts.lock.json must record with the eval that measured it.
 */
export const REVIEW_PROMPT = [
  "You are an AI senior engineer reviewing a JavaScript/TypeScript codebase.",
  "Find potential issues for the developer to verify — not certified vulnerabilities or proven bottlenecks.",
  "",
  "Cover these categories only: architecture, security, performance.",
  "Severity guide:",
  "- critical: likely security breach or data loss risk",
  "- high: likely incorrect behavior or major performance problem",
  "- medium: maintainability / structure problem",
  "- low: minor concern",
  "",
  "You see a sample of the project, not all of it: never claim that something is missing from the codebase (tests, validation, error handling, size or rate limits) unless the snippets themselves show it.",
  "Before reporting, follow the quoted code to where its result is used in the snippet: if a later line handles it (an error turned into null that validation then rejects) or depends on it (a value that decides a branch), it is not an issue.",
  "A security issue must have a concrete way to be exploited; if you cannot name one, do not report it.",
  "Not issues: checking the session and ownership inside every handler (defense in depth; never suggest moving it to middleware alone), and settings that differ by environment on purpose (cookies secure only in production).",
  "Assume the code compiles: the project builds and type-checks it, and the compiler is what finds syntax errors. Never report a syntax error, a stray or missing character, or an unclosed construct. Dense TypeScript (nested generics, casts, non-null assertions, satisfies) is valid code, not a typo. Each snippet is also an excerpt cut by size: it may start or end in the middle of a statement, a call or an object.",
  "Report only issues the snippets support. A few precise issues are better than many generic ones; an empty list is a valid answer. At most 10 issues.",
  "Report each root cause once, in its most relevant category.",
  "For an issue about a file, set filePath exactly as written in the snippet header and set quote to the single line of code that shows the problem, copied verbatim. Issues whose quote is not found in that file are discarded.",
  "Use filePath null (and quote null) only for an issue visible across several snippets.",
] as const;

export const REVIEW_PROMPT_VERSION = promptVersion(REVIEW_PROMPT);

/** The instructions sent to the model: the prompt plus the data rules (TD-28). */
export function reviewInstructions(boundary: string): string {
  return [...REVIEW_PROMPT, ...dataRules(boundary)].join("\n");
}

type ReviewSnippet = ReviewedChunk & { endLine: number | null };

/** The code is untrusted (TD-28): one data block per chunk. */
function reviewSnippets(chunks: ReviewSnippet[], boundary: string): string {
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
          ? `${chunk.content.slice(0, REVIEW_BUDGET.chunkChars)}\n${CUT_MARK}`
          : chunk.content,
      );
    })
    .join("\n\n");
}

const MAX_PROJECT_NAME_CHARS = 100;

/**
 * Everything the review model receives for a sample (`sampleForReview`):
 * instructions and prompt. `boundary` comes from `newDataBoundary()`.
 */
export function reviewRequest(
  project: { projectName: string; framework: string | null },
  sampled: ReviewSnippet[],
  boundary: string,
): { instructions: string; prompt: string } {
  return {
    instructions: reviewInstructions(boundary),
    prompt: [
      // Untrusted (a repository or ZIP name) and outside the data blocks:
      // capped, which also keeps it inside the request's token budget.
      `Project: ${project.projectName.slice(0, MAX_PROJECT_NAME_CHARS)}`,
      `Framework: ${project.framework ?? "Unknown"}`,
      "",
      "Code snippets:",
      reviewSnippets(sampled, boundary),
    ].join("\n"),
  };
}

/**
 * Tokens of a request, estimated on the safe side. Measured against Groq's
 * own count on 2026-10-05 (the "Requested" of its rate-limit answer, which
 * matched the billed input within 3%): 3.3-3.8 characters per token for
 * review requests, about 3.1 for small ones (TD-50 item 2).
 */
export function estimateRequestTokens(request: { instructions: string; prompt: string }): number {
  return Math.ceil((request.instructions.length + request.prompt.length) / 3);
}

/**
 * Most tokens one review request may take. Groq's free tier rejects any
 * request above 8000 tokens per minute ("Request too large") and does not
 * count the output limit in it (measured 2026-10-05); the margin covers
 * the estimate's error.
 */
export const REVIEW_MAX_REQUEST_TOKENS = 7_500;
