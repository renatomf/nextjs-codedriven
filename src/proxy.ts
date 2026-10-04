import NextAuth from "next-auth";
import { NextResponse } from "next/server";

import { authConfig, isProtectedPath } from "@/lib/auth.config";
import { buildCsp, newNonce } from "@/shared/csp";

const { auth } = NextAuth(authConfig);

/**
 * Every page request: the session check for protected pages, then a fresh
 * nonce and the Content-Security-Policy (TD-34), sent as Report-Only while
 * the reports are reviewed. Next.js reads the policy from the request
 * headers and puts the nonce on its own scripts.
 */
export default auth((request) => {
  // With a handler, Auth.js no longer redirects on its own when
  // `authorized` says no: the redirect is done here, as it would be.
  const { pathname } = request.nextUrl;
  if (isProtectedPath(pathname) && !request.auth) {
    const signIn = new URL("/login", request.nextUrl);
    signIn.searchParams.set("callbackUrl", request.nextUrl.href);
    return NextResponse.redirect(signIn);
  }

  const nonce = newNonce();
  const csp = buildCsp({
    nonce,
    isDev: process.env.NODE_ENV === "development",
    sentryDsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    storageEndpoint: process.env.NEON_STORAGE_ENDPOINT,
    environment: process.env.VERCEL_ENV,
  });

  // Request headers, read by the render only: Next.js takes the nonce from
  // `content-security-policy` (before `-report-only`). Any policy the
  // request brings is replaced, so it cannot hide this nonce.
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  headers.delete("Content-Security-Policy-Report-Only");

  // No other Content-Security-Policy on the response: response headers also
  // reach the render (seen in CI and on Vercel), and a policy without this
  // nonce hid it from Next.js. Framing stays blocked by X-Frame-Options.
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy-Report-Only", csp);
  return response;
});

export const config = {
  matcher: [
    // Pages only: not API routes, the workflow routes, Next.js assets or
    // files with an extension (public/).
    "/((?!api|\\.well-known|_next/static|_next/image|favicon\\.ico|.*\\.[a-zA-Z0-9]+$).*)",
  ],
};
