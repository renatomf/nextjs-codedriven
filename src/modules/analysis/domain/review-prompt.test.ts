import { describe, expect, it } from "vitest";

import { estimateRequestTokens, REVIEW_MAX_REQUEST_TOKENS, reviewRequest } from "./review-prompt";
import { REVIEW_BUDGET, sampleForReview, snippetChars } from "./sampling";

const boundary = "0123456789abcdef";
const requestChars = (request: { instructions: string; prompt: string }) =>
  request.instructions.length + request.prompt.length;

// TD-50 item 2: one request above Groq's 8000 tokens per minute always fails
// ("Request too large"), so the sample is budgeted on the whole request.
describe("review request size", () => {
  it("counts each snippet's markers, path and cut mark in the sample's budget", () => {
    const chunk = (filePath: string, length: number) => ({
      filePath,
      content: "x".repeat(length),
      startLine: 10000,
      endLine: 10999,
    });
    const chunks = [chunk("src/a.ts", 10), chunk("src/very/deep/path/to/b.ts", 3000)];
    const empty = requestChars(reviewRequest({ projectName: "p", framework: null }, [], boundary));
    const full = requestChars(reviewRequest({ projectName: "p", framework: null }, chunks, boundary));

    // An upper bound of what the snippets really add (the budget is safe).
    const counted = chunks.reduce((sum, c) => sum + snippetChars(c), 0);
    expect(counted).toBeGreaterThanOrEqual(full - empty);
    expect(counted - (full - empty)).toBeLessThan(60);
  });

  it("stays under the per-request limit in the worst case the budget allows", () => {
    // Long paths, every chunk cut at the maximum, a long project name.
    const chunks = Array.from({ length: 200 }, (_, i) => ({
      filePath: `packages/some-long-package-name/src/features/area-${i}/components/deeply/nested/file-${i}.tsx`,
      content: `const v${i} = 1;\n`.repeat(400),
      startLine: 100000,
      endLine: 199999,
    }));
    const sampled = sampleForReview(chunks);
    const request = reviewRequest({ projectName: "n".repeat(5000), framework: "Next.js" }, sampled, boundary);

    expect(sampled.length).toBeGreaterThan(0);
    expect(estimateRequestTokens(request)).toBeLessThanOrEqual(REVIEW_MAX_REQUEST_TOKENS);
  });

  it("would have exceeded it with the old budget (16k characters of code only)", () => {
    const chunks = Array.from({ length: REVIEW_BUDGET.maxChunks }, (_, i) => ({
      filePath: `packages/some-long-package-name/src/features/area-${i}/file-${i}.ts`,
      content: "x".repeat(Math.floor(16_000 / REVIEW_BUDGET.maxChunks)),
      startLine: 1,
      endLine: 99,
    }));
    const request = reviewRequest({ projectName: "p", framework: null }, chunks, boundary);

    expect(estimateRequestTokens(request)).toBeGreaterThan(REVIEW_MAX_REQUEST_TOKENS);
  });
});
