import { createHash, timingSafeEqual } from "node:crypto";

import { reapStuckProjects } from "@/lib/analysis/reaper";
import { logger, requestIdFrom } from "@/shared/logger";

export const runtime = "nodejs";

/** Constant-time comparison: hashing first makes both sides the same length. */
function sameSecret(received: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(received), digest(expected));
}

/**
 * Daily cron (vercel.json): fails projects stuck in "processing" (TD-11),
 * deletes abandoned uploads and removes the code of idle projects (retention).
 * Vercel calls it with `Authorization: Bearer <CRON_SECRET>`; anything else
 * is refused. Without CRON_SECRET the route never runs.
 */
export async function GET(request: Request) {
  const requestId = requestIdFrom(request.headers);
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    logger.error("cron.reaper_not_configured", { requestId });
    return Response.json({ error: "Not configured" }, { status: 500 });
  }

  if (!sameSecret(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return Response.json(await reapStuckProjects());
  } catch (error) {
    logger.error("cron.reaper_failed", { err: error, requestId });
    return Response.json({ error: "Reaper failed." }, { status: 500 });
  }
}
