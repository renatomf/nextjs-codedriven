import { DomainError } from "@/shared/errors";
import { logger } from "@/shared/logger";
import { chunkProjectFiles } from "@/lib/analysis/chunking";
import {
  AnalysisCanceledError,
  setProjectProgress,
} from "@/lib/analysis/progress";
import { loadProjectSourceFiles } from "@/lib/analysis/project-files";
import { generateProjectReport, type StageOptions } from "@/lib/analysis/report";
import { embedProjectChunkBatch, storeProjectChunks } from "@/modules/ingestion/server";
import { traced } from "@/shared/tracing";

// `userId` must come from the server session: every step below is scoped by
// it, so a projectId sent by the client can never reach another user's data.
// The stages run as workflow steps (analysis-workflow.ts, ADR-005): each one
// can run again after a failure, so each one must be safe to repeat.

export type { StageOptions };

/** Progress update that doubles as a checkpoint: stops the run if canceled. */
async function checkpoint(
  userId: string,
  projectId: string,
  options: Parameters<typeof setProjectProgress>[2],
) {
  if (!(await setProjectProgress(userId, projectId, options))) {
    throw new AnalysisCanceledError();
  }
}

export async function buildProjectKnowledge(
  userId: string,
  projectId: string,
  { finalAttempt = true }: StageOptions = {},
): Promise<{
  chunkCount: number;
  fileCount: number;
}> {
  await checkpoint(userId, projectId, {
    step: "Creating code knowledge",
    percent: 40,
    status: "processing",
    errorMessage: null,
  });

  try {
    const { files, drafts } = await loadDrafts(userId, projectId);

    await checkpoint(userId, projectId, {
      step: "Chunking source files",
      percent: 50,
      fileCount: files.length,
    });

    await checkpoint(userId, projectId, {
      step: "Generating embeddings",
      percent: 65,
    });

    const chunkCount = await storeProjectChunks(userId, projectId, drafts);

    await checkpoint(userId, projectId, {
      step: "Code knowledge ready",
      percent: 75,
      fileCount: files.length,
    });

    return { chunkCount, fileCount: files.length };
  } catch (error) {
    return knowledgeFailure(error, userId, projectId, finalAttempt);
  }
}

/** Chunks embedded per workflow step: ~120 s on the Hobby CPU (ADR-006). */
export const EMBED_BATCH_SIZE = 1_000;

/**
 * One batch of the embedding, as its own workflow step (ADR-006, TD-46): a
 * project near the 1,000-file limit has ~3,100 chunks, ~370 s of embedding,
 * more than one step's 300 s. Embeds up to EMBED_BATCH_SIZE chunks without
 * a vector and keeps them for `buildProjectKnowledge`, which then only
 * swaps the knowledge. Returns how many chunks are still missing.
 */
export async function embedKnowledgeBatch(
  userId: string,
  projectId: string,
  { finalAttempt = true }: StageOptions = {},
): Promise<number> {
  await checkpoint(userId, projectId, {
    step: "Generating embeddings",
    percent: 40,
    status: "processing",
    errorMessage: null,
  });

  try {
    const { drafts } = await loadDrafts(userId, projectId);
    const { remaining } = await embedProjectChunkBatch(userId, projectId, drafts, EMBED_BATCH_SIZE);
    return remaining;
  } catch (error) {
    return knowledgeFailure(error, userId, projectId, finalAttempt);
  }
}

/** The project's files and their chunks: recomputed in each step, never passed between them. */
async function loadDrafts(userId: string, projectId: string) {
  const files = await traced("pipeline.load_files", {}, () =>
    loadProjectSourceFiles(userId, projectId),
  );
  if (files.length === 0) {
    throw new DomainError("No JavaScript/TypeScript source files found to analyze.");
  }
  const drafts = await traced("pipeline.chunk", { files: files.length }, async () =>
    chunkProjectFiles(files),
  );
  return { files, drafts };
}

/**
 * Shared failure rule of the knowledge stages. errorMessage is shown to the
 * user: a DomainError explains the problem (e.g. no JS/TS files); raw errors
 * (DB, model download) may carry internals, so they become a generic message
 * (TD-33). While the workflow will retry, a transient failure is not written.
 */
async function knowledgeFailure(
  error: unknown,
  userId: string,
  projectId: string,
  finalAttempt: boolean,
): Promise<never> {
  if (error instanceof AnalysisCanceledError) throw error;

  const isDomain = error instanceof DomainError;
  if (!isDomain && !finalAttempt) {
    logger.warn("analysis.knowledge_retrying", { err: error, userId, projectId });
    throw error;
  }
  const stillExists = await setProjectProgress(userId, projectId, {
    step: "Knowledge build failed",
    percent: 65,
    status: "failed",
    errorMessage: isDomain ? error.message : "Failed to build code knowledge base.",
  });
  // Deleted mid-step (canceled): the failed write was the FK, not a bug.
  if (!stillExists) throw new AnalysisCanceledError();

  if (isDomain) {
    logger.warn("analysis.knowledge_rejected", { err: error, userId, projectId });
  } else {
    logger.error("analysis.knowledge_failed", { err: error, userId, projectId });
  }
  throw error;
}

/** Second stage: metrics, LLM review and the stored report. */
export async function generateReportStage(
  userId: string,
  projectId: string,
  options: StageOptions = {},
): Promise<void> {
  await checkpoint(userId, projectId, {
    step: "Running analysis",
    percent: 80,
    status: "processing",
  });

  await checkpoint(userId, projectId, {
    step: "Generating report",
    percent: 90,
  });

  await generateProjectReport(userId, projectId, options);
}

/** Last stage: the run is done. */
export async function completeAnalysis(userId: string, projectId: string): Promise<void> {
  await checkpoint(userId, projectId, {
    step: "Complete",
    percent: 100,
    status: "completed",
    errorMessage: null,
  });
}
