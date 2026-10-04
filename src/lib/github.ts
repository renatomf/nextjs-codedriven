import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { z } from "zod";

import { decryptToken } from "@/lib/encryption";
import { MAX_REPO_SIZE_BYTES } from "@/lib/limits";
import { DomainError } from "@/shared/errors";

export const GITHUB_API = "https://api.github.com";
export const GITHUB_TIMEOUT_MS = 10_000;
const GITHUB_DOWNLOAD_TIMEOUT_MS = 60_000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_STATE_PURPOSE = "github-oauth-state:v1";

/** httpOnly cookie holding the state nonce; `__Host-` pins it to our origin over HTTPS. */
export const GITHUB_OAUTH_NONCE_COOKIE =
  process.env.NODE_ENV === "production"
    ? "__Host-github_oauth_nonce"
    : "github_oauth_nonce";
export const GITHUB_OAUTH_NONCE_MAX_AGE_S = OAUTH_STATE_TTL_MS / 1000;

/** Errors whose message is safe to show to the user (no internals). */
export class GitHubError extends DomainError {
  name = "GitHubError";
}

/** No way to read the user's repositories: neither the App nor a token. */
export class GitHubNotConnectedError extends GitHubError {
  name = "GitHubNotConnectedError";
}

/**
 * How the server reads a user's repositories: a GitHub App installation
 * (ADR-007, read-only, a 1-hour token per use) or, until the migration ends,
 * the legacy OAuth token stored encrypted on `users.githubAccessToken`.
 */
export type GitHubCredentials =
  | { installationId: number }
  | { userId: string; encryptedToken: string };

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

/** owner/repo as GitHub allows it; blocks `..`, extra slashes, query strings. */
export const fullNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/)
  .refine((value) => !/\/\.{1,2}$/.test(value));

export const refSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\s~^:?*[\\]+$/)
  .refine((value) => !value.includes(".."));

export function githubHeaders(accessToken?: string): HeadersInit {
  return {
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "codedriven",
  };
}

export function getAppUrl() {
  const url = process.env.AUTH_URL;
  if (url) return url;
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_URL is not set");
  }
  return "http://localhost:3000";
}

function getRedirectUri() {
  return `${getAppUrl()}/api/github/callback`;
}

function getStateSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return secret;
}

// The purpose prefix keeps these HMACs from being valid for any other use of
// AUTH_SECRET.
function hmacState(payload: string): string {
  return createHmac("sha256", getStateSecret())
    .update(`${OAUTH_STATE_PURPOSE}.${payload}`)
    .digest("base64url");
}

const statePayloadSchema = z.object({
  userId: z.uuid(),
  nonce: z.string().min(16),
  ts: z.number().int(),
});

/**
 * Signed, expiring state for the "Connect GitHub" flow. The caller must also
 * store `nonce` in an httpOnly cookie and the callback must check it plus
 * `userId === session.user.id` (see verifyGitHubOAuthState).
 */
export function createGitHubOAuthState(userId: string): {
  state: string;
  nonce: string;
} {
  const nonce = randomBytes(16).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ userId, nonce, ts: Date.now() }),
    "utf8",
  ).toString("base64url");
  return { state: `${payload}.${hmacState(payload)}`, nonce };
}

export function verifyGitHubOAuthState(
  state: string,
  expected: { sessionUserId: string; nonce: string | undefined },
): boolean {
  const [payload, signature, ...rest] = state.split(".");
  if (!payload || !signature || rest.length || !expected.nonce) return false;

  const a = Buffer.from(signature);
  const b = Buffer.from(hmacState(payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  let parsed: z.infer<typeof statePayloadSchema>;
  try {
    const result = statePayloadSchema.safeParse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    if (!result.success) return false;
    parsed = result.data;
  } catch {
    return false;
  }

  const age = Date.now() - parsed.ts;
  if (age < 0 || age > OAUTH_STATE_TTL_MS) return false;

  const nonceA = Buffer.from(parsed.nonce);
  const nonceB = Buffer.from(expected.nonce);
  if (nonceA.length !== nonceB.length || !timingSafeEqual(nonceA, nonceB)) {
    return false;
  }

  return parsed.userId === expected.sessionUserId;
}

export function getGitHubAuthorizeUrl(state: string): string {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) throw new Error("GITHUB_CLIENT_ID is not set");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getRedirectUri(),
    // OAuth Apps have no read-only scope for private repos; `repo` is the
    // minimum that allows downloading them.
    scope: "read:user user:email repo",
    state,
  });

  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/** Returns the plain token: encrypt it with encryptToken(token, userId) before storing. */
export async function exchangeGitHubCode(code: string): Promise<{
  accessToken: string;
  login: string;
}> {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GitHub OAuth env vars are missing");
  }

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: getRedirectUri(),
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });

  if (!tokenRes.ok) {
    throw new Error("Failed to exchange GitHub OAuth code");
  }

  const tokenJson = (await tokenRes.json()) as { access_token?: unknown };
  if (typeof tokenJson.access_token !== "string" || !tokenJson.access_token) {
    throw new Error("GitHub did not return an access token");
  }

  const userRes = await fetch(`${GITHUB_API}/user`, {
    headers: githubHeaders(tokenJson.access_token),
    cache: "no-store",
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });

  if (!userRes.ok) {
    throw new Error("Failed to fetch GitHub user profile");
  }

  const profile = (await userRes.json()) as { login?: unknown };
  if (typeof profile.login !== "string" || !profile.login) {
    throw new Error("GitHub profile is missing a username");
  }

  return { accessToken: tokenJson.access_token, login: profile.login };
}

/** Legacy OAuth listing (`/user/repos`); App installations list their own. */
export async function listGitHubRepos(
  credentials: { userId: string; encryptedToken: string },
): Promise<GitHubRepo[]> {
  const token = decryptToken(credentials.encryptedToken, credentials.userId);
  const repos: GitHubRepo[] = [];
  let page = 1;

  while (page <= 5) {
    const params = new URLSearchParams({
      per_page: "100",
      page: String(page),
      sort: "updated",
      affiliation: "owner,collaborator,organization_member",
    });
    const res = await fetch(`${GITHUB_API}/user/repos?${params.toString()}`, {
      headers: githubHeaders(token),
      cache: "no-store",
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new GitHubError(
          "GitHub access denied. Reconnect GitHub in Settings and check permissions.",
        );
      }
      throw new GitHubError("Failed to list GitHub repositories");
    }

    const parsed = z.array(gitHubRepoSchema).safeParse(await res.json());
    if (!parsed.success) {
      throw new GitHubError("Failed to list GitHub repositories");
    }

    repos.push(...parsed.data);
    if (parsed.data.length < 100) break;
    page += 1;
  }

  return repos;
}

/** True only when GitHub confirms the repository exists and has no content. */
async function isEmptyRepository(token: string, owner: string, repo: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { headers: githubHeaders(token), cache: "no-store", signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) },
    );
    if (!res.ok) return false;
    const body = (await res.json()) as { size?: unknown };
    return body.size === 0;
  } catch {
    return false;
  }
}

/** Reads the body up to `maxBytes`; aborts the download past that. */
async function readBodyLimited(
  res: Response,
  maxBytes: number,
): Promise<Buffer | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    return null;
  }
  if (!res.body) return Buffer.alloc(0);

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks);
}

/**
 * `fullName` / `ref` may come from the client, so they are validated before
 * being placed in the API path.
 */
export async function downloadGitHubZipball(
  credentials: GitHubCredentials,
  fullName: string,
  ref?: string,
): Promise<Buffer> {
  const parsedName = fullNameSchema.safeParse(fullName);
  const parsedRef = ref === undefined ? null : refSchema.safeParse(ref);
  if (!parsedName.success || (parsedRef && !parsedRef.success)) {
    throw new GitHubError("Invalid repository name.");
  }

  const [owner, repo] = parsedName.data.split("/");
  const base = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zipball`;
  const url = parsedRef ? `${base}/${encodeURIComponent(parsedRef.data)}` : base;

  // An App installation gets a token that can only read this repository.
  const token =
    "installationId" in credentials
      ? await (await import("@/lib/github-app")).mintInstallationToken(credentials.installationId, {
          repository: repo,
        })
      : decryptToken(credentials.encryptedToken, credentials.userId);

  // GitHub answers with a redirect to a pre-signed codeload URL; fetch strips
  // the Authorization header on that cross-origin hop.
  const res = await fetch(url, {
    headers: githubHeaders(token),
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(GITHUB_DOWNLOAD_TIMEOUT_MS),
  });

  if (!res.ok) {
    if (res.status === 404) {
      // An empty repository has no archive: GitHub still redirects, then
      // codeload answers 404 (seen in the ADR-007 spike).
      if (await isEmptyRepository(token, owner, repo)) {
        throw new GitHubError("This repository is empty. Push at least one commit, then try again.");
      }
      throw new GitHubError(
        "Repository not found or you do not have access to this private repo.",
      );
    }
    throw new GitHubError("Failed to download repository archive from GitHub");
  }

  const buffer = await readBodyLimited(res, MAX_REPO_SIZE_BYTES);
  if (!buffer) {
    throw new GitHubError(
      `Repository exceeds the ${MAX_REPO_SIZE_BYTES / (1024 * 1024)} MB size limit.`,
    );
  }

  return buffer;
}
