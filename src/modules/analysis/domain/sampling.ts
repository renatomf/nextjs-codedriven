import type { ReviewedChunk } from "./evidence";
import { dirname, isTestFile, pathWords } from "./paths";

export type ReviewBudget = {
  /** Most chunks sent to the reviewer. */
  maxChunks: number;
  /**
   * Most characters of the snippet blocks sent: code, file path and the
   * block's markers (`snippetChars`), the request's token budget.
   */
  maxChars: number;
  /** Characters of one chunk that are sent (longer chunks are cut). */
  chunkChars: number;
};

// Groq's free tier rejects any request above 8000 tokens per minute. The
// whole request must stay under REVIEW_MAX_REQUEST_TOKENS (review-prompt.ts):
// 7500 × 3 characters, minus the instructions and header (~2.7k) and room
// for the project name. Until 2026-10-05 only the code counted here (16k),
// so 24 snippets with their headers could reach ~8k tokens (TD-50 item 2).
export const REVIEW_BUDGET: ReviewBudget = {
  maxChunks: 24,
  maxChars: 19_000,
  chunkChars: 2_500,
};

/** Appended to a chunk cut at `chunkChars`. */
export const CUT_MARK = "… [excerpt cut here]";

// One snippet block besides its path and code: data markers, "Chunk N.
// File: … (Lx-Ly, an excerpt…)" and separators. Measured 134 on
// 2026-10-05; the test in review-prompt.test.ts keeps it an upper bound.
const SNIPPET_OVERHEAD_CHARS = 150;

/** Characters one chunk takes in the review request. */
export function snippetChars(chunk: Pick<ReviewedChunk, "filePath" | "content">, budget = REVIEW_BUDGET): number {
  const cut = chunk.content.length > budget.chunkChars;
  return (
    Math.min(chunk.content.length, budget.chunkChars) +
    (cut ? CUT_MARK.length + 1 : 0) +
    chunk.filePath.length +
    SNIPPET_OVERHEAD_CHARS
  );
}

// Where the review categories (security, performance, architecture) usually
// live: code that receives input, talks to the database or guards access.
const SERVER_WORDS = new Set([
  "api",
  "route",
  "routes",
  "server",
  "action",
  "actions",
  "auth",
  "db",
  "database",
  "query",
  "queries",
  "payment",
  "payments",
  "billing",
  "webhook",
  "webhooks",
  "middleware",
  "proxy",
  "session",
  "admin",
  "controller",
  "controllers",
  "handler",
  "handlers",
]);

// Where security problems come in (untrusted input) and where they land
// (dangerous calls), for JS/TS in general (OWASP Top 10 categories), plus
// authentication and session code. Not tuned to any evaluated repository.
const RISK_SIGNALS: RegExp[] = [
  // Untrusted input
  /\breq\.(body|query|params|headers|cookies)\b/,
  /\brequest\.(json|formData|text)\(/,
  /\bsearchParams\b|\bformData\.get\(/,
  // Injection and code execution
  /\beval\(|\bnew Function\(/,
  /\bchild_process\b|\bexecSync\(|\bexec\(|\bspawn\(/,
  /\$where\b|\.(query|execute|raw)\(|\$queryRawUnsafe|\$executeRawUnsafe/,
  // Data access through an ORM or driver (who may read or change which rows)
  /\.(select|insert|update|delete|upsert|findMany|findFirst|findUnique|findOne|insertOne|updateOne|deleteOne|aggregate)\(/,
  // XSS
  /\binnerHTML\b|dangerouslySetInnerHTML|document\.write\(/,
  // Open redirect and server-side requests
  /\bredirect\(/,
  /\bfetch\(|\baxios\b|\bhttps?\.(get|request)\(|\bneedle\b|\bgot\(/,
  // Files
  /\bfs\.\w+\(|\breadFile(Sync)?\(|\bwriteFile(Sync)?\(/,
  // Authentication, sessions and secrets
  /\bauth\w*\(|\bNextAuth\b|\bgetServerSession\b|\bcurrentUser\b|\bsignIn\(|\bauthorize\b/,
  /\bprocess\.env\b/,
  /\bpasswords?\b/i,
  /\bsessions?\b/i,
  /\bcookies?\b/i,
  /\bjwt\b|\btokens?\b/i,
  /\bcrypto\.|\bMath\.random\(/,
];

/** How many kinds of risk signal a chunk shows (0 = none). */
export function riskScore(content: string): number {
  return RISK_SIGNALS.filter((signal) => signal.test(content)).length;
}

/** 0 = server logic, 1 = other logic, 2 = UI, 3 = configuration and type declarations. */
function priority(filePath: string): number {
  if (/\.config\.[cm]?[jt]s$|\.d\.ts$/i.test(filePath)) return 3;
  if (isUiFile(filePath)) return 2;
  return pathWords(filePath).some((word) => SERVER_WORDS.has(word)) ? 0 : 1;
}

/**
 * Code that runs in the browser: its path may say "payment" or "auth"
 * (`frontend/src/app/payment/payment.component.ts`), but the checks that
 * matter run on the server. Only unambiguous signs: JSX, Angular components
 * (NestJS uses `.service`/`.module`/`.pipe` on the server, not
 * `.component`), a top-level `frontend/` or `client/` folder, and files
 * inside a static-files folder.
 */
function isUiFile(filePath: string): boolean {
  if (/\.[jt]sx$|\.component\.[jt]s$/i.test(filePath)) return true;
  if (/^(frontend|client)\//i.test(filePath)) return true;
  // Served files and data (`public/js/`, `app/assets/`, `data/static/`),
  // not code the server runs.
  return /(^|\/)(static|public|assets)\//i.test(filePath);
}

/**
 * Which chunks the LLM reviewer sees, within the budget (roadmap Phase 7
 * item 2). The budget fits a small part of a real project, so the sample is
 * spread instead of the first files in alphabetical order:
 * - tests are left out (unless there is nothing else);
 * - files with a risk signal before files without any (a route that only
 *   renders a page waits behind a DAO that handles passwords);
 * - within that, server logic first, then other logic, UI and
 *   configuration, and the riskiest file first;
 * - inside each level, one file per directory in turn, so no folder takes
 *   the whole budget; one chunk of every file before a second of any;
 * - inside a file, the chunks with more risk signals first (input, dangerous
 *   calls, auth), then by line: the first chunk is often only imports.
 * Deterministic (same project, same sample) and returned in path order.
 */
export function sampleForReview<T extends ReviewedChunk>(
  chunks: T[],
  budget: ReviewBudget = REVIEW_BUDGET,
): T[] {
  const nonTest = chunks.filter((chunk) => !isTestFile(chunk.filePath));
  const candidates = nonTest.length > 0 ? nonTest : chunks;

  const byFile = new Map<string, T[]>();
  for (const chunk of candidates) {
    byFile.set(chunk.filePath, [...(byFile.get(chunk.filePath) ?? []), chunk]);
  }
  for (const fileChunks of byFile.values()) {
    const risk = new Map(fileChunks.map((chunk) => [chunk, riskScore(chunk.content)]));
    fileChunks.sort(
      (a, b) => risk.get(b)! - risk.get(a)! || (a.startLine ?? 0) - (b.startLine ?? 0),
    );
  }

  // A file's risk is its riskiest chunk's (the first after the sort above).
  const fileRisk = new Map(
    [...byFile].map(([file, fileChunks]) => [file, riskScore(fileChunks[0].content)]),
  );
  // Files with a risk signal first, by path priority among themselves; files
  // without any after them. Then the riskiest file first, then by path.
  const level = (file: string) => (fileRisk.get(file)! > 0 ? 0 : 4) + priority(file);
  const files = [...byFile.keys()].sort(
    (a, b) => level(a) - level(b) || fileRisk.get(b)! - fileRisk.get(a)! || a.localeCompare(b),
  );
  const order = interleaveByDirectory(files, level);

  // Round r takes the r-th best chunk of every file, in that order.
  const queue: T[] = [];
  const rounds = Math.max(...[...byFile.values()].map((c) => c.length), 0);
  for (let round = 0; round < rounds; round += 1) {
    for (const file of order) {
      const chunk = byFile.get(file)![round];
      if (chunk) queue.push(chunk);
    }
  }

  const sampled: T[] = [];
  let usedChars = 0;
  for (const chunk of queue) {
    if (sampled.length === budget.maxChunks) break;
    const size = snippetChars(chunk, budget);
    if (usedChars + size > budget.maxChars) continue; // a smaller one may fit
    sampled.push(chunk);
    usedChars += size;
  }

  return sampled.sort(
    (a, b) => a.filePath.localeCompare(b.filePath) || (a.startLine ?? 0) - (b.startLine ?? 0),
  );
}

/**
 * Files already sorted by level; within each level, take one file per
 * directory in turn (a, b, c, a, b, ...), directories in order of their
 * first file.
 */
function interleaveByDirectory(files: string[], level: (file: string) => number): string[] {
  const result: string[] = [];
  let start = 0;
  while (start < files.length) {
    const current = level(files[start]);
    let end = start;
    while (end < files.length && level(files[end]) === current) end += 1;

    const byDirectory = new Map<string, string[]>();
    for (const file of files.slice(start, end)) {
      byDirectory.set(dirname(file), [...(byDirectory.get(dirname(file)) ?? []), file]);
    }
    const directories = [...byDirectory.values()];
    for (let i = 0; directories.some((d) => i < d.length); i += 1) {
      for (const directory of directories) if (i < directory.length) result.push(directory[i]);
    }
    start = end;
  }
  return result;
}
