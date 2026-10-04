/**
 * Project lifecycle: queued → processing → completed | failed. Pure rules;
 * the conditional SQL in infrastructure enforces the same ones atomically.
 */

export type ProjectStatus = "queued" | "processing" | "completed" | "failed";

/** An analysis is waiting or running: it can be canceled, not started again. */
export const ACTIVE_STATUSES = ["queued", "processing"] as const satisfies readonly ProjectStatus[];

/**
 * A "processing" project not updated for longer than one workflow step (the
 * function's maxDuration of 300 s + margin) is stale: its run is gone, so it
 * may restart. Every step writes progress when it starts, retries included
 * (ADR-005). A shorter window would start a second run while a slow step
 * still works.
 */
export const STALE_AFTER_SECONDS = 360;

export type AnalysisStart =
  | "completed" // nothing to do
  | "running" // a live run owns it
  | "import-failed" // no files were ever stored: create a new project
  | "code-removed" // retention removed the stored files: import them again
  | "claimable";

/** Status of a Workflow run, as the Workflow SDK reports it. */
export type AnalysisRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/**
 * Whether the analysis of `project` can start now. `runStatus` is the status
 * of the workflow run that owns the project (null when there is no run id or
 * it could not be read): a live run wins over any clock, and a finished run
 * that left the project "processing" died, so it can restart at once. Without
 * a run, the stale window decides.
 */
export function analysisStart(
  project: {
    status: ProjectStatus;
    fileCount: number;
    updatedAt: Date;
    codeRemovedAt?: Date | null;
  },
  now: Date,
  runStatus: AnalysisRunStatus | null = null,
): AnalysisStart {
  if (project.status === "completed") return "completed";
  if (project.status === "processing") {
    if (runStatus === "pending" || runStatus === "running") return "running";
    if (
      runStatus === null &&
      now.getTime() - project.updatedAt.getTime() < STALE_AFTER_SECONDS * 1000
    ) {
      return "running";
    }
  }
  // A run that would analyze stored files, but there are none: a GitHub
  // re-analysis that died before downloading, or a failed project removed.
  if (project.codeRemovedAt) return "code-removed";
  if (project.status === "failed" && project.fileCount === 0) return "import-failed";
  return "claimable";
}

/**
 * The daily reaper (TD-11) fails a project left "processing" with no write
 * for this long: far beyond one workflow step plus its retries, so only a
 * project whose run (or import request) is gone, and nobody reopened.
 */
export const STUCK_AFTER_SECONDS = 60 * 60;

/** User-facing reason for a reaped project: an import never stored files. */
export function stuckProjectMessage(fileCount: number): string {
  return fileCount === 0
    ? "The import did not finish. Please create the project again."
    : "The analysis stopped before finishing. Please try again.";
}

/**
 * Retention (roadmap Phase 6): the code of a project not used for this long
 * (files, chunks, vectors) is removed by the daily job; the project and its
 * report stay. Stated on the public data page.
 */
export const CODE_RETENTION_DAYS = 90;

/** Use is recorded at most this often (a page view is not a write each time). */
export const LAST_USED_RESOLUTION_SECONDS = 24 * 60 * 60;

/**
 * Why an action that needs the stored code was refused, and how to get it
 * back: GitHub projects download it again; a ZIP has to be uploaded again
 * (it is not kept after import).
 */
export function codeRemovedMessage(source: "github" | "upload"): string {
  const how =
    source === "github"
      ? "Use “Analyze again” to download it from GitHub."
      : "Upload the ZIP again from New analysis.";
  return `This project's code was removed after ${CODE_RETENTION_DAYS} days without use. ${how}`;
}

/** Thrown by the pipeline when the project was canceled (deleted) mid-run. */
export class AnalysisCanceledError extends Error {
  constructor() {
    super("Analysis canceled.");
    this.name = "AnalysisCanceledError";
  }
}
