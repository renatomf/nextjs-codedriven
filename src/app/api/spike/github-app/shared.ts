import "server-only";

import { createHmac, createSign, randomBytes, timingSafeEqual } from "node:crypto";

// SPIKE for ADR-007 (GitHub App). Never merged: closed after the results are
// recorded in the ADR. Preview only, signed-in users only, no token is ever
// returned or logged.

export const GITHUB_API = "https://api.github.com";
export const STATE_COOKIE = "spike_gh_app_state";

export function spikeEnabled(): boolean {
  return process.env.VERCEL_ENV === "preview";
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (Preview only).`);
  return value;
}

export function appConfig() {
  return {
    appId: required("GITHUB_APP_ID"),
    clientId: required("GITHUB_APP_CLIENT_ID"),
    clientSecret: required("GITHUB_APP_CLIENT_SECRET"),
    // Vercel keeps real newlines; a pasted `\n` form works too.
    privateKey: required("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
    slug: required("GITHUB_APP_SLUG"),
  };
}

const base64url = (input: Buffer | string) =>
  Buffer.from(input).toString("base64url");

/** App JWT (RS256), valid 9 minutes, backdated 60 s for clock drift. */
export function appJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64url(signer.sign(privateKey))}`;
}

export function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "codedriven-spike",
  };
}

/** `<userId>.<random>.<hmac>`: bound to the session user, checked on return. */
export function newState(userId: string, secret: string, uninstall: boolean): string {
  const body = `${userId}.${uninstall ? "u" : "k"}.${randomBytes(16).toString("base64url")}`;
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function readState(
  state: string | null,
  cookie: string | undefined,
  userId: string,
  secret: string,
): { uninstall: boolean } | null {
  if (!state || !cookie || state !== cookie) return null;
  const parts = state.split(".");
  if (parts.length !== 4) return null;
  const [owner, mode, nonce, mac] = parts;
  const expected = createHmac("sha256", secret).update(`${owner}.${mode}.${nonce}`).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (owner !== userId) return null;
  return { uninstall: mode === "u" };
}
