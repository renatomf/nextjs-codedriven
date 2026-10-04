import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import JSZip from "jszip";

import { watchCspViolations } from "./csp";

// Main user flow against the production build, a disposable Postgres and the
// fake LLM (E2E_FAKE_LLM=1): register -> upload ZIP -> analysis (real
// chunking + real embeddings) -> report -> chat. Needs the CI e2e setup
// (see .github/workflows/ci.yml); skipped when E2E_MAIN_FLOW is not set.

test.skip(!process.env.E2E_MAIN_FLOW, "Needs the e2e database and fake LLM (CI job).");

const FAKE_ISSUE = "Fake issue from the E2E test model";
const FAKE_ANSWER = /fake answer from the E2E test model/i;

async function sampleProjectZip(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("package.json", JSON.stringify({ name: "e2e-sample", dependencies: {} }));
  zip.file(
    "src/math.ts",
    [
      "export function add(a: number, b: number) {",
      "  return a + b;",
      "}",
      "",
      "export function multiply(a: number, b: number) {",
      "  return a * b;",
      "}",
    ].join("\n"),
  );
  zip.file(
    "src/greeting.ts",
    [
      "export function greet(name: string) {",
      "  return `Hello, ${name}!`;",
      "}",
    ].join("\n"),
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

test("register, upload a project, get a report, share it and chat about it", async ({
  page,
  browser,
}) => {
  test.setTimeout(5 * 60_000); // first run downloads the embedding model
  // The signed-in pages must not break once the CSP is enforced (TD-34).
  const violations = await watchCspViolations(page);

  // 1. Register (lands on the dashboard, signed in).
  await page.goto("/register");
  await page.getByLabel("First name").fill("E2E");
  await page.getByLabel("Last name").fill("Tester");
  await page.getByLabel("Email").fill(`e2e-${randomUUID()}@example.test`);
  await page.getByLabel("Password", { exact: true }).fill("e2e-password-123");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });

  // 2. Upload a ZIP.
  await page.goto("/projects/new");
  await page.getByLabel("ZIP file").setInputFiles({
    name: "e2e-sample.zip",
    mimeType: "application/zip",
    buffer: await sampleProjectZip(),
  });
  await page.getByRole("button", { name: "Upload and analyze" }).click();

  // 3. The progress page runs the analysis and redirects to the report.
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/(progress|report)/, {
    timeout: 60_000,
  });
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/report/, {
    timeout: 4 * 60_000,
  });
  await expect(page.getByText(FAKE_ISSUE).first()).toBeVisible();

  // 4. Share: a visitor without a session reads the report through the
  // public link, which is not indexable; once revoked it is a plain 404.
  await page.getByRole("button", { name: "Share report" }).click();
  await page.getByRole("button", { name: "Create link", exact: true }).click();
  const shareUrl = await page.getByLabel(/Your link/).inputValue();
  expect(shareUrl).toMatch(/\/r\/[A-Za-z0-9_-]{43}$/);

  const visitor = await browser.newContext();
  const publicPage = await visitor.newPage();
  const shared = await publicPage.goto(shareUrl);
  expect(shared?.status()).toBe(200);
  expect(shared?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect(shared?.headers()["referrer-policy"]).toBe("no-referrer");
  await expect(publicPage.getByText("Shared report · read only")).toBeVisible();
  await expect(publicPage.getByText(FAKE_ISSUE).first()).toBeVisible();
  // Read only: no way into the owner's pages.
  await expect(publicPage.getByRole("link", { name: "View all" })).toHaveCount(0);

  await page.getByRole("button", { name: "Revoke link" }).click();
  await expect(page.getByText("Link revoked. It no longer works.")).toBeVisible();
  expect((await publicPage.goto(shareUrl))?.status()).toBe(404);
  await visitor.close();

  // 5. Chat: the answer streams back with sources from the vector search.
  await page.goto(page.url().replace(/\/report$/, "/chat"));
  await page.getByPlaceholder("Ask about this codebase...").fill("What does add do?");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(FAKE_ANSWER)).toBeVisible({ timeout: 60_000 });

  // 6. Nothing in the flow would be blocked by the Content-Security-Policy.
  expect(violations).toEqual([]);
});
