import { z } from "zod";

import { DomainError } from "@/shared/errors";

/**
 * What both GitHub clients share: the legacy OAuth one (`github.ts`) and the
 * GitHub App one (`github-app.ts`, ADR-007). Kept apart so neither imports
 * the other's module back (no cycle).
 */

export const GITHUB_API = "https://api.github.com";
export const GITHUB_TIMEOUT_MS = 10_000;

/** Errors whose message is safe to show to the user (no internals). */
export class GitHubError extends DomainError {
  name = "GitHubError";
}

/** No way to read the user's repositories: neither the App nor a token. */
export class GitHubNotConnectedError extends GitHubError {
  name = "GitHubNotConnectedError";
}

// Only the fields we use; anything else GitHub returns is dropped.
export const gitHubRepoSchema = z.object({
  id: z.number(),
  full_name: z.string(),
  name: z.string(),
  private: z.boolean(),
  html_url: z.string(),
  default_branch: z.string(),
  pushed_at: z.string().nullable(),
  size: z.number(), // KB according to GitHub API
});

export type GitHubRepo = z.infer<typeof gitHubRepoSchema>;

export function githubHeaders(accessToken?: string): HeadersInit {
  return {
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "codedriven",
  };
}
