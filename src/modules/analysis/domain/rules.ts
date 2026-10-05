import type { Finding } from "./finding";

/** What the deterministic scan measured in a project (see `measureProject`). */
export type ProjectMeasures = {
  largeFiles: Array<{ filePath: string; lines: number }>;
  complexFunctions: Array<{ filePath: string; name: string; lines: number }>;
  /** Functions measured outside tests, and how many pass `LONG_FUNCTION_LINES`. */
  functionCount: number;
  longFunctionCount: number;
  testFileCount: number;
  sourceFileCount: number;
  testedSourceApproxPercent: number;
  untestedCriticalPaths: string[];
  secretHits: Array<{ filePath: string; line: number; hint: string }>;
};

/**
 * One heuristic of the deterministic analysis: turns measures into findings.
 * Each rule caps how many findings it reports.
 */
export type Rule = {
  id: string;
  /** Title and description of the finding that groups several occurrences. */
  group: { title: string; description: string };
  findings(measures: ProjectMeasures): Finding[];
};

export const largeFileRule: Rule = {
  id: "large-file",
  group: {
    title: "Large files",
    description: "These files are unusually large and may be harder to maintain. Consider splitting responsibilities.",
  },
  findings: ({ largeFiles }) =>
    largeFiles.slice(0, 10).map((file) => ({
      title: `Large file (${file.lines} lines)`,
      description: `This file is unusually large and may be harder to maintain. Consider splitting responsibilities.`,
      severity: file.lines >= 800 ? "high" : "medium",
      category: "codeQuality",
      filePath: file.filePath,
    })),
};

export const complexFunctionRule: Rule = {
  id: "complex-function",
  group: {
    title: "Complex functions",
    description: "These functions appear long and may have high complexity. Consider extracting helpers.",
  },
  findings: ({ complexFunctions }) =>
    complexFunctions.slice(0, 12).map((fn) => ({
      title: `Complex function ${fn.name} (${fn.lines} lines)`,
      description: `Function appears long and may have high complexity. Consider extracting helpers.`,
      severity: fn.lines >= 150 ? "high" : "medium",
      category: "codeQuality",
      filePath: fn.filePath,
    })),
};

export const lowTestCoverageRule: Rule = {
  id: "low-test-coverage",
  group: {
    title: "Low test file coverage signal",
    description: "Few source files appear to have nearby test files. This is a file-matching proxy, not runtime coverage.",
  },
  findings: ({ testedSourceApproxPercent }) =>
    testedSourceApproxPercent < 40
      ? [
          {
            title: "Low test file coverage signal",
            description: `Only about ${testedSourceApproxPercent}% of source files appear to have nearby test files. This is a file-matching proxy, not runtime coverage.`,
            severity: testedSourceApproxPercent < 15 ? "high" : "medium",
            category: "testing",
            filePath: null,
          },
        ]
      : [],
};

export const untestedCriticalPathRule: Rule = {
  id: "untested-critical-path",
  group: {
    title: "Critical areas may lack tests",
    description: "No nearby test file was found for these paths that look security/payment related.",
  },
  findings: ({ untestedCriticalPaths }) =>
    untestedCriticalPaths.slice(0, 8).map((filePath) => ({
      title: "Critical area may lack tests",
      description: `No nearby test file was found for a path that looks security/payment related.`,
      severity: "high",
      category: "testing",
      filePath,
    })),
};

export const hardcodedSecretRule: Rule = {
  id: "hardcoded-secret",
  group: {
    title: "Potential hardcoded secrets",
    description: "Possible credentials in the source. Treat each as a potential issue to review, not a confirmed vulnerability.",
  },
  findings: ({ secretHits }) =>
    secretHits.slice(0, 10).map((hit) => ({
      title: "Potential hardcoded secret",
      description: `${hit.hint} around line ${hit.line}. Treat as a potential issue to review, not a confirmed vulnerability.`,
      severity: "critical",
      category: "security",
      filePath: hit.filePath,
    })),
};

/** In report order. */
export const DETERMINISTIC_RULES: Rule[] = [
  largeFileRule,
  complexFunctionRule,
  lowTestCoverageRule,
  untestedCriticalPathRule,
  hardcodedSecretRule,
];
