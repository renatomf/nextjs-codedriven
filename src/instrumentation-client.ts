import * as Sentry from "@sentry/nextjs";
import { z } from "zod";

import { sentryOptions } from "@/shared/sentry-options";

// No eval in the browser (CSP, TD-34): zod's fast path compiles parsers
// with `new Function`, and even its caught probe is reported as a violation.
z.config({ jitless: true });

// Browser errors and page-load/navigation traces (roadmap Phase 4). No DSN =
// off. No Session Replay: it would record the user's code on screen.
Sentry.init({
  ...sentryOptions(process.env.NEXT_PUBLIC_SENTRY_DSN, process.env.NEXT_PUBLIC_VERCEL_ENV),
  integrations: [Sentry.browserTracingIntegration()],
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
