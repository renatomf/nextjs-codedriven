import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { projects } from "@/db/schema";
import { db } from "@/lib/db";
import { STUCK_AFTER_SECONDS } from "@/modules/projects";
import { failStuckProject } from "@/modules/projects/server";
import { createUser, deleteUsers } from "@/test/integration/factories";

// The daily reaper (TD-11) against a real Postgres. Only the Workflow run
// status is replaced.

const mocks = vi.hoisted(() => ({
  analysisRunStatus: vi.fn(),
  storageConfig: vi.fn(),
  staleObjects: vi.fn(),
  deleteObject: vi.fn(),
}));

vi.mock("@/lib/analysis/analysis-job", () => ({
  analysisRunStatus: mocks.analysisRunStatus,
}));
vi.mock("@/lib/storage/neon-storage", () => ({
  storageConfig: mocks.storageConfig,
  staleObjects: mocks.staleObjects,
  deleteObject: mocks.deleteObject,
}));

import { reapStuckProjects } from "@/lib/analysis/reaper";

type Status = "queued" | "processing" | "completed" | "failed";

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
  mocks.analysisRunStatus.mockReset().mockResolvedValue(null);
  // No object storage unless a test says so (as in local dev and CI).
  mocks.storageConfig.mockReset().mockReturnValue(null);
  mocks.staleObjects.mockReset().mockResolvedValue([]);
  mocks.deleteObject.mockReset().mockResolvedValue(undefined);
});

const secondsAgo = (s: number) => new Date(Date.now() - s * 1000);
const STUCK = secondsAgo(STUCK_AFTER_SECONDS + 600);

async function project(values: {
  status: Status;
  updatedAt: Date;
  fileCount?: number;
  analysisRunId?: string;
}) {
  const [row] = await db
    .insert(projects)
    .values({ userId: owner, name: "p", source: "upload", progressPercent: 40, fileCount: 3, ...values })
    .returning({ id: projects.id });
  return row.id;
}

async function state(projectId: string) {
  const [row] = await db
    .select({ status: projects.status, errorMessage: projects.errorMessage })
    .from(projects)
    .where(eq(projects.id, projectId));
  return row;
}

describe("reapStuckProjects", () => {
  it("fails an import that never stored files", async () => {
    const id = await project({ status: "processing", updatedAt: STUCK, fileCount: 0 });

    await reapStuckProjects();

    expect(await state(id)).toEqual({
      status: "failed",
      errorMessage: "The import did not finish. Please create the project again.",
    });
  });

  it("fails an analysis whose run finished without finishing the project", async () => {
    const id = await project({ status: "processing", updatedAt: STUCK, analysisRunId: "wrun_dead" });
    mocks.analysisRunStatus.mockResolvedValue("failed");

    await reapStuckProjects();

    expect(await state(id)).toEqual({
      status: "failed",
      errorMessage: "The analysis stopped before finishing. Please try again.",
    });
  });

  it("leaves a project alone while its run is still alive, however old", async () => {
    const id = await project({ status: "processing", updatedAt: STUCK, analysisRunId: "wrun_alive" });
    mocks.analysisRunStatus.mockResolvedValue("running");

    await reapStuckProjects();

    expect(await state(id)).toEqual({ status: "processing", errorMessage: null });
  });

  it("fails a stuck analysis whose run Workflow can no longer find", async () => {
    const id = await project({ status: "processing", updatedAt: STUCK, analysisRunId: "wrun_gone" });
    mocks.analysisRunStatus.mockResolvedValue(null);

    await reapStuckProjects();

    expect((await state(id)).status).toBe("failed");
  });

  it.each([
    ["a recent run", { status: "processing" as const, updatedAt: secondsAgo(600) }],
    ["a completed project", { status: "completed" as const, updatedAt: STUCK }],
    ["a queued project", { status: "queued" as const, updatedAt: STUCK }],
  ])("does not touch %s", async (_name, values) => {
    const id = await project(values);

    await reapStuckProjects();

    expect((await state(id)).status).toBe(values.status);
  });
});

describe("abandoned uploads (ADR-011)", () => {
  it("deletes ZIPs left in object storage for over an hour", async () => {
    const config = { bucket: "uploads" };
    mocks.storageConfig.mockReturnValue(config);
    mocks.staleObjects.mockResolvedValue(["uploads/u/a.zip", "uploads/u/b.zip"]);

    const result = await reapStuckProjects();

    const [, prefix, olderThan, limit] = mocks.staleObjects.mock.calls[0];
    expect(prefix).toBe("uploads/");
    expect(Date.now() - olderThan.getTime()).toBeGreaterThanOrEqual(STUCK_AFTER_SECONDS * 1000);
    expect(limit).toBe(100);
    expect(mocks.deleteObject.mock.calls.map(([, key]) => key)).toEqual([
      "uploads/u/a.zip",
      "uploads/u/b.zip",
    ]);
    expect(result.uploadsDeleted).toBe(2);
  });

  it("skips the cleanup without object storage", async () => {
    const result = await reapStuckProjects();

    expect(mocks.staleObjects).not.toHaveBeenCalled();
    expect(result.uploadsDeleted).toBe(0);
  });
});

describe("failStuckProject", () => {
  it("does not fail a project restarted after it was found stuck", async () => {
    const id = await project({ status: "processing", updatedAt: STUCK, analysisRunId: "wrun_old" });
    // Restarted in the meantime: fresh write, new run.
    await db.update(projects).set({ analysisRunId: "wrun_new" }).where(eq(projects.id, id));

    const failed = await failStuckProject(
      { id, userId: owner, analysisRunId: "wrun_old" },
      STUCK_AFTER_SECONDS,
      "x",
    );

    expect(failed).toBe(false);
    expect((await state(id)).status).toBe("processing");
  });
});
