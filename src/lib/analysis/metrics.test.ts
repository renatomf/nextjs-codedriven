import { computeDeterministicMetrics } from "@/lib/analysis/metrics";
import { describe, expect, it } from "vitest";

describe("computeDeterministicMetrics", () => {
  it("detects hardcoded secrets", () => {
    const metrics = computeDeterministicMetrics([
      {
        relativePath: "src/config.ts",
        content: ` const apiKey = "example-not-a-real-key-value";\n`,
      },
    ]);

    expect(metrics.secretHits.length).toBeGreaterThan(0);
    expect(metrics.issues.some((i) => i.category === "security")).toBe(true);
  });

  it("flags large files", () => {
    const content = Array.from(
      { length: 450 },
      (_, i) => `const x${i} = ${i};`,
    ).join("\n");
    const metrics = computeDeterministicMetrics([
      { relativePath: "src/huge.ts", content },
    ]);

    expect(metrics.largeFiles).toHaveLength(1);
    expect(metrics.largeFiles[0]?.filePath).toBe("src/huge.ts");
  });

  it("computes approximate test coverage signal", () => {
    const metrics = computeDeterministicMetrics([
      {
        relativePath: "src/auth.ts",
        content: "export const login = () => {};\n",
      },
      {
        relativePath: "src/auth.test.ts",
        content: "test('login', () => {});\n",
      },
      { relativePath: "src/other.ts", content: "export function x() {\n  return 1;\n}\n" },
    ]);

    expect(metrics.testFileCount).toBe(1);
    expect(metrics.sourceFileCount).toBe(2);
    expect(metrics.testedSourceApproxPercent).toBe(50);
  });

  // TD-31 regression. The start regex treated any `const x = (` as a
  // function, so a parenthesized expression was reported as a "complex
  // function" running until the braces of the following code closed (262
  // lines on this repo's report page), and the scan jumped over the real
  // long function that follows (`render` below).
  it("does not report a parenthesized const expression as a function", () => {
    const body = Array.from({ length: 90 }, (_, i) => `  const v${i} = ${i};`);
    const content = [
      "const scores = (defaults ??",
      "  null) as Scores | null;",
      "",
      "export function render() {",
      ...body,
      "}",
    ].join("\n");

    const metrics = computeDeterministicMetrics([
      { relativePath: "src/app/page.tsx", content },
    ]);

    expect(metrics.complexFunctions.map((fn) => fn.name)).not.toContain("scores");
    expect(metrics.complexFunctions.map((fn) => fn.name)).toContain("render");
  });

  it("still reports a long arrow function, even with parameters over several lines", () => {
    const body = Array.from({ length: 90 }, (_, i) => `  const v${i} = ${i};`);
    const content = ["export const handler = async (", "  req: Request,", ") => {", ...body, "};"].join(
      "\n",
    );

    const metrics = computeDeterministicMetrics([{ relativePath: "src/api.ts", content }]);

    expect(metrics.complexFunctions.map((fn) => fn.name)).toEqual(["handler"]);
  });

  it("treats test/ and tests/ folders, at the root or nested, as tests", () => {
    const metrics = computeDeterministicMetrics([
      { relativePath: "src/test/helpers.ts", content: "export const h = 1;\n" },
      { relativePath: "test/setup.ts", content: "export const s = 1;\n" },
      { relativePath: "src/tests/a.ts", content: "export const a = 1;\n" },
      { relativePath: "src/app.ts", content: "export const app = 1;\n" },
    ]);

    expect(metrics.testFileCount).toBe(3);
    expect(metrics.sourceFileCount).toBe(1);
  });

  it("does not flag fake secrets in fixtures and mocks", () => {
    const fake = ["password", " = ", '"', "fixture-value-123", '"'].join("");
    const metrics = computeDeterministicMetrics([
      { relativePath: "src/lib/__fixtures__/creds.ts", content: `${fake}\n` },
      { relativePath: "e2e/fixtures/user.ts", content: `${fake}\n` },
      { relativePath: "src/__mocks__/db.ts", content: `${fake}\n` },
      { relativePath: "src/config.ts", content: `${fake}\n` },
    ]);

    expect(metrics.secretHits.map((hit) => hit.filePath)).toEqual(["src/config.ts"]);
  });

  it("flags untested critical paths", () => {
    const metrics = computeDeterministicMetrics([
      {
        relativePath: "src/lib/payment.ts",
        content: "export function charge() {}\n",
      },
    ]);

    expect(metrics.untestedCriticalPaths).toContain("src/lib/payment.ts");
    expect(
      metrics.issues.some(
        (i) => i.category === "testing" && i.filePath === "src/lib/payment.ts",
      ),
    ).toBe(true);
  });

  // Phase 7, item 6: heuristics measured by the eval (evals/analysis).
  describe("heuristics", () => {
    const body = (n: number, line: (i: number) => string) =>
      Array.from({ length: n }, (_, i) => line(i)).join("\n");

    it("sizes a React component by its logic, not its markup", () => {
      const markupOnly = ["export function Page() {", "  return (", body(110, (i) => `    <p>${i}</p>`), "  );", "}"].join("\n");
      const logicHeavy = ["export function Form() {", body(90, (i) => `  const s${i} = useS(${i});`), "  return <form />;", "}"].join("\n");

      const metrics = computeDeterministicMetrics([
        { relativePath: "src/Page.tsx", content: markupOnly },
        { relativePath: "src/Form.tsx", content: logicHeavy },
      ]);

      expect(metrics.complexFunctions.map((fn) => fn.name)).toEqual(["Form"]);
    });

    it("counts a file imported by a test as tested (relative and @/ imports)", () => {
      const metrics = computeDeterministicMetrics([
        { relativePath: "src/lib/auth/session.ts", content: "export function s() {\n  return 1;\n}\n" },
        { relativePath: "src/lib/billing/index.ts", content: "export function b() {\n  return 1;\n}\n" },
        {
          relativePath: "tests/a.test.ts",
          content: 'import { s } from "@/lib/auth/session";\nimport { b } from "../src/lib/billing";\n',
        },
      ]);

      expect(metrics.testedSourceApproxPercent).toBe(100);
      expect(metrics.untestedCriticalPaths).toEqual([]);
    });

    it("matches critical areas on whole words of logic files only", () => {
      const metrics = computeDeterministicMetrics([
        { relativePath: "src/lib/oauth-client.ts", content: "export function o() {\n  return 1;\n}\n" },
        { relativePath: "src/components/auth/login-form.tsx", content: "export function f() {\n  return 1;\n}\n" },
        { relativePath: "src/lib/authTokens.ts", content: "export function t() {\n  return 1;\n}\n" },
      ]);

      expect(metrics.untestedCriticalPaths).toEqual(["src/lib/authTokens.ts"]);
    });

    it("does not take prose with spaces for a secret", () => {
      const quote = (text: string) => ['"', text, '"'].join("");
      const metrics = computeDeterministicMetrics([
        { relativePath: "src/copy.ts", content: `const copy = { token: ${quote("Paste your token here")} };\n` },
        { relativePath: "src/keys.ts", content: `const token = ${quote("abcd1234efgh5678")};\n` },
      ]);

      expect(metrics.secretHits.map((hit) => hit.filePath)).toEqual(["src/keys.ts"]);
    });

    // Tests often reach a module through its public API (index.ts /
    // server.ts, the facades): what a facade imports or re-exports is
    // exercised too.
    it("counts code a test reaches through a module facade as tested", () => {
      const metrics = computeDeterministicMetrics([
        {
          relativePath: "src/modules/billing/application/quota.ts",
          content: ["export function createQuota() {", "  return 1;", "}", ""].join("\n"),
        },
        {
          relativePath: "src/modules/billing/domain/llm-switch.ts",
          content: ["export class LlmUnavailableError extends Error {}", ""].join("\n"),
        },
        {
          relativePath: "src/modules/billing/server.ts",
          content: [
            'import { createQuota } from "./application/quota";',
            "export function billingFor() {",
            "  return createQuota();",
            "}",
            "",
          ].join("\n"),
        },
        {
          relativePath: "src/modules/billing/index.ts",
          content: ['export { LlmUnavailableError } from "./domain/llm-switch";', ""].join("\n"),
        },
        {
          relativePath: "src/modules/billing/quota.test.ts",
          content: [
            'import { billingFor } from "@/modules/billing/server";',
            'import { LlmUnavailableError } from "@/modules/billing";',
            'test("q", () => billingFor());',
            "",
          ].join("\n"),
        },
      ]);

      expect(metrics.untestedCriticalPaths).toEqual([]);
      expect(metrics.testedSourceApproxPercent).toBe(100);
    });

    it("does not follow imports of ordinary files (only facades)", () => {
      const metrics = computeDeterministicMetrics([
        {
          relativePath: "src/lib/payments/charge.ts",
          content: [
            'import { refund } from "./refund";',
            "export function charge() {",
            "  return refund();",
            "}",
            "",
          ].join("\n"),
        },
        {
          relativePath: "src/lib/payments/refund.ts",
          content: ["export function refund() {", "  return 1;", "}", ""].join("\n"),
        },
        {
          relativePath: "src/lib/payments/charge.test.ts",
          content: ['import { charge } from "./charge";', 'test("c", () => charge());', ""].join("\n"),
        },
      ]);

      expect(metrics.untestedCriticalPaths).toEqual(["src/lib/payments/refund.ts"]);
    });

    it("asks no tests of files without logic (types, re-exports, constant wiring)", () => {
      const metrics = computeDeterministicMetrics([
        {
          relativePath: "src/modules/billing/application/ports.ts",
          content: [
            'import type { Plan } from "../domain/plan";',
            "",
            "/** Port: (plan) => void in a comment is not code. */",
            "export interface BillingRepository {",
            "  loadUserBilling(userId: string): Promise<{ plan: Plan }>;",
            "  onChange: (plan: Plan) => void;",
            "}",
            "",
            "export type Executor = { run: () => Promise<void> };",
            "",
          ].join("\n"),
        },
        {
          relativePath: "src/app/api/auth/[...nextauth]/route.ts",
          content: ['import { handlers } from "@/lib/auth";', "", "export const { GET, POST } = handlers;", ""].join(
            "\n",
          ),
        },
        {
          relativePath: "src/lib/auth/session.ts",
          content: [
            "export function readSession(token: string) {",
            '  if (!token) throw new Error("no");',
            "  return token;",
            "}",
            "",
          ].join("\n"),
        },
      ]);

      // Only the file with logic is asked for a test, and only it counts.
      expect(metrics.untestedCriticalPaths).toEqual(["src/lib/auth/session.ts"]);
      expect(metrics.testedSourceApproxPercent).toBe(0);
    });
  });
});
