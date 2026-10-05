import { APICallError } from "ai";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { codeChunks, llmCalls, llmSwitches, projects, reports } from "@/db/schema";
import { db } from "@/lib/db";
import { persistProjectFiles } from "@/lib/files/storage";
import { analysisFixtureFiles } from "@/test/fixtures/analysis-project";
import { axisEmbedding, createUser, deleteUsers } from "@/test/integration/factories";

// Characterization of report generation before it moves into the analysis
// module: deterministic metrics + LLM review → category scores, health score,
// issue order and roadmap, stored on a real Postgres. The LLM is replaced by
// a fixed review; everything else is real.

const mocks = vi.hoisted(() => ({ runLlmHealthReview: vi.fn() }));

// Only the model call is replaced: the input hash (TD-43) is the real one.
vi.mock("@/lib/analysis/report-llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analysis/report-llm")>()),
  runLlmHealthReview: mocks.runLlmHealthReview,
}));

import { generateProjectReport } from "@/lib/analysis/report";

const LLM_REVIEW = {
  architectureSummary: "Layers are mixed.",
  securitySummary: "Input is validated.",
  performanceSummary: "No hot spots.",
  issues: [
    {
      title: "Business logic in route handlers",
      description: "Handlers query the database directly.",
      severity: "high" as const,
      category: "architecture" as const,
      filePath: "src/app/page.tsx",
    },
    {
      title: "Missing rate limit",
      description: "Login has no brute-force protection.",
      severity: "medium" as const,
      category: "security" as const,
      filePath: null,
    },
    {
      title: "N+1 query",
      description: "A query runs per item.",
      severity: "low" as const,
      category: "performance" as const,
      filePath: "src/payment.ts",
    },
  ],
  usage: { inputTokens: 5_500, outputTokens: 1_400 },
};

const llmCallsOf = (projectId: string) =>
  db
    .select({ feature: llmCalls.feature, ok: llmCalls.ok, inputTokens: llmCalls.inputTokens, outputTokens: llmCalls.outputTokens })
    .from(llmCalls)
    .where(eq(llmCalls.projectId, projectId));

const created: string[] = [];
let owner: string;

beforeAll(async () => {
  owner = await createUser();
  created.push(owner);
});

afterAll(async () => {
  await deleteUsers(created);
});

beforeEach(() => {
  mocks.runLlmHealthReview.mockReset().mockResolvedValue(LLM_REVIEW);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

async function analyzedProject(chunkCount = 3) {
  const [project] = await db
    .insert(projects)
    .values({
      userId: owner,
      name: "fixture",
      framework: "nextjs",
      source: "upload",
      status: "processing",
      progressPercent: 80,
    })
    .returning({ id: projects.id });
  await persistProjectFiles(
    owner,
    project.id,
    analysisFixtureFiles().map((file) => ({ ...file, sizeBytes: file.content.length })), null,
  );
  for (let i = 0; i < chunkCount; i += 1) {
    await db.insert(codeChunks).values({
      projectId: project.id,
      // Zero-padded so the alphabetical order is predictable.
      filePath: `src/chunk-${String(i).padStart(3, "0")}.ts`,
      content: `chunk ${i}`,
      startLine: 1,
      endLine: 1,
      embedding: axisEmbedding(i % 384),
    });
  }
  return project.id;
}

async function projectState(projectId: string) {
  const [row] = await db
    .select({ status: projects.status, errorMessage: projects.errorMessage })
    .from(projects)
    .where(eq(projects.id, projectId));
  return row;
}

describe("generateProjectReport (characterization)", () => {
  it("scores the project and stores the report", async () => {
    const projectId = await analyzedProject();

    const report = await generateProjectReport(owner, projectId);

    // Today's formula, pinned (ADR-010 and its reviews change it on purpose).
    expect({ healthScore: report.healthScore, categoryScores: report.categoryScores }).toMatchSnapshot();
    expect(report.issues.map((issue) => `${issue.severity} ${issue.category} ${issue.title}`)).toMatchSnapshot();
    expect(report.roadmap).toEqual(report.issues.slice(0, 10));
    expect(report.categorySummaries).toMatchSnapshot();

    const [stored] = await db.select().from(reports).where(eq(reports.projectId, projectId));
    expect(stored.healthScore).toBe(report.healthScore);
    expect(stored.issues).toEqual(report.issues);
    expect(stored.categoryScores).toEqual({
      ...report.categoryScores,
      summaries: report.categorySummaries,
    });
    expect(await projectState(projectId)).toEqual({ status: "completed", errorMessage: null });
  });

  it("gives the LLM review every chunk, in file-path order (it samples them)", async () => {
    const projectId = await analyzedProject(85);

    await generateProjectReport(owner, projectId);

    const [{ projectName, framework, chunks }] = mocks.runLlmHealthReview.mock.calls[0];
    expect({ projectName, framework }).toEqual({ projectName: "fixture", framework: "nextjs" });
    expect(chunks).toHaveLength(85);
    expect(chunks[0].filePath).toBe("src/chunk-000.ts");
    expect(chunks[84].filePath).toBe("src/chunk-084.ts");
  });

  it("fails with a user-facing message when there is no code knowledge", async () => {
    const projectId = await analyzedProject(0);

    await expect(generateProjectReport(owner, projectId)).rejects.toThrow(
      "No code chunks available. Build project knowledge before generating a report.",
    );
    expect(await projectState(projectId)).toEqual({
      status: "failed",
      errorMessage: "No code chunks available. Build project knowledge before generating a report.",
    });
    expect(mocks.runLlmHealthReview).not.toHaveBeenCalled();
  });

  // Graceful degradation (roadmap Phase 5): with the AI review out, the
  // report still comes out, from the automated checks, and says so.
  const storedReport = async (projectId: string) => {
    const [row] = await db
      .select({ categoryScores: reports.categoryScores, issues: reports.issues, llmReview: reports.llmReview })
      .from(reports)
      .where(eq(reports.projectId, projectId));
    return row;
  };

  it("gives a deterministic report, flagged, when the LLM fails on the last attempt", async () => {
    const projectId = await analyzedProject();
    mocks.runLlmHealthReview.mockRejectedValue(new Error("provider 500: key=gsk_hunter2"));

    const report = await generateProjectReport(owner, projectId);

    expect(report.aiReviewSkipped).toBe("unavailable");
    expect(await projectState(projectId)).toEqual({ status: "completed", errorMessage: null });
    const stored = await storedReport(projectId);
    expect(stored.categoryScores.aiReviewSkipped).toBe("unavailable");
    expect(stored.issues.some((issue) => issue.title === "Business logic in route handlers")).toBe(false);
    expect(stored.llmReview).toBeNull();
    expect(JSON.stringify(stored)).not.toContain("hunter2");
    // The failed call is recorded too (Phase 4): latency, no tokens.
    expect(await llmCallsOf(projectId)).toEqual([
      { feature: "report", ok: false, inputTokens: 0, outputTokens: 0 },
    ]);
  });

  it("asks the model again on the next run after a report without the AI review", async () => {
    const projectId = await analyzedProject();
    mocks.runLlmHealthReview.mockRejectedValueOnce(new Error("provider 500"));
    await generateProjectReport(owner, projectId);

    const second = await generateProjectReport(owner, projectId);

    expect(mocks.runLlmHealthReview).toHaveBeenCalledTimes(2);
    expect(second.aiReviewSkipped).toBeUndefined();
    expect((await storedReport(projectId)).categoryScores.aiReviewSkipped).toBeUndefined();
  });

  // Seen in production (2026-10-03): an invalid key was retried three times.
  it.each([401, 403])(
    "does not retry a refused key (%i): deterministic report at once",
    async (statusCode) => {
      const projectId = await analyzedProject();
      mocks.runLlmHealthReview.mockRejectedValueOnce(
        new APICallError({
          message: "Invalid API Key",
          url: "https://api.groq.com/openai/v1/chat/completions",
          requestBodyValues: {},
          statusCode,
          isRetryable: false,
        }),
      );

      const report = await generateProjectReport(owner, projectId, { finalAttempt: false });

      expect(report.aiReviewSkipped).toBe("unavailable");
      expect(await projectState(projectId)).toEqual({ status: "completed", errorMessage: null });
    },
  );

  it("leaves an LLM failure unwritten while the workflow will retry", async () => {
    const projectId = await analyzedProject();
    mocks.runLlmHealthReview.mockRejectedValueOnce(new Error("provider 503"));

    await expect(
      generateProjectReport(owner, projectId, { finalAttempt: false }),
    ).rejects.toThrow("provider 503");

    expect(await projectState(projectId)).toEqual({ status: "processing", errorMessage: null });
    // The failed call still counts against the budget.
    expect(await llmCallsOf(projectId)).toEqual([
      { feature: "report", ok: false, inputTokens: 0, outputTokens: 0 },
    ]);
  });

  it("records the LLM call's usage with the report", async () => {
    const projectId = await analyzedProject();

    await generateProjectReport(owner, projectId);

    expect(await llmCallsOf(projectId)).toEqual([
      { feature: "report", ok: true, inputTokens: 5_500, outputTokens: 1_400 },
    ]);
  });

  it("skips the LLM once the daily token budget is spent: deterministic report, flagged", async () => {
    process.env.PLAN_FREE_LLM_TOKENS_PER_DAY = "1000";
    try {
      const projectId = await analyzedProject();
      await db.insert(llmCalls).values({
        userId: owner,
        feature: "chat",
        model: "openai/gpt-oss-120b",
        inputTokens: 1_000,
        outputTokens: 0,
        latencyMs: 1,
        ok: true,
      });

      const report = await generateProjectReport(owner, projectId);

      expect(mocks.runLlmHealthReview).not.toHaveBeenCalled();
      expect(report.aiReviewSkipped).toBe("budget");
      expect(await projectState(projectId)).toEqual({ status: "completed", errorMessage: null });
      expect((await storedReport(projectId)).categoryScores.aiReviewSkipped).toBe("budget");
    } finally {
      delete process.env.PLAN_FREE_LLM_TOKENS_PER_DAY;
    }
  });

  it("skips the LLM while the report's kill switch is off: deterministic report, flagged", async () => {
    await db.insert(llmSwitches).values({ feature: "report", enabled: false });
    try {
      const projectId = await analyzedProject();

      const report = await generateProjectReport(owner, projectId);

      expect(mocks.runLlmHealthReview).not.toHaveBeenCalled();
      expect(report.aiReviewSkipped).toBe("disabled");
      expect(await projectState(projectId)).toEqual({ status: "completed", errorMessage: null });
    } finally {
      await db.delete(llmSwitches).where(eq(llmSwitches.feature, "report"));
    }
  });

  describe("re-analysis of the same code (TD-43)", () => {
    // The model's answers vary between runs: a second review of the same code
    // that finds less would raise the score with no code change.
    const KINDER_REVIEW = { ...LLM_REVIEW, issues: [] };

    it("reuses the stored review: same score, no new LLM call", async () => {
      const projectId = await analyzedProject();
      const first = await generateProjectReport(owner, projectId);
      mocks.runLlmHealthReview.mockResolvedValue(KINDER_REVIEW);

      const second = await generateProjectReport(owner, projectId);

      expect(second.healthScore).toBe(first.healthScore);
      expect(second.issues).toEqual(first.issues);
      expect(mocks.runLlmHealthReview).toHaveBeenCalledOnce();
      expect(await llmCallsOf(projectId)).toHaveLength(1);
    });

    it("asks the LLM again when the reviewed code changed", async () => {
      const projectId = await analyzedProject();
      await generateProjectReport(owner, projectId);
      await db
        .update(codeChunks)
        .set({ content: "chunk 0, edited" })
        .where(and(eq(codeChunks.projectId, projectId), eq(codeChunks.filePath, "src/chunk-000.ts")));
      mocks.runLlmHealthReview.mockResolvedValue(KINDER_REVIEW);

      const second = await generateProjectReport(owner, projectId);

      expect(mocks.runLlmHealthReview).toHaveBeenCalledTimes(2);
      expect(second.issues.some((issue) => issue.title === "Business logic in route handlers")).toBe(false);
    });

    it("reuses the review even while the report's kill switch is off", async () => {
      const projectId = await analyzedProject();
      const first = await generateProjectReport(owner, projectId);
      await db.insert(llmSwitches).values({ feature: "report", enabled: false });
      try {
        const second = await generateProjectReport(owner, projectId);

        expect(second.healthScore).toBe(first.healthScore);
        expect(await projectState(projectId)).toEqual({ status: "completed", errorMessage: null });
      } finally {
        await db.delete(llmSwitches).where(eq(llmSwitches.feature, "report"));
      }
    });

    it("stores no review when the LLM call fails, so the next run asks again", async () => {
      const projectId = await analyzedProject();
      mocks.runLlmHealthReview.mockRejectedValueOnce(new Error("provider 500"));
      // An attempt the workflow will retry: the failure goes up, nothing stored.
      await expect(
        generateProjectReport(owner, projectId, { finalAttempt: false }),
      ).rejects.toThrow();

      await generateProjectReport(owner, projectId);

      expect(mocks.runLlmHealthReview).toHaveBeenCalledTimes(2);
    });
  });

  it("never reports on another user's project", async () => {
    const projectId = await analyzedProject();
    const intruder = await createUser();
    created.push(intruder);

    await expect(generateProjectReport(intruder, projectId)).rejects.toThrow("Project not found");
    expect(mocks.runLlmHealthReview).not.toHaveBeenCalled();
    expect(await projectState(projectId)).toEqual({ status: "processing", errorMessage: null });
  });
});
