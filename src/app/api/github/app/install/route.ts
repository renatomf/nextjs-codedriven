import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import {
  createGitHubOAuthState,
  GITHUB_OAUTH_NONCE_COOKIE,
  GITHUB_OAUTH_NONCE_MAX_AGE_S,
} from "@/lib/github";
import { githubAppConfig, githubAppInstallUrl } from "@/lib/github-app";
import { logger } from "@/shared/logger";

/**
 * "Connect GitHub" (ADR-007): sends the signed-in user to install the
 * GitHub App, or change which repositories it can read. The signed state is
 * bound to the user and to this browser (nonce cookie); the callback checks
 * both, then checks with GitHub that the installation is the user's.
 */
export async function GET(request: Request) {
  // Our own paths on the origin that served the request (previews have no
  // AUTH_URL).
  const origin = new URL(request.url).origin;
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL("/login", origin));
  }

  if (!githubAppConfig()) {
    const url = new URL("/settings", origin);
    url.searchParams.set("github_error", "app_not_configured");
    return NextResponse.redirect(url);
  }

  try {
    const { state, nonce } = createGitHubOAuthState(session.user.id);
    const response = NextResponse.redirect(githubAppInstallUrl(state));
    // `lax`: the cookie must come back on GitHub's top-level redirect.
    response.cookies.set(GITHUB_OAUTH_NONCE_COOKIE, nonce, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: GITHUB_OAUTH_NONCE_MAX_AGE_S,
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    logger.error("github.app_install_failed", { err: error });
    const url = new URL("/settings", origin);
    url.searchParams.set("github_error", "oauth_error");
    return NextResponse.redirect(url);
  }
}
