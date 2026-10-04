/**
 * Public API of the projects module — pure part (ADR-001). Safe to import
 * anywhere. Database-bound code is in `./server`.
 */

export {
  AnalysisCanceledError,
  analysisStart,
  type AnalysisRunStatus,
  type AnalysisStart,
  CODE_RETENTION_DAYS,
  codeRemovedMessage,
  type ProjectStatus,
  STUCK_AFTER_SECONDS,
  stuckProjectMessage,
} from "./domain/project";
export {
  DEFAULT_SHARE_EXPIRY,
  SHARE_EXPIRY_OPTIONS,
  type ShareExpiry,
} from "./domain/report-share";
