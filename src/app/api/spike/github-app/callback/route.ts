import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { logger } from "@/shared/logger";

import {
  appConfig,
  appJwt,
  GITHUB_API,
  githubHeaders,
  readState,
  spikeEnabled,
  STATE_COOKIE,
} from "../shared";

export const runtime = "nodejs";
export const maxDuration = 60;

type Check = { ok: boolean; detail: string };

/**
 * SPIKE (ADR-007): GitHub sends the user back here after installing the App
 * (with `code` and `installation_id`). Runs every question of the ADR and
 * answers with the results only: no token leaves this function.
 */
export async function GET(request: Request) {
  if (!spikeEnabled()) return new NextResponse(null, { status: 404 });
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const config = appConfig();
  const params = new URL(request.url).searchParams;
  const jar = await cookies();
  const state = readState(params.get("state"), jar.get(STATE_COOKIE)?.value, session.user.id, config.clientSecret);
  jar.delete(STATE_COOKIE);

  const results: Record<string, Check> = {};
  results.state = state
    ? { ok: true, detail: "state matches the cookie and the session user" }
    : { ok: false, detail: `state missing or invalid (state param ${params.get("state") ? "present" : "absent"})` };

  const code = params.get("code");
  const installationId = Number(params.get("installation_id"));
  if (!state || !code || !Number.isInteger(installationId) || installationId <= 0) {
    return NextResponse.json(
      { results, setupAction: params.get("setup_action"), hasCode: Boolean(code), hasInstallationId: Boolean(installationId) },
      { status: 400 },
    );
  }

  try {
    // 1. The user's own token proves the installation is theirs.
    const exchange = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code }),
    });
    const userToken = ((await exchange.json()) as { access_token?: string }).access_token;
    if (!userToken) {
      results.userToken = { ok: false, detail: `code exchange failed (HTTP ${exchange.status})` };
      return NextResponse.json({ results }, { status: 502 });
    }
    const mine = await fetch(`${GITHUB_API}/user/installations`, { headers: githubHeaders(userToken) });
    const mineBody = (await mine.json()) as { installations?: Array<{ id: number; account?: { login?: string } }> };
    const ids = (mineBody.installations ?? []).map((i) => i.id);
    results.ownership = ids.includes(installationId)
      ? { ok: true, detail: `installation ${installationId} is in GET /user/installations (${ids.length} total)` }
      : { ok: false, detail: `installation ${installationId} NOT in the user's installations` };
    // A spoofed id (another number) is not in the user's list either.
    const spoofed = installationId + 1;
    results.spoofedIdRefused = ids.includes(spoofed)
      ? { ok: false, detail: `spoofed id ${spoofed} was accepted` }
      : { ok: true, detail: `spoofed id ${spoofed} is not in the user's installations: refused` };
    if (!ids.includes(installationId)) return NextResponse.json({ results }, { status: 403 });

    // 2. Installation token, minted server-side with the App JWT.
    const jwt = appJwt(config.appId, config.privateKey);
    const minted = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: githubHeaders(jwt),
      body: JSON.stringify({ permissions: { contents: "read", metadata: "read" } }),
    });
    const mintedBody = (await minted.json()) as { token?: string; expires_at?: string; permissions?: Record<string, string> };
    const minutes = mintedBody.expires_at
      ? Math.round((Date.parse(mintedBody.expires_at) - Date.now()) / 60000)
      : null;
    results.installationToken = mintedBody.token
      ? { ok: true, detail: `HTTP ${minted.status}, expires in ~${minutes} min, permissions ${JSON.stringify(mintedBody.permissions)}` }
      : { ok: false, detail: `HTTP ${minted.status}` };
    if (!mintedBody.token) return NextResponse.json({ results }, { status: 502 });
    const token = mintedBody.token;

    // 3. Only the chosen repositories.
    const repos = await fetch(`${GITHUB_API}/installation/repositories?per_page=100`, { headers: githubHeaders(token) });
    const reposBody = (await repos.json()) as { total_count?: number; repositories?: Array<{ full_name: string; private: boolean }> };
    const list = reposBody.repositories ?? [];
    results.listRepositories = {
      ok: repos.ok,
      detail: `HTTP ${repos.status}: ${reposBody.total_count ?? 0} repo(s): ${list.map((r) => `${r.full_name}${r.private ? " (private)" : ""}`).join(", ")}`,
    };
    const target = list.find((r) => r.private) ?? list[0];
    if (!target) return NextResponse.json({ results }, { status: 200 });

    // 4. A token scoped to one repository downloads its zipball.
    const scoped = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: githubHeaders(jwt),
      body: JSON.stringify({
        repositories: [target.full_name.split("/")[1]],
        permissions: { contents: "read", metadata: "read" },
      }),
    });
    const scopedBody = (await scoped.json()) as { token?: string; permissions?: Record<string, string> };
    const scopedToken = scopedBody.token;
    if (!scopedToken) {
      results.scopedToken = { ok: false, detail: `HTTP ${scoped.status}` };
      return NextResponse.json({ results }, { status: 502 });
    }
    results.scopedToken = {
      ok: true,
      detail: `HTTP ${scoped.status}, one repository, permissions ${JSON.stringify(scopedBody.permissions)}`,
    };

    // Diagnosis of the zipball 404 (first run): repository state, the first
    // hop without following the redirect, and both tokens.
    const repo = await fetch(`${GITHUB_API}/repos/${target.full_name}`, { headers: githubHeaders(scopedToken) });
    const repoBody = (await repo.json()) as { size?: number; default_branch?: string; pushed_at?: string };
    results.repository = {
      ok: repo.ok,
      detail: `HTTP ${repo.status}, size ${repoBody.size} KB, default branch ${repoBody.default_branch}, pushed ${repoBody.pushed_at}`,
    };
    const hop = await fetch(`${GITHUB_API}/repos/${target.full_name}/zipball`, {
      headers: githubHeaders(scopedToken),
      redirect: "manual",
    });
    results.zipballFirstHop = {
      ok: hop.status === 302,
      detail: `HTTP ${hop.status}, location host ${hop.headers.get("location") ? new URL(hop.headers.get("location")!).host : "none"}`,
    };
    const zip = await fetch(`${GITHUB_API}/repos/${target.full_name}/zipball`, { headers: githubHeaders(scopedToken) });
    const bytes = zip.ok ? (await zip.arrayBuffer()).byteLength : 0;
    results.downloadZipball = { ok: zip.ok, detail: `scoped token: HTTP ${zip.status}, ${bytes} bytes from ${target.full_name}` };
    const zipFull = await fetch(`${GITHUB_API}/repos/${target.full_name}/zipball`, { headers: githubHeaders(token) });
    const bytesFull = zipFull.ok ? (await zipFull.arrayBuffer()).byteLength : 0;
    results.downloadZipballInstallationToken = {
      ok: zipFull.ok,
      detail: `installation-wide token: HTTP ${zipFull.status}, ${bytesFull} bytes`,
    };

    // 5. The same token cannot write.
    const write = await fetch(`${GITHUB_API}/repos/${target.full_name}/contents/spike-write-test.txt`, {
      method: "PUT",
      headers: githubHeaders(scopedToken),
      body: JSON.stringify({ message: "spike: must be refused", content: Buffer.from("no").toString("base64") }),
    });
    results.writeRefused = {
      ok: write.status === 403,
      detail: `PUT contents → HTTP ${write.status}${write.status === 403 ? " (refused)" : " (NOT refused!)"}`,
    };

    // 6. Optional: the App uninstalls itself.
    if (state.uninstall) {
      const removed = await fetch(`${GITHUB_API}/app/installations/${installationId}`, {
        method: "DELETE",
        headers: githubHeaders(jwt),
      });
      results.selfUninstall = { ok: removed.status === 204 || removed.status === 202, detail: `HTTP ${removed.status}` };
    }

    return NextResponse.json({ results });
  } catch (error) {
    logger.error("spike.github_app_failed", { err: error });
    return NextResponse.json({ results, error: "Spike failed; see the logs." }, { status: 500 });
  }
}
