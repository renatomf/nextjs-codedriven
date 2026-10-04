import type { IssueCategory, SourceFile } from "@/modules/analysis";

/**
 * Annotated eval cases for the deterministic analysis. Each case lists every
 * finding it should produce (`expected`); anything else it produces is a
 * false positive. Files are built at runtime: fake credentials never appear
 * as key-shaped literals in the source (GitHub secret scanning).
 */

export type ExpectedFinding = {
  category: IssueCategory;
  filePath: string | null;
  title: RegExp;
};

export type EvalCase = {
  name: string;
  description: string;
  files: SourceFile[];
  expected: ExpectedFinding[];
};

const lines = (count: number, line: (i: number) => string) =>
  Array.from({ length: count }, (_, i) => line(i)).join("\n");

const fn = (name: string, bodyLines: number) =>
  [`export function ${name}() {`, lines(bodyLines, (i) => `  const v${i} = ${i};`), "}"].join("\n");

const quoted = (value: string) => `"${value}"`;

const small = (name: string) => `export function ${name}() {\n  return 1;\n}\n`;
const test = (name: string) => `import { ${name} } from "./x";\ntest("${name}", () => ${name}());\n`;

/** A healthy project: nothing should be flagged. */
const wellTestedLib: EvalCase = {
  name: "well-tested-lib",
  description: "Small, tested library, including auth and payment code with tests.",
  files: [
    { relativePath: "src/math.ts", content: small("add") },
    { relativePath: "src/math.test.ts", content: test("add") },
    { relativePath: "src/auth/session.ts", content: small("readSession") },
    { relativePath: "src/auth/session.test.ts", content: test("readSession") },
    { relativePath: "src/payment/charge.ts", content: small("charge") },
    { relativePath: "src/payment/charge.test.ts", content: test("charge") },
  ],
  expected: [],
};

/** Real problems, one per heuristic. */
const plantedProblems: EvalCase = {
  name: "planted-problems",
  description: "One real problem per heuristic, all annotated.",
  files: [
    { relativePath: "src/big-module.ts", content: lines(900, (i) => `export const item${i} = ${i};`) },
    { relativePath: "src/report.ts", content: fn("buildEverything", 170) },
    {
      relativePath: "src/config/keys.ts",
      content: `export const apiKey = ${quoted(["live", "value", "123456"].join("-"))};\n`,
    },
    { relativePath: "src/auth/login.ts", content: small("login") },
    { relativePath: "src/billing/invoice.ts", content: small("invoice") },
    { relativePath: "src/util.ts", content: small("util") },
    { relativePath: "src/util.test.ts", content: test("util") },
    // Low coverage is planted with untested logic. Until 2026-10-04 it came
    // from counting big-module.ts and keys.ts, which hold only constants;
    // files without logic no longer count, so two untested helpers keep the
    // case at 3 of 8 logic files tested (38%, under the 40% threshold).
    { relativePath: "src/format.ts", content: small("format") },
    { relativePath: "src/parse.ts", content: small("parse") },
    {
      // A component with real logic (hooks, handlers) before its markup.
      relativePath: "src/components/Checkout.tsx",
      content: [
        "export function Checkout() {",
        lines(90, (i) => `  const step${i} = useStep(${i});`),
        "  return (",
        "    <form />",
        "  );",
        "}",
      ].join("\n"),
    },
    { relativePath: "src/components/Checkout.test.tsx", content: test("Checkout") },
    {
      relativePath: "src/components/Widget.tsx",
      content: `const token = ${quoted(["ghx", "Z9x8Y7w6V5u4"].join("-"))};
export function Widget() {
  return <div />;
}
`,
    },
    { relativePath: "src/components/Widget.test.tsx", content: test("Widget") },
  ],
  expected: [
    { category: "codeQuality", filePath: "src/big-module.ts", title: /^Large file/ },
    { category: "codeQuality", filePath: "src/report.ts", title: /^Complex function buildEverything/ },
    { category: "security", filePath: "src/config/keys.ts", title: /^Potential hardcoded secret/ },
    { category: "testing", filePath: "src/auth/login.ts", title: /^Critical area may lack tests/ },
    { category: "testing", filePath: "src/billing/invoice.ts", title: /^Critical area may lack tests/ },
    { category: "testing", filePath: null, title: /^Low test file coverage signal/ },
    { category: "codeQuality", filePath: "src/components/Checkout.tsx", title: /^Complex function Checkout/ },
    { category: "security", filePath: "src/components/Widget.tsx", title: /^Potential hardcoded secret/ },
  ],
};

/** Tests that live apart from the code and reach it through imports. */
const testsInSeparateFolder: EvalCase = {
  name: "tests-in-separate-folder",
  description:
    "Auth and billing code tested from a separate folder, through the @/ alias and a relative path: nothing should be flagged.",
  files: [
    { relativePath: "src/lib/auth/session.ts", content: small("readSession") },
    { relativePath: "src/lib/billing/charge.ts", content: small("charge") },
    {
      relativePath: "tests/integration/session.integration.test.ts",
      content: `import { readSession } from "@/lib/auth/session";
test("session", () => readSession());
`,
    },
    {
      relativePath: "tests/charges.test.ts",
      content: `import { charge } from "../src/lib/billing/charge";
test("charge", () => charge());
`,
    },
  ],
  expected: [],
};

/** Code that looks suspicious to naive heuristics but is fine. */
const falsePositiveTraps: EvalCase = {
  name: "false-positive-traps",
  description:
    "Known traps: a long JSX component, an icon file whose path contains 'auth', UI copy with the word token, plus the Phase 3 fixes as regression guards.",
  files: [
    {
      relativePath: "src/components/Dashboard.tsx",
      content: [
        "export function Dashboard() {",
        "  return (",
        "    <main>",
        lines(110, (i) => `      <p className="row">Row ${i}</p>`),
        "    </main>",
        "  );",
        "}",
      ].join("\n"),
    },
    { relativePath: "src/components/Dashboard.test.tsx", content: test("Dashboard") },
    { relativePath: "src/components/oauth-icons.tsx", content: small("GitHubIcon") },
    // Screen, not security logic: the checks run on the server.
    { relativePath: "src/components/auth/login-form.tsx", content: small("LoginForm") },
    {
      relativePath: "src/i18n/messages.ts",
      content: `export const messages = {\n  token: ${quoted("Paste your access token here")},\n};\n`,
    },
    { relativePath: "src/i18n/messages.test.ts", content: test("messages") },
    {
      relativePath: "src/test/fixtures/users.ts",
      content: `export const password = ${quoted("fixture-password-123")};\n`,
    },
    {
      relativePath: "src/app/page.tsx",
      content: ["const scores = (defaults ??", "  null) as Scores | null;", small("Page")].join("\n"),
    },
    { relativePath: "src/app/page.test.tsx", content: test("Page") },
  ],
  expected: [],
};

/**
 * A modular code base tested through each module's public API (index.ts /
 * server.ts), with files that hold no logic (a port of types, a framework
 * route that only re-exports handlers). Only the one critical file with logic
 * and no test may be flagged (found on this repository: 8 false "critical area
 * may lack tests", Testing 19, 2026-10-04).
 */
const testedThroughModuleApi: EvalCase = {
  name: "tested-through-module-api",
  description:
    "Billing tested through its server.ts and index.ts facades; a types-only port and a re-export route need no test; one untested payment file with logic is a real finding.",
  files: [
    {
      relativePath: "src/modules/billing/application/quota.ts",
      content: "export function createQuota(limit: number) {\n  if (limit < 0) throw new Error(\"limit\");\n  return { limit };\n}\n",
    },
    {
      relativePath: "src/modules/billing/domain/llm-switch.ts",
      content: "export class LlmUnavailableError extends Error {}\n",
    },
    {
      relativePath: "src/modules/billing/application/ports.ts",
      content:
        "export interface BillingRepository {\n  loadUserBilling(userId: string): Promise<{ plan: string }>;\n  onChange: (plan: string) => void;\n}\n",
    },
    {
      relativePath: "src/modules/billing/server.ts",
      content:
        'import { createQuota } from "./application/quota";\nexport function billingFor(limit: number) {\n  return createQuota(limit);\n}\n',
    },
    {
      relativePath: "src/modules/billing/index.ts",
      content: 'export { LlmUnavailableError } from "./domain/llm-switch";\n',
    },
    {
      relativePath: "src/app/api/auth/[...nextauth]/route.ts",
      content: 'import { handlers } from "@/lib/auth";\n\nexport const { GET, POST } = handlers;\n',
    },
    {
      relativePath: "src/modules/billing/quota.integration.test.ts",
      content:
        'import { billingFor } from "@/modules/billing/server";\nimport { LlmUnavailableError } from "@/modules/billing";\ntest("quota", () => billingFor(1));\n',
    },
    {
      relativePath: "src/lib/payments/refund.ts",
      content: "export function refund(amount: number) {\n  if (amount <= 0) throw new Error(\"amount\");\n  return amount;\n}\n",
    },
  ],
  expected: [
    { category: "testing", filePath: "src/lib/payments/refund.ts", title: /^Critical area may lack tests/ },
  ],
};

export const ANALYSIS_CASES: EvalCase[] = [
  wellTestedLib,
  plantedProblems,
  falsePositiveTraps,
  testsInSeparateFolder,
  testedThroughModuleApi,
];
