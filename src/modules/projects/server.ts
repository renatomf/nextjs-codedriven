import "server-only";

/**
 * Public API of the projects module — server part (ADR-001). Every write to a
 * project's status goes through here. Every `userId` must come from the
 * server session, never from the client.
 */

export {
  cancelActiveAnalysis,
  claimAnalysis,
  deleteProject,
  failRunningAnalysis,
  failStuckProject,
  findAnalysisCandidate,
  findStuckProjects,
  readProgress,
  requeueIdleProject,
  setAnalysisRunId,
  setProjectProgress,
  setProjectStatus,
  startReanalysis,
} from "./infrastructure/drizzle-project-lifecycle";
export {
  ArchiveError,
  assertGitHubSourceReady,
  fetchGitHubSourcesStage,
  fetchUploadedZipStage,
  importArchive,
  startGitHubImport,
  startUploadImport,
} from "./infrastructure/import-archive";
export {
  createReportShare,
  findSharedReport,
  getReportShareState,
  revokeReportShare,
  type SharedReport,
} from "./infrastructure/drizzle-report-shares";
export {
  findExistingImport,
  findOwnedProject,
  findReanalysisTarget,
  getChatProject,
  getProjectIssues,
  getProjectProgress,
  getProjectReport,
  getProjectSummary,
  listUserProjects,
} from "./infrastructure/drizzle-project-queries";
