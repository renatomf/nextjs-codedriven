import "server-only";

import { createSign } from "node:crypto";

import { z } from "zod";

import {
  GITHUB_API,
  GITHUB_TIMEOUT_MS,
  GitHubError,
  githubHeaders,
  gitHubRepoSchema,
  type GitHubRepo,
} from "@/lib/github-api";

/**
 * GitHub App client (ADR-007): read-only access to the repositories a user
 * chose. Nothing here is stored: the App's JWT and each installation token
 * live for one call. Tokens are never logged or returned to the browser.
 */

export type GitHubAppConfig = {
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  slug: string;
};

/** The App of this environment, or null when it is not configured. */
export function githubAppConfig(): GitHubAppConfig | null {
  const appId = process.env.GITHUB_APP_ID;
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const slug = process.env.GITHUB_APP_SLUG;
  if (!appId || !clientId || !clientSecret || !privateKey || !slug) return null;
  // Vercel keeps the PEM's newlines; an escaped `\n` form works too.
  return { appId, clientId, clientSecret, privateKey: privateKey.replace(/\\n/g, "\n"), slug };
}

function requireConfig(): GitHubAppConfig {
  const config = githubAppConfig();
  if (!config) throw new Error("The GitHub App is not configured.");
  return config;
}

/** Thrown when the installation no longer exists (uninstalled on GitHub). */
export class GitHubInstallationGoneError extends GitHubError {
  name = "GitHubInstallationGoneError";
  constructor() {
    super("The GitHub App was removed from this account. Connect GitHub again in Settings.");
  }
}

const base64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

/** The App's JWT (RS256): valid 9 minutes, backdated 60 s for clock drift. */
export function appJwt(config: Pick<GitHubAppConfig, "appId" | "privateKey">, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: config.appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64url(signer.sign(config.privateKey))}`;
}

/** Where "Connect GitHub" sends the user: install (or update) the App. */
export function githubAppInstallUrl(state: string): string {
  const { slug } = requireConfig();
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`;
}

const tokenSchema = z.object({ token: z.string().min(1) });

/**
 * A 1-hour installation token, read-only. With `repository`, it can only
 * read that repository (a name of the installation's account).
 */
export async function mintInstallationToken(
  installationId: number,
  options: { repository?: string } = {},
): Promise<string> {
  const config = requireConfig();
  const res = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: githubHeaders(appJwt(config)),
    body: JSON.stringify({
      ...(options.repository ? { repositories: [options.repository] } : {}),
      permissions: { contents: "read", metadata: "read" },
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });

  if (res.status === 404) throw new GitHubInstallationGoneError();
  if (res.status === 422 && options.repository) {
    throw new GitHubError(
      "The GitHub App cannot read this repository. Add it to the codedriven installation on GitHub, then try again.",
    );
  }
  const parsed = tokenSchema.safeParse(res.ok ? await res.json() : null);
  if (!parsed.success) throw new GitHubError("Could not get access to GitHub. Try again later.");
  return parsed.data.token;
}

const installationReposSchema = z.object({ repositories: z.array(gitHubRepoSchema) });

/** The repositories the user chose for this installation. */
export async function listInstallationRepos(installationId: number): Promise<GitHubRepo[]> {
  const token = await mintInstallationToken(installationId);
  const repos: GitHubRepo[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const res = await fetch(`${GITHUB_API}/installation/repositories?per_page=100&page=${page}`, {
      headers: githubHeaders(token),
      cache: "no-store",
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    const parsed = installationReposSchema.safeParse(res.ok ? await res.json() : null);
    if (!parsed.success) throw new GitHubError("Failed to list GitHub repositories");
    repos.push(...parsed.data.repositories);
    if (parsed.data.repositories.length < 100) break;
  }
  return repos;
}

const userTokenSchema = z.object({ access_token: z.string().min(1) });
const userInstallationsSchema = z.object({
  installations: z.array(z.object({ id: z.number(), account: z.object({ login: z.string() }) })),
});

/**
 * The installations the user who just installed the App can access. GitHub
 * sends the `installation_id` to the callback in the URL, where anyone can
 * forge it: only an id in this list may be linked to the user. The user's
 * token is used for this check only and discarded.
 */
export async function installationsOfUser(code: string): Promise<Array<{ id: number; accountLogin: string }>> {
  const config = requireConfig();
  const exchange = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code }),
    cache: "no-store",
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  const token = userTokenSchema.safeParse(exchange.ok ? await exchange.json() : null);
  if (!token.success) throw new Error("GitHub did not return a user token");

  const found: Array<{ id: number; accountLogin: string }> = [];
  for (let page = 1; page <= 5; page += 1) {
    const res = await fetch(`${GITHUB_API}/user/installations?per_page=100&page=${page}`, {
      headers: githubHeaders(token.data.access_token),
      cache: "no-store",
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    const parsed = userInstallationsSchema.safeParse(res.ok ? await res.json() : null);
    if (!parsed.success) throw new Error("Failed to list the user's installations");
    found.push(...parsed.data.installations.map((i) => ({ id: i.id, accountLogin: i.account.login })));
    if (parsed.data.installations.length < 100) break;
  }
  return found;
}
