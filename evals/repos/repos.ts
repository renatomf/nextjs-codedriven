import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import JSZip from "jszip";

import { extractFromZipBuffer } from "@/lib/files/extract";
import { isSourceFile } from "@/lib/files/filters";
import type { IssueCategory } from "@/modules/analysis";

/**
 * Real open-source repositories with known, annotated problems (roadmap
 * Phase 7 dataset). Pinned to a commit and read like a GitHub import (the
 * real extractor); the source is downloaded once into evals/.cache, never
 * committed here.
 */

export type ExpectedProblem = {
  /** Any of these categories counts (e.g. ReDoS is security or performance). */
  categories: IssueCategory[];
  filePath: string;
  /** Lines of the vulnerable code: the sample must include the chunk of one. */
  lines: number[];
  note: string;
};

export type RepoCase = {
  name: string;
  owner: string;
  repo: string;
  commit: string;
  license: string;
  expected: ExpectedProblem[];
  /**
   * Comments that point at the answer, removed before the analysis (the
   * rest of the line stays, so line numbers do not move).
   */
  stripComments?: RegExp;
};

/**
 * OWASP NodeGoat: a Node.js/Express app written to be vulnerable (OWASP Top
 * 10). Only problems active at this commit are listed: the fixes it keeps
 * commented out next to them do not count. Caveat: NodeGoat comments its own
 * flaws ("Insecure use of eval()"), which helps a reviewer; its recall is an
 * upper bound, not a typical value.
 */
export const NODEGOAT: RepoCase = {
  name: "nodegoat",
  owner: "OWASP",
  repo: "NodeGoat",
  commit: "c5cb68a7084e4ae7dcc60e6a98768720a81841e8",
  license: "Apache-2.0",
  expected: [
    {
      categories: ["security"],
      filePath: "app/routes/contributions.js",
      lines: [32],
      note: "eval() of request body fields (server-side JS injection)",
    },
    {
      categories: ["security"],
      filePath: "app/data/allocations-dao.js",
      lines: [78],
      note: "NoSQL injection: user input inside a $where expression",
    },
    {
      categories: ["security"],
      filePath: "app/routes/allocations.js",
      lines: [18],
      note: "IDOR: userId taken from the URL instead of the session",
    },
    {
      categories: ["security"],
      filePath: "app/routes/index.js",
      lines: [72],
      note: "Open redirect: res.redirect(req.query.url)",
    },
    {
      categories: ["security"],
      filePath: "app/routes/research.js",
      lines: [15],
      note: "SSRF: server fetches a URL built from the query string",
    },
    {
      categories: ["security"],
      filePath: "app/data/user-dao.js",
      lines: [25],
      note: "Passwords stored and compared in plain text",
    },
    {
      categories: ["security"],
      filePath: "app/data/profile-dao.js",
      lines: [62],
      note: "SSN and date of birth stored unencrypted",
    },
    {
      categories: ["security", "performance"],
      filePath: "app/routes/profile.js",
      lines: [59],
      note: "ReDoS: /([0-9]+)+\\#/ on user input",
    },
    {
      categories: ["security"],
      filePath: "server.js",
      lines: [137],
      note: "No CSRF protection, session cookie without httpOnly, template autoescape off",
    },
  ],
};

/**
 * OWASP Juice Shop: a modern TypeScript app (Express + Angular) with
 * deliberate flaws. The answers come from the project itself: it marks each
 * vulnerable line with `// vuln-code-snippet vuln-line <challenge>` for its
 * coding challenges. Those comments name the flaw, so they are stripped
 * before the analysis (only the comment; lines keep their numbers).
 * Included: markers whose code is itself a flaw a reviewer can see
 * (injection, XSS, redirect, weak hashing, authorization, exposure,
 * misconfiguration), one expectation per file. Left out: "discovery"
 * challenges (hidden frontend routes: score board, web3, token sale), the
 * crypto-address allowlist entries and the marker parser
 * (lib/codingChallenges.ts).
 */
export const JUICE_SHOP: RepoCase = {
  name: "juice-shop",
  owner: "juice-shop",
  repo: "juice-shop",
  commit: "1618a611b173b4bf114028e6e02549950606e29d",
  license: "MIT",
  stripComments: /[ \t]*\/\/ vuln-code-snippet .*$/gm,
  expected: [
    {
      categories: ["security"],
      filePath: "routes/search.ts",
      lines: [23],
      note: "SQL injection: search criteria inside a raw query (unionSqlInjection)",
    },
    {
      categories: ["security"],
      filePath: "routes/login.ts",
      lines: [34],
      note: "SQL injection in login: email inside a raw query (loginAdmin)",
    },
    {
      categories: ["security"],
      filePath: "routes/updateProductReviews.ts",
      lines: [16, 18, 20],
      note: "NoSQL injection and no author check on review updates (noSqlReviews, forgedReview)",
    },
    {
      categories: ["security"],
      filePath: "lib/insecurity.ts",
      lines: [136],
      note: "Open redirect: allowlist checked with url.includes (redirect)",
    },
    {
      categories: ["security"],
      filePath: "models/user.ts",
      lines: [73],
      note: "Passwords hashed with unsalted MD5 (weakPassword)",
    },
    {
      categories: ["security"],
      filePath: "frontend/src/app/search-result/search-result.component.ts",
      lines: [111, 144],
      note: "XSS: bypassSecurityTrustHtml on user-controlled data (restfulXss, localXss)",
    },
    {
      categories: ["security"],
      filePath: "server.ts",
      lines: [288, 289, 300, 302, 365, 389, 530, 750],
      note: "Directory listing, log and metrics exposure, rate limit keyed by X-Forwarded-For, missing authorization, admin registration",
    },
    {
      categories: ["security"],
      filePath: "routes/chat.ts",
      lines: [179, 184],
      note: "LLM tool trusts the model's discount: no server-side cap (chatbotPromptInjection)",
    },
  ],
};

export const REPO_CASES: RepoCase[] = [NODEGOAT, JUICE_SHOP];

const CACHE_DIR = join(process.cwd(), "evals", ".cache");

/**
 * This repository's source files, read like a GitHub import: the committed
 * tree (not uncommitted edits) through the real extractor.
 */
export async function loadThisRepository() {
  const zip = execFileSync("git", ["archive", "--format=zip", "HEAD"], { maxBuffer: 256 * 1024 * 1024 });
  const extracted = await extractFromZipBuffer(zip);
  if (!extracted.ok) throw new Error(`Could not read this repository: ${extracted.error}`);
  // Same filter as the analysis (loadProjectSourceFiles).
  return extracted.sourceFiles
    .filter((file) => isSourceFile(file.relativePath))
    .map(({ relativePath, content }) => ({ relativePath, content }));
}

/** The repository's source files at its commit, as the analysis reads them. */
export async function loadRepo(repoCase: RepoCase) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const zipPath = join(CACHE_DIR, `${repoCase.repo}-${repoCase.commit}.zip`);
  if (!existsSync(zipPath)) {
    const url = `https://codeload.github.com/${repoCase.owner}/${repoCase.repo}/zip/${repoCase.commit}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
      throw new Error(`Could not download ${repoCase.name} (${response.status}): ${url}`);
    }
    writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));
  }

  // Same as a GitHub import: the archive's root folder is stripped.
  const extracted = await extractFromZipBuffer(readFileSync(zipPath), { stripRoot: true });
  if (!extracted.ok) throw new Error(`Could not read ${repoCase.name}: ${extracted.error}`);
  const strip = repoCase.stripComments;
  return extracted.sourceFiles
    .filter((file) => isSourceFile(file.relativePath))
    .map(({ relativePath, content }) => ({
      relativePath,
      content: strip ? content.replace(strip, "") : content,
    }));
}

/**
 * The root npm lockfile and manifest (ADR-012), read straight from the
 * cached archive: the analysis' extractor keeps only source files and
 * package.json. Undefined when the repository has none.
 */
export async function loadLockfile(repoCase: RepoCase): Promise<{ lockfile?: string; manifest?: string }> {
  await loadRepo(repoCase); // downloads the archive when missing
  const zip = await JSZip.loadAsync(readFileSync(join(CACHE_DIR, `${repoCase.repo}-${repoCase.commit}.zip`)));
  const rootFile = (name: string) =>
    Object.values(zip.files).find((f) => !f.dir && f.name.split("/").length === 2 && f.name.endsWith(`/${name}`));
  return {
    lockfile: await rootFile("package-lock.json")?.async("string"),
    manifest: await rootFile("package.json")?.async("string"),
  };
}

/** This repository's committed lockfile and manifest. */
export function loadThisRepositoryLockfile(): { lockfile: string; manifest: string } {
  const show = (path: string) => execFileSync("git", ["show", `HEAD:${path}`], { maxBuffer: 64 * 1024 * 1024 }).toString();
  return { lockfile: show("package-lock.json"), manifest: show("package.json") };
}
