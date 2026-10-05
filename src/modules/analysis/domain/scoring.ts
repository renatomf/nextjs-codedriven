import type { Finding, IssueCategory, IssueSeverity } from "./finding";
import type { ProjectMeasures } from "./rules";

export type CategoryScores = Record<IssueCategory, number>;
export type CategorySummaries = Record<IssueCategory, string>;

/**
 * Why a report came out without the AI review (graceful degradation,
 * roadmap Phase 5): its score covers the deterministic checks only.
 * - disabled: the report's kill switch is off;
 * - budget: the user's daily AI token budget is spent;
 * - unavailable: the AI provider kept failing.
 */
export type AiReviewSkip = "disabled" | "budget" | "unavailable";

export const SEVERITY_PENALTY: Record<IssueSeverity, number> = {
  critical: 20,
  high: 12,
  medium: 6,
  low: 2,
};

/** Turns what the analysis found into category scores and a health score. */
export type ScoringPolicy = (input: {
  measures: ProjectMeasures;
  findings: Finding[];
}) => { categoryScores: CategoryScores; healthScore: number };

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Base score minus a linear, uncapped penalty per finding of the category. */
export function scoreFromIssues(
  base: number,
  issues: Finding[],
  category: IssueCategory,
): number {
  const penalty = issues
    .filter((issue) => issue.category === category)
    .reduce((sum, issue) => sum + SEVERITY_PENALTY[issue.severity], 0);
  return clampScore(base - penalty);
}

/**
 * ADR-010: the penalty of a finding. A grouped finding pays its most severe
 * occurrence in full and each further occurrence half of the previous one,
 * so repetitions weigh at most 2x one occurrence and never zero a category.
 */
export function findingPenalty(finding: Finding): number {
  if (!finding.occurrences?.length) return SEVERITY_PENALTY[finding.severity];
  return finding.occurrences.reduce(
    (sum, occurrence, index) => sum + SEVERITY_PENALTY[occurrence.severity] * 0.5 ** index,
    0,
  );
}

function scoreWith(
  penalty: (finding: Finding) => number,
  base: number,
  findings: Finding[],
  category: IssueCategory,
): number {
  const total = findings
    .filter((finding) => finding.category === category)
    .reduce((sum, finding) => sum + penalty(finding), 0);
  return clampScore(base - total);
}

/** Code Quality points per percentage point of functions over `LONG_FUNCTION_LINES` (ADR-010, TD-50). */
const LONG_FUNCTION_WEIGHT = 4;

/**
 * Base per category, adjusted by a few measures. Testing (ADR-010 review,
 * 2026-10-04): no test file at all → 0; otherwise 40 + 0.6 × the share of
 * logic files with tests, so every point of coverage counts. Code Quality
 * (2026-10-05): 100 − 4 × the share of functions longer than ESLint's
 * default, so a quarter of them reaches 0. The other bases are unchanged
 * since v1.
 */
function categoryBases(measures: ProjectMeasures): CategoryScores {
  const longFunctionPercent =
    measures.functionCount === 0 ? 0 : (100 * measures.longFunctionCount) / measures.functionCount;
  return {
    architecture: 88,
    security: measures.secretHits.length > 0 ? 70 : 90,
    performance: 86,
    codeQuality: 100 - LONG_FUNCTION_WEIGHT * longFunctionPercent,
    testing: measures.testFileCount === 0 ? 0 : 40 + 0.6 * measures.testedSourceApproxPercent,
  };
}

/**
 * Deterministic Code Quality findings (long functions, large files) stay in
 * the report but are not charged again: the Code Quality base already
 * measures function length (TD-50). LLM findings are always charged.
 */
function isCharged(finding: Finding): boolean {
  return !(finding.category === "codeQuality" && finding.rule);
}

function healthOf(categoryScores: CategoryScores): number {
  return clampScore(
    (categoryScores.architecture +
      categoryScores.security +
      categoryScores.performance +
      categoryScores.codeQuality +
      categoryScores.testing) /
      5,
  );
}

/**
 * ADR-010 (current): the category bases minus `findingPenalty` per charged
 * finding; the health score is the plain average. Expects grouped findings
 * (`buildReportFindings`).
 */
export const diminishingPenaltyPolicy: ScoringPolicy = ({ measures, findings: all }) => {
  const bases = categoryBases(measures);
  const findings = all.filter(isCharged);
  const categoryScores = Object.fromEntries(
    (Object.keys(bases) as IssueCategory[]).map((category) => [
      category,
      scoreWith(findingPenalty, bases[category], findings, category),
    ]),
  ) as CategoryScores;
  return { categoryScores, healthScore: healthOf(categoryScores) };
};

/**
 * v1 policy, kept for the eval's before x after: a base per category minus
 * a linear, uncapped penalty per finding (one repeated rule could zero a
 * category).
 */
export const linearPenaltyPolicy: ScoringPolicy = ({ measures, findings }) => {
  const categoryScores: CategoryScores = {
    architecture: scoreFromIssues(88, findings, "architecture"),
    security: scoreFromIssues(
      measures.secretHits.length > 0 ? 70 : 90,
      findings,
      "security",
    ),
    performance: scoreFromIssues(86, findings, "performance"),
    codeQuality: scoreFromIssues(
      measures.largeFiles.length + measures.complexFunctions.length > 8 ? 72 : 85,
      findings,
      "codeQuality",
    ),
    testing: scoreFromIssues(
      Math.max(40, measures.testedSourceApproxPercent),
      findings,
      "testing",
    ),
  };

  const healthScore = clampScore(
    (categoryScores.architecture +
      categoryScores.security +
      categoryScores.performance +
      categoryScores.codeQuality +
      categoryScores.testing) /
      5,
  );

  return { categoryScores, healthScore };
};
