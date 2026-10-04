import { describe, expect, it } from "vitest";

import { buildCsp, newNonce, sentryReportUri } from "./csp";

const DSN = "https://abc123@o4500000000000001.ingest.us.sentry.io/4500000000000002";

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split("; ").map((part) => {
      const [name, ...values] = part.split(" ");
      return [name, values] as const;
    }),
  );
}

const prod = directives(
  buildCsp({
    nonce: "n0nce",
    isDev: false,
    sentryDsn: DSN,
    storageEndpoint: "https://bucket.example.neon.tech/some/path",
    environment: "production",
  }),
);

describe("buildCsp", () => {
  it("only runs scripts with this request's nonce (no inline, no eval)", () => {
    expect(prod.get("script-src")).toEqual(["'self'", "'nonce-n0nce'", "'strict-dynamic'"]);
  });

  it("allows eval only in development", () => {
    const dev = directives(buildCsp({ nonce: "n", isDev: true }));
    expect(dev.get("script-src")).toContain("'unsafe-eval'");
    expect(prod.get("script-src")).not.toContain("'unsafe-eval'");
  });

  it("guards scripts with the nonce, not styles (libraries inject <style> at runtime)", () => {
    expect(prod.get("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(prod.get("script-src")).not.toContain("'unsafe-inline'");
  });

  it("connects only to the app, Sentry and the upload bucket (origins only)", () => {
    expect(prod.get("connect-src")).toEqual([
      "'self'",
      "https://o4500000000000001.ingest.us.sentry.io",
      "https://bucket.example.neon.tech",
    ]);
  });

  it("drops what is not configured or not https", () => {
    const bare = directives(
      buildCsp({ nonce: "n", isDev: false, storageEndpoint: "http://insecure.test", sentryDsn: "not a url" }),
    );
    expect(bare.get("connect-src")).toEqual(["'self'"]);
    expect(bare.has("report-uri")).toBe(false);
  });

  it("keeps plugins, base tags and framing out", () => {
    expect(prod.get("object-src")).toEqual(["'none'"]);
    expect(prod.get("base-uri")).toEqual(["'self'"]);
    expect(prod.get("frame-ancestors")).toEqual(["'none'"]);
    expect(prod.get("default-src")).toEqual(["'self'"]);
  });

  it("lets forms go only to the app, the OAuth providers and Stripe", () => {
    expect(prod.get("form-action")).toEqual([
      "'self'",
      "https://github.com",
      "https://accounts.google.com",
      "https://checkout.stripe.com",
      "https://billing.stripe.com",
    ]);
  });

  it("reports violations to Sentry, tagged with the environment", () => {
    expect(prod.get("report-uri")).toEqual([
      "https://o4500000000000001.ingest.us.sentry.io/api/4500000000000002/security/?sentry_key=abc123&sentry_environment=production",
    ]);
  });
});

describe("sentryReportUri", () => {
  it("refuses a DSN without a key or a numeric project", () => {
    expect(sentryReportUri("https://o1.ingest.sentry.io/1")).toBeNull();
    expect(sentryReportUri("https://key@o1.ingest.sentry.io/abc")).toBeNull();
    expect(sentryReportUri(undefined)).toBeNull();
  });
});

describe("newNonce", () => {
  it("is 128 random bits in base64, new every time", () => {
    const nonces = new Set(Array.from({ length: 50 }, newNonce));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});
