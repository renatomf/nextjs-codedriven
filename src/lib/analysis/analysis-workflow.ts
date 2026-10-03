import { FatalError, getStepMetadata } from "workflow";

import { classifyStepFailure, isFinalAttempt, STEP_MAX_RETRIES } from "./step-failure";

/**
 * The analysis as a durable workflow (ADR-005): each stage of the pipeline is
 * a step, retried on transient failures, and the run survives the request
 * that started it. Rules for every step:
 * - only ids go in and out (Workflow stores step inputs, outputs and errors
 *   with the run; code, files and tokens stay in Postgres);
 * - each stage re-checks ownership and cancellation (its checkpoints);
 * - user errors and cancellation are fatal, everything else is retried.
 * Heavy modules are imported inside the steps: the workflow function itself
 * runs in a sandbox that only orchestrates.
 */

/** Runs one pipeline stage inside a step, with the retry rules above. */
async function stage(
  name: string,
  userId: string,
  projectId: string,
  run: (finalAttempt: boolean) => Promise<void>,
): Promise<void> {
  const { attempt } = getStepMetadata();
  try {
    await run(isFinalAttempt(attempt));
  } catch (error) {
    const failure = classifyStepFailure(error);
    if (failure.fatal) throw new FatalError(failure.message);
    const { logger } = await import("@/shared/logger");
    logger.warn("analysis.step_failed", { err: error, step: name, attempt, userId, projectId });
    throw new Error(failure.message);
  }
}

/** GitHub projects: fetch the code first (a new import or a re-analysis). */
async function fetchGitHubSourcesStep(
  userId: string,
  projectId: string,
  importUsageId: string | undefined,
): Promise<void> {
  "use step";
  await stage("github", userId, projectId, async (finalAttempt) => {
    const { fetchGitHubSourcesStage } = await import("@/modules/projects/server");
    await fetchGitHubSourcesStage(userId, projectId, { finalAttempt, importUsageId });
  });
}
fetchGitHubSourcesStep.maxRetries = STEP_MAX_RETRIES;

/** A ZIP uploaded to object storage: read, extract and store it first (ADR-011). */
async function fetchUploadedZipStep(
  userId: string,
  projectId: string,
  key: string,
  importUsageId: string | undefined,
): Promise<void> {
  "use step";
  await stage("upload", userId, projectId, async (finalAttempt) => {
    const { fetchUploadedZipStage } = await import("@/modules/projects/server");
    await fetchUploadedZipStage(userId, projectId, { key, importUsageId, finalAttempt });
  });
}
fetchUploadedZipStep.maxRetries = STEP_MAX_RETRIES;

async function buildKnowledgeStep(userId: string, projectId: string): Promise<void> {
  "use step";
  await stage("knowledge", userId, projectId, async (finalAttempt) => {
    const { buildProjectKnowledge } = await import("./pipeline");
    await buildProjectKnowledge(userId, projectId, { finalAttempt });
  });
}
buildKnowledgeStep.maxRetries = STEP_MAX_RETRIES;

async function generateReportStep(userId: string, projectId: string): Promise<void> {
  "use step";
  await stage("report", userId, projectId, async (finalAttempt) => {
    const { generateReportStage } = await import("./pipeline");
    await generateReportStage(userId, projectId, { finalAttempt });
  });
}
generateReportStep.maxRetries = STEP_MAX_RETRIES;

async function completeStep(userId: string, projectId: string): Promise<void> {
  "use step";
  await stage("complete", userId, projectId, async () => {
    const { completeAnalysis } = await import("./pipeline");
    await completeAnalysis(userId, projectId);
  });
}
completeStep.maxRetries = STEP_MAX_RETRIES;

/** A step that died without writing its failure (timeout, retries used up). */
async function markFailedStep(userId: string, projectId: string): Promise<void> {
  "use step";
  const { failRunningAnalysis } = await import("@/modules/projects/server");
  await failRunningAnalysis(userId, projectId, "Analysis failed. Please try again.");
}

/**
 * Options of a run (stored with it by Workflow: flags and ids only).
 * `importUsageId`: the quota record of a new import, given back on a
 * failure on our side. `uploadKey`: the object-storage key of an uploaded
 * ZIP (a key, never the bytes).
 */
export type AnalysisRunOptions = {
  fetchFromGitHub?: boolean;
  uploadKey?: string;
  importUsageId?: string;
};

export async function analysisWorkflow(
  userId: string,
  projectId: string,
  options: AnalysisRunOptions = {},
): Promise<void> {
  "use workflow";
  try {
    if (options.fetchFromGitHub) {
      await fetchGitHubSourcesStep(userId, projectId, options.importUsageId);
    }
    if (options.uploadKey) {
      await fetchUploadedZipStep(userId, projectId, options.uploadKey, options.importUsageId);
    }
    await buildKnowledgeStep(userId, projectId);
    await generateReportStep(userId, projectId);
    await completeStep(userId, projectId);
  } catch (error) {
    await markFailedStep(userId, projectId);
    throw error;
  }
}
