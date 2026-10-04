/**
 * Content-Security-Policy (TD-34, roadmap Phase 6), built per request with a
 * fresh nonce by the proxy. Sent as `Content-Security-Policy-Report-Only`
 * first: browsers report what would be blocked, nothing breaks. Pure, so
 * every directive is unit tested.
 */

export type CspOptions = {
  nonce: string;
  /** `next dev`: React needs eval and unnamed inline styles for its overlay. */
  isDev: boolean;
  /** Public Sentry DSN: the browser SDK sends there and violations are reported there. */
  sentryDsn?: string;
  /** Neon object storage endpoint: the browser uploads ZIPs to it (ADR-011). */
  storageEndpoint?: string;
  /** Tags the reports, so preview noise can be told from production. */
  environment?: string;
};

/** Avatars come straight from the providers (`next/image` unoptimized). */
const AVATAR_HOSTS = ["https://avatars.githubusercontent.com", "https://lh3.googleusercontent.com"];

/**
 * Where a form submission may go: sign-in posts redirect to the OAuth
 * providers, and billing actions redirect to Stripe's hosted pages.
 */
const FORM_TARGETS = [
  "https://github.com",
  "https://accounts.google.com",
  "https://checkout.stripe.com",
  "https://billing.stripe.com",
];

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * Sentry's CSP report endpoint for a DSN
 * (`https://<key>@<host>/<project>` → `https://<host>/api/<project>/security/?sentry_key=<key>`).
 */
export function sentryReportUri(dsn: string | undefined, environment?: string): string | null {
  if (!dsn) return null;
  try {
    const url = new URL(dsn);
    const project = url.pathname.replace(/^\/+/, "");
    if (url.protocol !== "https:" || !url.username || !/^\d+$/.test(project)) return null;
    const report = new URL(`/api/${project}/security/`, url.origin);
    report.searchParams.set("sentry_key", url.username);
    if (environment) report.searchParams.set("sentry_environment", environment);
    return report.toString();
  } catch {
    return null;
  }
}

export function buildCsp(options: CspOptions): string {
  const nonce = `'nonce-${options.nonce}'`;
  const connect = ["'self'", originOf(options.sentryDsn), originOf(options.storageEndpoint)];
  const reportUri = sentryReportUri(options.sentryDsn, options.environment);

  const directives: Array<[string, Array<string | null | false>]> = [
    ["default-src", ["'self'"]],
    // Only scripts carrying this request's nonce, and what they load.
    ["script-src", ["'self'", nonce, "'strict-dynamic'", options.isDev && "'unsafe-eval'"]],
    ["style-src", ["'self'", options.isDev ? "'unsafe-inline'" : nonce]],
    // React `style={...}` props are attributes, which a nonce cannot cover.
    ["style-src-attr", ["'unsafe-inline'"]],
    ["img-src", ["'self'", "blob:", "data:", ...AVATAR_HOSTS]],
    ["font-src", ["'self'"]],
    ["connect-src", connect],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'", ...FORM_TARGETS]],
    ["frame-ancestors", ["'none'"]],
    ["report-uri", reportUri ? [reportUri] : []],
  ];

  return directives
    .map(([name, values]) => [name, values.filter((v): v is string => Boolean(v))] as const)
    .filter(([, values]) => values.length > 0)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

/** 128 random bits, base64: unguessable and different on every request. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}
