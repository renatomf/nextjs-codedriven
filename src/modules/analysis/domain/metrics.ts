import type { DependencyScan } from "./dependencies";
import type { Finding } from "./finding";
import { isTestFile, pathWords } from "./paths";
import { DETERMINISTIC_RULES, type ProjectMeasures } from "./rules";

// Pure (no Node APIs): the module's public API is also imported by the UI.

export type SourceFile = {
  relativePath: string;
  content: string;
};

/** One function of the project and its length in lines. */
export type FunctionSize = {
  filePath: string;
  name: string;
  lines: number;
};

export type DeterministicMetrics = ProjectMeasures & {
  issues: Finding[];
  summaries: {
    codeQuality: string;
    testing: string;
    security: string;
  };
};

const LARGE_FILE_LINES = 400;
/** Reported one by one as "complex function" findings. */
const COMPLEX_FUNCTION_LINES = 80;
/** Counted in the Code Quality score: ESLint's `max-lines-per-function` default (TD-50). */
export const LONG_FUNCTION_LINES = 50;

const SECRET_PATTERNS: Array<{ hint: string; regex: RegExp }> = [
  {
    hint: "Hardcoded API key / token assignment",
    regex:
      // No whitespace in the value: credentials are single tokens; UI copy
      // such as `token: "Paste your access token"` is prose.
      /\b(api[_-]?key|secret|token|password|private[_-]?key)\b\s*[:=]\s*['"][^'"\s]{8,}['"]/i,
  },
  {
    hint: "JWT-like secret literal",
    regex: /\bjwt[_-]?secret\b\s*[:=]\s*['"][^'"]+['"]/i,
  },
  {
    hint: "AWS-style access key pattern",
    regex: /AKIA[0-9A-Z]{16}/,
  },
];

/** Test data (fixtures, mocks): fake secrets there are expected. */
function isTestSupportFile(filePath: string): boolean {
  return /(^|\/)(__fixtures__|fixtures|__mocks__)\//.test(filePath);
}

function stripExt(filePath: string): string {
  return filePath.replace(/\.(jsx?|tsx?)$/i, "");
}

function guessSourceFromTest(testPath: string): string {
  return stripExt(testPath)
    .replace(/\.test$/i, "")
    .replace(/\.spec$/i, "")
    .replace(/\/__tests__\//, "/")
    .replace(/\/tests?\//, "/");
}

// Static `import … from "x"` / `export … from "x"` / `import "x"` only where a
// statement starts (an import quoted inside a string, e.g. a test fixture, is
// not one), plus `import("x")` and `require("x")` (not vi.mock strings).
const IMPORT_SPECIFIER =
  /(?:^[ \t]*(?:import|export)\b[^;'"`]*?\bfrom\s*|^[ \t]*import\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/gm;
// `vi.mock("x")` / `jest.mock("x")`: the module is replaced, its code never runs.
const MOCK_SPECIFIER = /\b(?:vi|jest)\.mock\s*\(\s*["']([^"']+)["']/g;

/**
 * Source path (without extension) a test imports, or null for packages.
 * Resolves relative imports and the `@/` alias (`src/`, the Next.js default).
 */
function resolveImport(testPath: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) return stripExt(`src/${specifier.slice(2)}`);
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const parts = testPath.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return stripExt(parts.join("/"));
}

/** A path without extension and without a trailing `/index`: how imports name it. */
function moduleKey(path: string): string {
  return stripExt(path).replace(/\/index$/, "");
}

/** A module's public API (`index.ts` / `server.ts`): tests reach the module through it. */
function isFacade(filePath: string): boolean {
  return /(^|\/)(index|server)\.[jt]sx?$/i.test(filePath);
}

/** Comments and string contents removed, so they cannot look like code. */
function codeOnly(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1")
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
}

/** Removes top-level `interface` / `type` declarations, whatever they span. */
function withoutTypeDeclarations(code: string): string {
  const declaration = /(^|\n)[ \t]*(?:export[ \t]+)?(?:declare[ \t]+)?(interface|type)[ \t]+\w/g;
  let out = "";
  let from = 0;
  for (let match = declaration.exec(code); match; match = declaration.exec(code)) {
    if (match.index < from) continue;
    out += code.slice(from, match.index);
    let depth = 0;
    let end = code.length;
    for (let i = match.index + match[0].length; i < code.length; i += 1) {
      const ch = code[i];
      // The `>` of an arrow (`=>`) closes nothing.
      if (ch === ">" && code[i - 1] === "=") continue;
      if ("{([<".includes(ch)) depth += 1;
      else if ("})]>".includes(ch)) {
        depth -= 1;
        // An interface ends with its body's closing brace.
        if (depth === 0 && ch === "}" && match[2] === "interface") {
          end = i + 1;
          break;
        }
      } else if (depth === 0 && (ch === ";" || ch === "\n") && match[2] === "type") {
        // A type alias ends at `;`, or at a line break outside any bracket
        // that does not continue the type (`|`, `&`, `=` on the next line).
        const rest = code.slice(i + 1).trimStart();
        if (ch === ";" || !/^[|&=]/.test(rest)) {
          end = i + 1;
          break;
        }
      }
    }
    from = end;
    declaration.lastIndex = end;
  }
  return out + code.slice(from);
}

/**
 * Whether a file has logic worth a test: functions, classes or control
 * flow. Type declarations, imports, re-exports and constant wiring (e.g.
 * `export const { GET, POST } = handlers;`) have none.
 */
function hasLogic(content: string): boolean {
  const code = withoutTypeDeclarations(codeOnly(content))
    .replace(/(^|\n)\s*import[^;\n]*(?:;|\n)/g, "$1")
    .replace(/(^|\n)\s*export\s+(?:type\s+)?(?:\*|\{[^}]*\})(?:\s+as\s+\w+)?\s+from\s+""\s*;?/g, "$1");
  return /=>|\bfunction\b|\bclass\b|\b(?:if|for|while|switch|catch)\s*\(|\btry\s*\{|\bnew\s+\w|\bawait\b|\breturn\b|\bthrow\b/.test(
    code,
  );
}

/** What the report says about the dependency scan (ADR-012), after the secrets. */
function dependencySummary(scan: DependencyScan): string {
  switch (scan.status) {
    case "scanned":
      return ` ${scan.vulnerable.length} of ${scan.dependencyCount} production dependencies have known advisories (OSV).`;
    case "no-lockfile":
      return " No npm lockfile: dependency versions, and their advisories, are unknown.";
    case "unavailable":
      return " The advisory database did not answer: dependencies were not checked this time.";
    case "not-scanned":
      return "";
  }
}

/**
 * Compute code-quality, testing, and simple security signals without an LLM.
 * `functions` are the sizes measured on the syntax tree (`measureFunctions`
 * in src/lib/analysis): parsing needs a native parser, the domain stays pure.
 */
export function computeDeterministicMetrics(
  files: SourceFile[],
  functions: FunctionSize[],
  dependencyScan: DependencyScan,
): DeterministicMetrics {
  const sourceFiles = files.filter((file) => !isTestFile(file.relativePath));
  const testFiles = files.filter((file) => isTestFile(file.relativePath));

  const largeFiles = sourceFiles
    .map((file) => ({
      filePath: file.relativePath,
      lines: file.content.split("\n").length,
    }))
    .filter((file) => file.lines >= LARGE_FILE_LINES)
    .sort((a, b) => b.lines - a.lines);

  const sourceFunctions = functions.filter((fn) => !isTestFile(fn.filePath));
  const longFunctionCount = sourceFunctions.filter((fn) => fn.lines > LONG_FUNCTION_LINES).length;
  // The longest first: the rule reports a capped number of them.
  const complexFunctions = sourceFunctions
    .filter((fn) => fn.lines >= COMPLEX_FUNCTION_LINES)
    .sort((a, b) => b.lines - a.lines);

  const testedBases = new Set(
    testFiles.map((file) => guessSourceFromTest(file.relativePath)),
  );
  // Files a test imports count as tested too (tests often live apart), unless
  // the same test mocks them (`vi.mock` / `jest.mock`): then they never run.
  const importedByTests = new Set<string>();
  for (const test of testFiles) {
    const mocked = new Set<string>();
    for (const [, specifier] of test.content.matchAll(MOCK_SPECIFIER)) {
      const resolved = resolveImport(test.relativePath, specifier);
      if (resolved) mocked.add(moduleKey(resolved));
    }
    for (const [, specifier] of test.content.matchAll(IMPORT_SPECIFIER)) {
      const resolved = resolveImport(test.relativePath, specifier);
      if (resolved && !mocked.has(moduleKey(resolved))) importedByTests.add(moduleKey(resolved));
    }
  }

  // What each source file imports, by module key (`server.ts` and
  // `index.ts` of one folder answer to different keys).
  const importsOf = new Map<string, { facade: boolean; targets: string[] }>();
  for (const file of sourceFiles) {
    const targets: string[] = [];
    for (const [, specifier] of file.content.matchAll(IMPORT_SPECIFIER)) {
      const resolved = resolveImport(file.relativePath, specifier);
      if (resolved) targets.push(moduleKey(resolved));
    }
    importsOf.set(moduleKey(file.relativePath), { facade: isFacade(file.relativePath), targets });
  }
  // Files reached from the tests by following imports: through every file,
  // or only through module facades (index.ts / server.ts).
  const reachedFromTests = (throughEveryFile: boolean) => {
    const reached = new Set(importedByTests);
    const pending = [...reached];
    while (pending.length > 0) {
      const node = importsOf.get(pending.pop()!);
      if (!node || (!throughEveryFile && !node.facade)) continue;
      for (const target of node.targets) {
        if (reached.has(target)) continue;
        reached.add(target);
        pending.push(target);
      }
    }
    return reached;
  };
  const testedBy = (reached: Set<string>) => (filePath: string) =>
    reached.has(moduleKey(filePath)) ||
    [...testedBases].some((tested) => tested.endsWith(stripExt(filePath)) || stripExt(filePath).endsWith(tested));

  // Calibrated against this repository's measured coverage (2026-10-04, ADR-010
  // review): following every import estimates the share of files the tests
  // run best (66% vs 63% measured), so it sets the percentage; but it also
  // takes for tested the real gaps (auth and billing code imported by tested
  // code yet never run by a test), so the critical-area rule keeps the
  // conservative reach, through module facades only.
  const isExercised = testedBy(reachedFromTests(true));
  const isTested = testedBy(reachedFromTests(false));

  // Only files with logic are expected to have tests (not types, re-exports
  // or constant wiring).
  const logicSources = sourceFiles.filter((file) => hasLogic(file.content));
  const matchedSources = logicSources.filter((file) => isExercised(file.relativePath)).length;

  const testedSourceApproxPercent =
    logicSources.length === 0
      ? 0
      : Math.round((matchedSources / logicSources.length) * 100);

  // Security/payment logic (not screens: .jsx/.tsx components render, the
  // checks run in .ts/.js), matched on whole words of the path, so
  // `oauth-icons.ts` is not an "auth" area.
  const criticalKeywords = ["auth", "payment", "billing", "password", "token"];
  const untestedCriticalPaths = logicSources
    .filter((file) => {
      if (/\.[jt]sx$/i.test(file.relativePath)) return false;
      const words = pathWords(file.relativePath);
      const looksCritical = criticalKeywords.some(
        (keyword) => words.includes(keyword) || words.includes(`${keyword}s`),
      );
      return looksCritical && !isTested(file.relativePath);
    })
    .map((file) => file.relativePath)
    .slice(0, 12);

  const secretHits: DeterministicMetrics["secretHits"] = [];
  for (const file of sourceFiles) {
    if (isTestSupportFile(file.relativePath)) continue;
    const lines = file.content.split("\n");
    lines.forEach((line, index) => {
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.regex.test(line)) {
          secretHits.push({
            filePath: file.relativePath,
            line: index + 1,
            hint: pattern.hint,
          });
          break;
        }
      }
    });
  }

  const measures: ProjectMeasures = {
    largeFiles,
    complexFunctions,
    functionCount: sourceFunctions.length,
    longFunctionCount,
    testFileCount: testFiles.length,
    sourceFileCount: sourceFiles.length,
    testedSourceApproxPercent,
    untestedCriticalPaths,
    secretHits,
    dependencyScan,
  };
  const issues = DETERMINISTIC_RULES.flatMap((rule) =>
    rule.findings(measures).map((finding) => ({ ...finding, rule: rule.id })),
  );

  return {
    ...measures,
    issues,
    summaries: {
      codeQuality: `${longFunctionCount} of ${sourceFunctions.length} function(s) have more than ${LONG_FUNCTION_LINES} lines (${complexFunctions.length} with ${COMPLEX_FUNCTION_LINES}+); ${largeFiles.length} large file(s).`,
      testing: `Matched test files for roughly ${testedSourceApproxPercent}% of source files (${testFiles.length} test files found).`,
      security: `Pattern scan found ${secretHits.length} potential hardcoded secret hit(s).${dependencySummary(dependencyScan)}`,
    },
  };
}
