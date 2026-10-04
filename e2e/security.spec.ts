import { expect, test } from "@playwright/test";

import { watchCspViolations } from "./csp";

// Content-Security-Policy (TD-34), against the production build: every page
// gets a fresh nonce in a Report-Only policy, every script carries it, and
// nothing on the public pages would be blocked.

const PUBLIC_PAGES = ["/", "/login", "/register", "/data"];

function nonceOf(policy: string | undefined): string | undefined {
  return policy?.match(/'nonce-([^']+)'/)?.[1];
}

test.describe("content security policy", () => {
  for (const path of PUBLIC_PAGES) {
    test(`${path} would block nothing, and its scripts carry the nonce`, async ({ page }) => {
      const violations = await watchCspViolations(page);

      const response = await page.goto(path);
      await page.waitForLoadState("networkidle");

      const policy = response?.headers()["content-security-policy-report-only"];
      expect(policy).toContain("script-src 'self' 'nonce-");
      const nonce = nonceOf(policy);
      expect(nonce).toBeTruthy();

      // `nonce` is hidden from the DOM after load: read the property.
      const scripts = await page.locator("script").evaluateAll((nodes) =>
        nodes.map((node) => (node as HTMLScriptElement).nonce),
      );
      expect(scripts.length).toBeGreaterThan(0);
      expect(scripts.every((value) => value === nonce)).toBe(true);

      expect(violations).toEqual([]);
    });
  }

  // On Vercel the render saw a `content-security-policy` request header with
  // no script-src (2026-10-04, production): Next.js read the nonce from it
  // first and no script got one. Same request here.
  test("scripts keep the nonce when the request already carries a policy", async ({ page }) => {
    await page.setExtraHTTPHeaders({ "content-security-policy": "frame-ancestors 'none'" });
    const violations = await watchCspViolations(page);

    const response = await page.goto("/login");
    await page.waitForLoadState("networkidle");

    const nonce = nonceOf(response?.headers()["content-security-policy-report-only"]);
    const scripts = await page.locator("script").evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLScriptElement).nonce),
    );
    expect(scripts.every((value) => value === nonce)).toBe(true);
    expect(violations).toEqual([]);
  });

  test("each request gets a new nonce", async ({ request }) => {
    const first = (await request.get("/login")).headers()["content-security-policy-report-only"];
    const second = (await request.get("/login")).headers()["content-security-policy-report-only"];

    expect(nonceOf(first)).not.toEqual(nonceOf(second));
  });

  test("protected pages still send a visitor to sign in", async ({ page }) => {
    for (const path of ["/dashboard", "/settings", "/projects/new"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login\?callbackUrl=/);
    }
  });
});
