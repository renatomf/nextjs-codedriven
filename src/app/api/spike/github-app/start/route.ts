import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";

import { appConfig, newState, spikeEnabled, STATE_COOKIE } from "../shared";

export const runtime = "nodejs";

/** SPIKE (ADR-007): sends the signed-in user to install the test App. */
export async function GET(request: Request) {
  if (!spikeEnabled()) return new NextResponse(null, { status: 404 });
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const { slug, clientSecret } = appConfig();
  const uninstall = new URL(request.url).searchParams.get("uninstall") === "1";
  const state = newState(session.user.id, clientSecret, uninstall);

  const response = NextResponse.redirect(
    `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`,
  );
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/spike/github-app",
    maxAge: 600,
  });
  return response;
}
