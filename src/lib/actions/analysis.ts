"use server";
import { publicErrorMessage } from "@/shared/public-error-message";

import { revalidatePath } from "next/cache";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { redirect } from "next/navigation";
import { z } from "zod";

import { startAnalysisRun } from "@/lib/analysis/analysis-job";
import { generateProjectReport } from "@/lib/analysis/report";
import { auth } from "@/lib/auth";
import { assertRateLimit } from "@/lib/rate-limit";
import { BillingLimitError } from "@/modules/billing";
import { codeRemovedMessage } from "@/modules/projects";
import { withQuota } from "@/modules/billing/server";
import {
  assertGitHubSourceReady,
  findReanalysisTarget,
  requeueIdleProject,
  setProjectProgress,
  startReanalysis,
} from "@/modules/projects/server";

export type RetryState = {
  error?: string;
};

const projectIdSchema = z.uuid();

// LLM / embedding cost protection, keyed by userId.
const AI_ACTION_MAX_PER_HOUR = 10;

function assertAiActionRateLimit(action: string, userId: string) {
  return assertRateLimit(
    `${action}:${userId}`,
    AI_ACTION_MAX_PER_HOUR,
    60 * 60 * 1000,
    `Rate limit reached (${AI_ACTION_MAX_PER_HOUR}/hour). Try again later.`,
  );
}

async function requireOwnedProject(formData: FormData) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const parsed = projectIdSchema.safeParse(formData.get("projectId"));
  if (!parsed.success) return null;

  return (await findReanalysisTarget(session.user.id, parsed.data)) ?? null;
}

export async function retryProjectKnowledge(
  _prev: RetryState,
  formData: FormData,
): Promise<RetryState> {
  const project = await requireOwnedProject(formData);
  if (!project) return { error: "Project not found." };
  // Rebuilding reuses the stored files: none left after retention.
  if (project.codeRemovedAt) return { error: codeRemovedMessage(project.source) };

  try {
    await assertAiActionRateLimit("knowledge", project.userId);
    // Embeddings run only in the analysis workflow (with the chat, the only
    // functions that ship the ONNX runtime on Vercel), so queue the project
    // and let the progress page start it. Stored files are reused; no quota
    // is consumed.
    const queued = await requeueIdleProject(
      project.userId,
      project.id,
      "Waiting to rebuild code knowledge",
    );
    if (!queued) {
      return { error: "Analysis is already running for this project." };
    }
    // "layout": the project header/tabs and every tab under it.
    revalidatePath(`/projects/${project.id}`, "layout");
    revalidatePath("/dashboard");
    redirect(`/projects/${project.id}/progress`);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return {
      error: publicErrorMessage(error, "Failed to rebuild code knowledge."),
    };
  }
}

export async function retryFullAnalysis(
  _prev: RetryState,
  formData: FormData,
): Promise<RetryState> {
  const project = await requireOwnedProject(formData);
  if (!project) return { error: "Project not found." };
  // A ZIP project re-analyzes its stored files: none left after retention.
  // GitHub projects download the code again, which brings it back.
  if (project.source === "upload" && project.codeRemovedAt) {
    return { error: codeRemovedMessage(project.source) };
  }

  // GitHub projects: the repository and the connection are checked before
  // the quota, so these errors are answered at once and cost nothing.
  if (project.source === "github") {
    try {
      await assertGitHubSourceReady(project);
    } catch (error) {
      return { error: publicErrorMessage(error, "Failed to restart project analysis.") };
    }
  }

  let claimed = false;

  try {
    // Limit check, "not already running" check and usage record in one
    // transaction: the user row is locked, so parallel requests cannot all
    // pass the limit or start the same project twice.
    claimed = await withQuota(project.userId, "analysis", async (tx) => {
      const started = await startReanalysis(tx, project.userId, project.id);
      // Already running: no new analysis, so no quota consumed.
      if (!started) return { consumed: false, value: false };

      return { consumed: true, value: true };
    });

    if (!claimed) {
      return { error: "Analysis is already running for this project." };
    }

    if (project.source === "github") {
      // The latest code is fetched by the analysis workflow (ADR-005, TD-10),
      // which then analyzes it: this request only starts the run.
      await setProjectProgress(project.userId, project.id, {
        status: "processing",
        step: "Fetching latest code from GitHub",
        percent: 10,
        errorMessage: null,
      });
      if (!(await startAnalysisRun(project.userId, project.id, { fetchFromGitHub: true }))) {
        return { error: "Failed to restart project analysis." };
      }
    } else {
      // ZIP projects reuse their stored files; the progress page starts the run.
      await setProjectProgress(project.userId, project.id, {
        status: "queued",
        step: "Waiting to restart analysis",
        percent: Math.max(project.progressPercent || 0, 25),
        errorMessage: null,
      });
    }
    // "layout": the project header/tabs and every tab under it.
    revalidatePath(`/projects/${project.id}`, "layout");
    revalidatePath("/dashboard");
    redirect(`/projects/${project.id}/progress`);
  } catch (error) {
    if (isRedirectError(error)) throw error;

    if (error instanceof BillingLimitError) {
      return { error: error.message };
    }

    const message = publicErrorMessage(
      error,
      "Failed to restart project analysis.",
    );
    if (claimed) {
      await setProjectProgress(project.userId, project.id, {
        step: "Re-analyze failed",
        percent: project.progressPercent || 0,
        status: "failed",
        errorMessage: message,
      });
    }
    return { error: message };
  }
}

export async function generateReportAction(
  _prev: RetryState,
  formData: FormData,
): Promise<RetryState> {
  const project = await requireOwnedProject(formData);
  if (!project) return { error: "Project not found." };
  // The report is built from the stored code: none left after retention.
  if (project.codeRemovedAt) return { error: codeRemovedMessage(project.source) };

  try {
    await assertAiActionRateLimit("report", project.userId);
    await generateProjectReport(project.userId, project.id);
    // "layout": the project header/tabs and every tab under it.
    revalidatePath(`/projects/${project.id}`, "layout");
    revalidatePath("/dashboard");
    redirect(`/projects/${project.id}/report`);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return {
      error: publicErrorMessage(error, "Failed to generate health report."),
    };
  }
}
