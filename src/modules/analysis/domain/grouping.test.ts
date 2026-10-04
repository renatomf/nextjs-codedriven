import { describe, expect, it } from "vitest";

import type { Finding } from "./finding";
import { buildReportFindings, groupFindings } from "./grouping";
import { diminishingPenaltyPolicy, findingPenalty, linearPenaltyPolicy } from "./scoring";
import type { ProjectMeasures } from "./rules";

const finding = (overrides: Partial<Finding>): Finding => ({
  title: "t",
  description: "d",
  severity: "high",
  category: "testing",
  filePath: null,
  ...overrides,
});

const untested = (filePath: string) =>
  finding({ title: "Critical area may lack tests", filePath, rule: "untested-critical-path" });

describe("groupFindings", () => {
  it("keeps a problem found once as it is", () => {
    const single = untested("src/auth.ts");
    expect(groupFindings([single])).toEqual([single]);
  });

  it("groups one rule's repetitions into one finding listing every occurrence", () => {
    const [grouped] = groupFindings([untested("src/a.ts"), untested("src/b.ts"), untested("src/c.ts")]);

    expect(grouped).toMatchObject({
      title: "Critical areas may lack tests (3)",
      rule: "untested-critical-path",
      severity: "high",
      category: "testing",
      filePath: "src/a.ts",
    });
    expect(grouped.occurrences?.map((o) => o.filePath)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("puts the most severe occurrence first and takes its severity", () => {
    const [grouped] = groupFindings([
      finding({ rule: "complex-function", severity: "medium", filePath: "src/m.ts", category: "codeQuality" }),
      finding({ rule: "complex-function", severity: "high", filePath: "src/h.ts", category: "codeQuality" }),
    ]);

    expect(grouped.severity).toBe("high");
    expect(grouped.filePath).toBe("src/h.ts");
    expect(grouped.occurrences?.map((o) => o.severity)).toEqual(["high", "medium"]);
  });

  it("groups LLM findings only when category and title are the same", () => {
    const grouped = groupFindings([
      finding({ title: "Missing input validation", category: "security", filePath: "a.ts" }),
      finding({ title: "missing input validation ", category: "security", filePath: "b.ts" }),
      finding({ title: "Missing input validation", category: "architecture", filePath: "c.ts" }),
      finding({ title: "N+1 query", category: "security", filePath: "d.ts" }),
    ]);

    expect(grouped).toHaveLength(3);
    expect(grouped[0].occurrences).toHaveLength(2);
  });

  it("returns the report's findings grouped, most severe first", () => {
    const report = buildReportFindings(
      [untested("src/a.ts"), untested("src/b.ts")],
      [finding({ title: "Hardcoded key", severity: "critical", category: "security" })],
    );

    expect(report.map((f) => f.title)).toEqual(["Hardcoded key", "Critical areas may lack tests (2)"]);
  });
});

describe("findingPenalty (ADR-010)", () => {
  it("is the severity penalty for a single finding", () => {
    expect(findingPenalty(untested("src/a.ts"))).toBe(12);
  });

  it("halves each further occurrence, so repetitions weigh at most 2x one", () => {
    const [two] = groupFindings([untested("a"), untested("b")]);
    const [eight] = groupFindings(Array.from({ length: 8 }, (_, i) => untested(`f${i}`)));

    expect(findingPenalty(two)).toBe(12 + 6);
    expect(findingPenalty(eight)).toBeCloseTo(12 * (2 - 2 ** -7), 5);
    expect(findingPenalty(eight)).toBeLessThan(24);
  });
});

describe("diminishingPenaltyPolicy vs linearPenaltyPolicy", () => {
  // Tests exist but cover 0%: both policies start Testing at 40, so only
  // the penalty differs.
  const measures: ProjectMeasures = {
    largeFiles: [],
    complexFunctions: [],
    testFileCount: 1,
    sourceFileCount: 10,
    testedSourceApproxPercent: 0,
    untestedCriticalPaths: [],
    secretHits: [],
  };
  const eight = Array.from({ length: 8 }, (_, i) => untested(`f${i}`));

  it("one repeated rule no longer zeroes a category", () => {
    expect(linearPenaltyPolicy({ measures, findings: eight }).categoryScores.testing).toBe(0);
    expect(
      diminishingPenaltyPolicy({ measures, findings: groupFindings(eight) }).categoryScores.testing,
    ).toBe(16);
  });

  it("keeps the v1 scores when nothing repeats", () => {
    const findings = [untested("src/a.ts"), finding({ category: "security", severity: "critical" })];

    expect(diminishingPenaltyPolicy({ measures, findings })).toEqual(
      linearPenaltyPolicy({ measures, findings }),
    );
  });
});

// ADR-010 review (2026-10-04): the Testing base was max(40, %), so a project
// with no test at all scored 28 and 43% of files with tests started barely
// above it. Now: no test file at all → 0; otherwise 40 + 0.6 × %, so every
// point of coverage counts.
describe("Testing base", () => {
  const testingFor = (testedSourceApproxPercent: number, testFileCount = 1) =>
    diminishingPenaltyPolicy({
      measures: {
        largeFiles: [],
        complexFunctions: [],
        testFileCount,
        sourceFileCount: 10,
        testedSourceApproxPercent,
        untestedCriticalPaths: [],
        secretHits: [],
      },
      findings: [],
    }).categoryScores.testing;

  it("is 0 when the project has no test file at all", () => {
    expect(testingFor(0, 0)).toBe(0);
  });

  it("starts at 40 with tests and reaches 100 at full coverage", () => {
    expect(testingFor(0)).toBe(40);
    expect(testingFor(50)).toBe(70);
    expect(testingFor(100)).toBe(100);
  });

  it("rewards every point of coverage (no flat floor)", () => {
    expect(testingFor(20)).toBeGreaterThan(testingFor(0));
    expect(testingFor(43)).toBeGreaterThan(testingFor(20));
  });
});
