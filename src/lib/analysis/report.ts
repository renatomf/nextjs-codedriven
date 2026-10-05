import { DomainError } from "@/shared/errors";
import { logger } from "@/shared/logger";
import { APICallError } from "ai";
import { and, asc, eq } from "drizzle-orm";

import { codeChunks, projects, reports, type StoredLlmReview } from "@/db/schema";
import { structuredLanguageModelId } from "@/lib/ai/llm";
import { computeProjectMetrics } from "@/lib/analysis/metrics";
import { scanDependencies } from "@/lib/analysis/osv";
import { loadProjectDependencies } from "@/lib/files/storage";
import { loadProjectSourceFiles } from "@/lib/analysis/project-files";
import { reviewInputHash, runLlmHealthReview } from "@/lib/analysis/report-llm";
import type {
  AiReviewSkip,
  CategoryScores,
  CategorySummaries,
  ReportIssue,
} from "@/lib/analysis/report-types";
import { db } from "@/lib/db";
import { buildReportFindings, diminishingPenaltyPolicy, type DependencyScan } from "@/modules/analysis";
import { BillingLimitError, LlmUnavailableError } from "@/modules/billing";
import { assertLlmBudget, assertLlmEnabled, recordLlmCall } from "@/modules/billing/server";
import { setProjectStatus } from "@/modules/projects/server";
import { traced } from "@/shared/tracing";

export type GeneratedReport = {
  healthScore: number;
  categoryScores: CategoryScores;
  categorySummaries: CategorySummaries;
  issues: ReportIssue[];
  roadmap: ReportIssue[];
  /** Set when the report came out without the AI review (deterministic only). */
  aiReviewSkipped?: AiReviewSkip;
};

/** The provider refused our credentials (401/403): retrying cannot help. */
function isProviderAuthError(error: unknown): boolean {
  return APICallError.isInstance(error) && (error.statusCode === 401 || error.statusCode === 403);
}

/**
 * A new AI review, or why the report goes without one (graceful
 * degradation, roadmap Phase 5): the kill switch is off, the daily token
 * budget is spent, or the provider failed on the workflow's last attempt.
 * Earlier attempts rethrow, so the workflow retries the step first.
 */
async function reviewOrSkip(options: {
  userId: string;
  projectId: string;
  reviewInput: Parameters<typeof runLlmHealthReview>[0];
  inputHash: string;
  finalAttempt: boolean;
}): Promise<{ review: StoredLlmReview } | { skipped: AiReviewSkip }> {
  const { userId, projectId, reviewInput, inputHash, finalAttempt } = options;

  // Here, not at the entry points: every path to a new review ends here.
  try {
    await assertLlmEnabled("report");
  } catch (error) {
    if (error instanceof LlmUnavailableError) return { skipped: "disabled" };
    throw error;
  }
  try {
    await assertLlmBudget(userId);
  } catch (error) {
    if (error instanceof BillingLimitError && error.code === "llm_tokens") return { skipped: "budget" };
    throw error;
  }

  // Usage recorded on success and failure (Phase 4); recording never throws.
  const llmCall = { userId, projectId, feature: "report" as const, model: structuredLanguageModelId() };
  const llmStarted = performance.now();
  let review;
  try {
    review = await traced("report.llm_review", { chunks: reviewInput.chunks.length }, () =>
      runLlmHealthReview(reviewInput),
    );
  } catch (error) {
    await recordLlmCall({ ...llmCall, usage: null, latencyMs: performance.now() - llmStarted, ok: false });
    // A refused key fails the same way on every try (seen in production,
    // 2026-10-03: an invalid Groq key was tried three times): degrade now.
    if (!finalAttempt && !isProviderAuthError(error)) throw error;
    logger.error("analysis.llm_review_failed", { err: error, userId, projectId });
    return { skipped: "unavailable" };
  }
  await recordLlmCall({ ...llmCall, usage: review.usage, latencyMs: performance.now() - llmStarted, ok: true });
  return {
    review: {
      inputHash,
      architectureSummary: review.architectureSummary,
      securitySummary: review.securitySummary,
      performanceSummary: review.performanceSummary,
      issues: review.issues,
    },
  };
}

export type StageOptions = {
  /**
   * False while the workflow will still retry (ADR-005): a transient failure
   * is then not written to the project, so the progress page does not show
   * "failed" for a run that may still succeed. User errors (DomainError) are
   * final and always written.
   */
  finalAttempt?: boolean;
};

/**
 * Known advisories of the project's production dependencies (ADR-012). A
 * project imported before the lockfile was read is "not-scanned" until it is
 * re-analyzed; OSV failing makes it "unavailable", never a failed report.
 */
async function projectDependencyScan(userId: string, projectId: string): Promise<DependencyScan> {
  const stored = await loadProjectDependencies(userId, projectId);
  if (!stored) return { status: "not-scanned" };
  if (!stored.lockfileFound) return { status: "no-lockfile" };
  return scanDependencies(stored.dependencies);
}

/**
 * Generate and persist the project health report. `userId` must come from the
 * server session; the project is only touched if it belongs to that user.
 */
export async function generateProjectReport(
  userId: string,
  projectId: string,
  { finalAttempt = true }: StageOptions = {},
): Promise<GeneratedReport> {
  const ownedProject = and(eq(projects.id, projectId), eq(projects.userId, userId));

  const [project] = await db
    .select({ name: projects.name, framework: projects.framework })
    .from(projects)
    .where(ownedProject)
    .limit(1);

  if (!project) {
    throw new Error("Project not found");
  }

  await setProjectStatus(userId, projectId, "processing", null);

  try {
    const files = await loadProjectSourceFiles(userId, projectId);
    const dependencyScan = await traced("report.dependencies", {}, () => projectDependencyScan(userId, projectId));
    const metrics = await traced("report.metrics", { files: files.length }, async () =>
      computeProjectMetrics(files, dependencyScan),
    );

    const chunks = await db
      .select({
        filePath: codeChunks.filePath,
        content: codeChunks.content,
        startLine: codeChunks.startLine,
        endLine: codeChunks.endLine,
      })
      .from(codeChunks)
      .where(eq(codeChunks.projectId, projectId))
      // All of them: the reviewer's sample is spread over the whole project
      // (sampleForReview), not the first files in alphabetical order.
      .orderBy(asc(codeChunks.filePath), asc(codeChunks.startLine));

    if (chunks.length === 0) {
      throw new DomainError(
        "No code chunks available. Build project knowledge before generating a report.",
      );
    }

    // Same code as the stored review → same review (TD-43): the model's
    // answers vary between runs, so asking again could change the score with
    // no code change. The project's ownership was checked above.
    const reviewInput = { projectName: project.name, framework: project.framework, chunks };
    const inputHash = reviewInputHash(reviewInput);
    const [previous] = await db
      .select({ llmReview: reports.llmReview })
      .from(reports)
      .where(eq(reports.projectId, projectId))
      .limit(1);

    let llm: StoredLlmReview | null = null;
    let aiReviewSkipped: AiReviewSkip | undefined;
    if (previous?.llmReview?.inputHash === inputHash) {
      llm = previous.llmReview;
      logger.info("analysis.llm_review_reused", { userId, projectId });
    } else {
      const outcome = await reviewOrSkip({
        userId,
        projectId,
        reviewInput,
        inputHash,
        finalAttempt,
      });
      if ("skipped" in outcome) aiReviewSkipped = outcome.skipped;
      else llm = outcome.review;
    }

    // One finding per problem, most severe first (ADR-010).
    const issues = buildReportFindings(metrics.issues, llm?.issues ?? []);

    const { categoryScores, healthScore } = diminishingPenaltyPolicy({
      measures: metrics,
      findings: issues,
    });

    const categorySummaries: CategorySummaries = {
      architecture: llm?.architectureSummary ?? "",
      security: `${metrics.summaries.security} ${llm?.securitySummary ?? ""}`.trim(),
      performance: llm?.performanceSummary ?? "",
      codeQuality: metrics.summaries.codeQuality,
      testing: metrics.summaries.testing,
    };

    const roadmap = issues.slice(0, 10);

    const reportData = {
      healthScore,
      categoryScores: {
        ...categoryScores,
        summaries: categorySummaries,
        ...(aiReviewSkipped ? { aiReviewSkipped } : {}),
      },
      issues,
      // Null when skipped: the next analysis asks the model again.
      llmReview: llm,
    };

    await db
      .insert(reports)
      .values({ projectId, ...reportData })
      .onConflictDoUpdate({ target: reports.projectId, set: reportData });

    await setProjectStatus(userId, projectId, "completed", null);

    return {
      healthScore,
      categoryScores,
      categorySummaries,
      issues,
      roadmap,
      aiReviewSkipped,
    };
  } catch (error) {
    // errorMessage is shown to the user: a DomainError explains the problem;
    // raw errors (LLM provider, DB) may carry internals, so they become a
    // generic message (TD-33).
    const isDomain = error instanceof DomainError;
    if (!isDomain && !finalAttempt) {
      logger.warn("analysis.report_retrying", { err: error, userId, projectId });
      throw error;
    }
    if (isDomain) {
      logger.warn("analysis.report_rejected", { err: error, userId, projectId });
    } else {
      logger.error("analysis.report_failed", { err: error, userId, projectId });
    }
    await setProjectStatus(
      userId,
      projectId,
      "failed",
      isDomain ? error.message : "Failed to generate health report.",
    );
    throw error;
  }
}
