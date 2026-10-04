import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { GITHUB_OAUTH_NONCE_COOKIE, verifyGitHubOAuthState } from "@/lib/github";
import { installationsOfUser } from "@/lib/github-app";
import { saveGitHubInstallation } from "@/modules/identity/server";
import { logger, requestIdFrom } from "@/shared/logger";

const callbackSchema = z.object({
  code: z.string().min(1).max(512),
  state: z.string().min(1).max(2048),
  installationId: z.coerce.number().int().positive(),
});

// Fixed codes only: nothing GitHub sends is reflected into the URL.
type CallbackResult =
  | "connected"
  | "approval_requested"
  | "missing_code"
  | "invalid_state"
  | "installation_not_yours"
  | "exchange_failed";

// Our own fixed paths on the origin that served the request: previews have
// no AUTH_URL, and nothing from the query string chooses the target.
function redirectToSettings(request: NextRequest, result: CallbackResult) {
  const url = new URL("/settings", request.nextUrl.origin);
  if (result === "connected") url.searchParams.set("github", "connected");
  else url.searchParams.set("github_error", result);

  const response = NextResponse.redirect(url);
  // The nonce is single-use: dropped whatever the outcome.
  response.cookies.delete(GITHUB_OAUTH_NONCE_COOKIE);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/**
 * GitHub sends the user back here after installing (or updating) the
 * GitHub App, with `installation_id` and a `code` (ADR-007). The id in the
 * URL can be forged: it is linked to the user only if GitHub, asked with the
 * user's own token, lists it among the user's installations.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL("/login", request.nextUrl.origin));
  }

  const params = request.nextUrl.searchParams;
  // An org member asked an admin to approve the install: nothing to link yet.
  if (params.get("setup_action") === "request") {
    return redirectToSettings(request, "approval_requested");
  }

  const parsed = callbackSchema.safeParse({
    code: params.get("code"),
    state: params.get("state"),
    installationId: params.get("installation_id"),
  });
  if (!parsed.success) return redirectToSettings(request, "missing_code");

  // Signed by us, fresh, this browser's nonce and the logged-in user (CSRF,
  // linking someone else's installation to this account).
  const validState = verifyGitHubOAuthState(parsed.data.state, {
    sessionUserId: session.user.id,
    nonce: request.cookies.get(GITHUB_OAUTH_NONCE_COOKIE)?.value,
  });
  if (!validState) return redirectToSettings(request, "invalid_state");

  try {
    const mine = await installationsOfUser(parsed.data.code);
    const installation = mine.find((i) => i.id === parsed.data.installationId);
    if (!installation) {
      logger.warn("github.installation_not_yours", { requestId: requestIdFrom(request.headers) });
      return redirectToSettings(request, "installation_not_yours");
    }

    await saveGitHubInstallation(session.user.id, {
      installationId: installation.id,
      accountLogin: installation.accountLogin,
    });
    return redirectToSettings(request, "connected");
  } catch (error) {
    logger.error("github.app_callback_failed", { err: error, requestId: requestIdFrom(request.headers) });
    return redirectToSettings(request, "exchange_failed");
  }
}
