import { logger, requestIdFrom } from "@/shared/logger";
import { z } from "zod";

import { analysisRunStatus, enqueueAnalysis } from "@/lib/analysis/analysis-job";
import { auth } from "@/lib/auth";
import { assertRateLimit, RateLimitError } from "@/lib/rate-limit";
import { analysisStart, codeRemovedMessage } from "@/modules/projects";
import {
  claimAnalysis,
  failRunningAnalysis,
  findAnalysisCandidate,
  readProgress,
  setAnalysisRunId,
} from "@/modules/projects/server";

export const runtime = "nodejs";

// Embeddings + LLM report: cost protection, keyed by userId.
const ANALYZE_MAX_PER_HOUR = 10;

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(_request: Request, context: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const { id } = await context.params;
  const parsedId = z.uuid().safeParse(id);
  if (!parsedId.success) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  const project = await findAnalysisCandidate(userId, parsedId.data);

  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  // A project owned by a run: ask Workflow whether that run is alive instead
  // of guessing from the last progress write.
  const runStatus =
    project.status === "processing" && project.analysisRunId
      ? await analysisRunStatus(project.analysisRunId)
      : null;
  const start = analysisStart(project, new Date(), runStatus);
  const deadRunId = runStatus === null ? null : project.analysisRunId;

  if (start === "completed") {
    return Response.json({
      ok: true,
      alreadyCompleted: true,
      status: project.status,
    });
  }

  const alreadyRunning = () =>
    Response.json({
      ok: true,
      alreadyRunning: true,
      status: project.status,
      progressStep: project.progressStep,
      progressPercent: project.progressPercent,
    });

  // Avoid starting a second run if one is clearly in-flight.
  if (start === "running") {
    return alreadyRunning();
  }

  if (start === "code-removed") {
    return Response.json({ error: codeRemovedMessage(project.source) }, { status: 400 });
  }

  if (start === "import-failed") {
    return Response.json(
      {
        error:
          "Import failed before files were ready. Please create a new project.",
      },
      { status: 400 },
    );
  }

  try {
    await assertRateLimit(
      `analyze:${userId}`,
      ANALYZE_MAX_PER_HOUR,
      60 * 60 * 1000,
      `Rate limit reached (${ANALYZE_MAX_PER_HOUR} analyses/hour). Try again later.`,
    );
  } catch (error) {
    if (error instanceof RateLimitError) {
      return Response.json({ error: error.message }, { status: 429 });
    }
    logger.error("analysis.request_failed", { err: error, projectId: project.id, requestId: requestIdFrom(_request.headers) });
    return Response.json({ error: "Analysis failed." }, { status: 500 });
  }

  // Atomic claim: parallel calls (two tabs, a refresh) never run twice.
  const claimed = await claimAnalysis(userId, project.id, deadRunId);

  if (!claimed) {
    return alreadyRunning();
  }

  // The analysis runs as a workflow (ADR-005): this request only starts it;
  // the progress page polls the status the steps write.
  let runId: string;
  try {
    runId = await enqueueAnalysis(userId, project.id);
  } catch (error) {
    // Not started: release the claim so the user can retry now, not after
    // the stale window.
    const requestId = requestIdFrom(_request.headers);
    logger.error("analysis.enqueue_failed", { err: error, projectId: project.id, requestId });
    await failRunningAnalysis(
      userId,
      project.id,
      "Failed to start the analysis. Please try again.",
    ).catch((releaseError: unknown) => {
      logger.error("analysis.release_failed", { err: releaseError, projectId: project.id, requestId });
    });
    return Response.json({ ok: false, status: "failed", error: "Analysis failed." }, { status: 500 });
  }

  // The run is already going: failing to record its id must not fail the
  // analysis (without it, the stale window decides, as before).
  await setAnalysisRunId(userId, project.id, runId).catch((error: unknown) => {
    logger.warn("analysis.run_id_not_saved", { err: error, projectId: project.id, runId });
  });

  const updated = await readProgress(userId, project.id);
  return Response.json({
    ok: true,
    status: updated?.status ?? "processing",
    progressStep: updated?.progressStep,
    progressPercent: updated?.progressPercent,
  });
}
