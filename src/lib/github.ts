import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { z } from "zod";

import { MAX_REPO_SIZE_BYTES } from "@/lib/limits";
import { GITHUB_API, GITHUB_TIMEOUT_MS, GitHubError, githubHeaders } from "@/lib/github-api";
import { mintInstallationToken } from "@/lib/github-app";

export {
  GITHUB_API,
  GITHUB_TIMEOUT_MS,
  GitHubError,
  GitHubNotConnectedError,
  githubHeaders,
  gitHubRepoSchema,
  type GitHubRepo,
} from "@/lib/github-api";

const GITHUB_DOWNLOAD_TIMEOUT_MS = 60_000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_STATE_PURPOSE = "github-oauth-state:v1";

/** httpOnly cookie holding the state nonce; `__Host-` pins it to our origin over HTTPS. */
export const GITHUB_OAUTH_NONCE_COOKIE =
  process.env.NODE_ENV === "production"
    ? "__Host-github_oauth_nonce"
    : "github_oauth_nonce";
export const GITHUB_OAUTH_NONCE_MAX_AGE_S = OAUTH_STATE_TTL_MS / 1000;

/**
 * How the server reads a user's repositories: the GitHub App installation
 * of the repository's owner (ADR-007). Each read mints a 1-hour, read-only
 * token; nothing is stored.
 */
export type GitHubCredentials = { installationId: number };

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

  // A token that can only read this repository, for one hour.
  const token = await mintInstallationToken(credentials.installationId, { repository: repo });

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
