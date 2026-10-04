import type { Page } from "@playwright/test";

export type CspViolation = { page: string; directive: string; blocked: string; source: string };

declare global {
  interface Window {
    __reportCspViolation?: (violation: Omit<CspViolation, "page">) => void;
  }
}

/**
 * Collects what the Content-Security-Policy would block, on every page the
 * test visits. Browsers fire `securitypolicyviolation` for Report-Only
 * policies too, so a page that would break once the policy is enforced
 * fails the test now. Returns the list, filled as the test runs.
 */
export async function watchCspViolations(page: Page): Promise<CspViolation[]> {
  const violations: CspViolation[] = [];
  await page.exposeFunction("__reportCspViolation", (violation: Omit<CspViolation, "page">) => {
    violations.push({ page: page.url(), ...violation });
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__reportCspViolation?.({
        directive: event.violatedDirective,
        blocked: event.blockedURI,
        source: `${event.sourceFile}:${event.lineNumber}`,
      });
    });
  });
  return violations;
}
