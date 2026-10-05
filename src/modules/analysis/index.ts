/**
 * Public API of the analysis module — pure part (ADR-001). Safe to import
 * anywhere, including client components (no Node APIs, no database).
 */

export {
  SEVERITY_ORDER,
  sortFindings,
  type Evidence,
  type Finding,
  type IssueCategory,
  type IssueSeverity,
  type Occurrence,
} from "./domain/finding";
export {
  verifyEvidence,
  type ClaimedIssue,
  type ReviewedChunk,
} from "./domain/evidence";
export {
  dependencySeverity,
  parseNpmLockfile,
  type Advisory,
  type Dependency,
  type DependencyScan,
  type VulnerableDependency,
} from "./domain/dependencies";
export { buildReportFindings, groupFindings } from "./domain/grouping";
export {
  computeDeterministicMetrics,
  LONG_FUNCTION_LINES,
  type DeterministicMetrics,
  type FunctionSize,
  type SourceFile,
} from "./domain/metrics";
export {
  estimateRequestTokens,
  REVIEW_MAX_REQUEST_TOKENS,
  REVIEW_PROMPT,
  REVIEW_PROMPT_VERSION,
  reviewInstructions,
  reviewRequest,
} from "./domain/review-prompt";
export {
  REVIEW_BUDGET,
  sampleForReview,
  type ReviewBudget,
} from "./domain/sampling";
export {
  DETERMINISTIC_RULES,
  type ProjectMeasures,
  type Rule,
} from "./domain/rules";
export {
  SEVERITY_PENALTY,
  diminishingPenaltyPolicy,
  findingPenalty,
  linearPenaltyPolicy,
  scoreFromIssues,
  type AiReviewSkip,
  type CategoryScores,
  type CategorySummaries,
  type ScoringPolicy,
} from "./domain/scoring";
