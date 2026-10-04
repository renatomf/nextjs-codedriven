import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { codeChunks, embeddingCache, projectFiles, projects, reports } from "@/db/schema";
import { db } from "@/lib/db";
import { persistProjectFiles } from "@/lib/files/storage";
import { CODE_RETENTION_DAYS } from "@/modules/projects";
import {
  claimAnalysis,
  removeIdleProjectCode,
  touchProject,
} from "@/modules/projects/server";
import {
  axisEmbedding,
  createProjectWithData,
  createUser,
  deleteUsers,
} from "@/test/integration/factories";

// Retention (roadmap Phase 6) against a real Postgres: the code of a project
// unused for CODE_RETENTION_DAYS is removed by the daily job; the project
// and its report stay. Only the Workflow run status and storage are faked.

const mocks = vi.hoisted(() => ({
  analysisRunStatus: vi.fn(),
  storageConfig: vi.fn(),
}));

vi.mock("@/lib/analysis/analysis-job", () => ({
  analysisRunStatus: mocks.analysisRunStatus,
}));
vi.mock("@/lib/storage/neon-storage", () => ({
  storageConfig: mocks.storageConfig,
  staleObjects: vi.fn(),
  deleteObject: vi.fn(),
}));

import { reapStuckProjects } from "@/lib/analysis/reaper";

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);
const IDLE_SECONDS = CODE_RETENTION_DAYS * 24 * 60 * 60;

const created: string[] = [];
let owner: string;
let stranger: string;

beforeAll(async () => {
  owner = await createUser();
  stranger = await createUser();
  created.push(owner, stranger);
});

afterAll(async () => {
  await deleteUsers(created);
});

beforeEach(() => {
  mocks.analysisRunStatus.mockReset().mockResolvedValue(null);
  mocks.storageConfig.mockReset().mockReturnValue(null);
});

/** A project with a file, a chunk, a kept vector and a report, last used `lastUsedAt`. */
async function projectUsed(
  lastUsedAt: Date,
  status: "completed" | "failed" | "processing" = "completed",
) {
  const id = await createProjectWithData(owner, crypto.randomUUID());
  await db.insert(embeddingCache).values({
    projectId: id,
    contentHash: "hash",
    embeddingModel: "model",
    embedding: axisEmbedding(1),
  });
  await db.update(projects).set({ lastUsedAt, status }).where(eq(projects.id, id));
  return id;
}

async function stored(projectId: string) {
  const count = async (table: typeof projectFiles | typeof codeChunks | typeof embeddingCache) =>
    (await db.select().from(table).where(eq(table.projectId, projectId))).length;
  const [project] = await db
    .select({ codeRemovedAt: projects.codeRemovedAt, lastUsedAt: projects.lastUsedAt })
    .from(projects)
    .where(eq(projects.id, projectId));
  const [report] = await db
    .select({ healthScore: reports.healthScore })
    .from(reports)
    .where(eq(reports.projectId, projectId));
  return {
    files: await count(projectFiles),
    chunks: await count(codeChunks),
    kept: await count(embeddingCache),
    report: report?.healthScore ?? null,
    codeRemovedAt: project?.codeRemovedAt ?? null,
    lastUsedAt: project?.lastUsedAt ?? null,
  };
}

describe("daily job: idle code removal", () => {
  it("removes the code of a project unused for the retention period, keeping the project and report", async () => {
    const id = await projectUsed(daysAgo(CODE_RETENTION_DAYS + 1));

    const result = await reapStuckProjects();

    expect(result.codeRemoved).toBeGreaterThanOrEqual(1);
    const after = await stored(id);
    expect(after).toMatchObject({ files: 0, chunks: 0, kept: 0, report: 80 });
    expect(after.codeRemovedAt).toBeInstanceOf(Date);
  });

  it("keeps the code of a project used within the period", async () => {
    const id = await projectUsed(daysAgo(CODE_RETENTION_DAYS - 1));

    await reapStuckProjects();

    expect(await stored(id)).toMatchObject({ files: 1, chunks: 1, kept: 1, codeRemovedAt: null });
  });

  it("never removes the code of a running analysis", async () => {
    const id = await projectUsed(daysAgo(CODE_RETENTION_DAYS + 1), "processing");
    // Not stuck for the reaper either: a live run.
    mocks.analysisRunStatus.mockResolvedValue("running");

    await reapStuckProjects();

    expect(await stored(id)).toMatchObject({ files: 1, chunks: 1, codeRemovedAt: null });
  });

  it("removes a project only once", async () => {
    const id = await projectUsed(daysAgo(CODE_RETENTION_DAYS + 1));
    expect(await removeIdleProjectCode(id, IDLE_SECONDS)).toBe(true);

    expect(await removeIdleProjectCode(id, IDLE_SECONDS)).toBe(false);
  });

  it("leaves a project used after it was found (the rule is checked again)", async () => {
    const id = await projectUsed(daysAgo(CODE_RETENTION_DAYS + 1));
    // Opened between the search and the removal.
    await db.update(projects).set({ lastUsedAt: new Date() }).where(eq(projects.id, id));

    expect(await removeIdleProjectCode(id, IDLE_SECONDS)).toBe(false);
    expect(await stored(id)).toMatchObject({ files: 1, chunks: 1, codeRemovedAt: null });
  });
});

describe("after the code was removed", () => {
  it("is never claimed for an analysis of stored files", async () => {
    const id = await projectUsed(daysAgo(CODE_RETENTION_DAYS + 1), "failed");
    await removeIdleProjectCode(id, IDLE_SECONDS);

    expect(await claimAnalysis(owner, id)).toBe(false);
  });

  it("is restored by an import: the files come back and the mark is cleared", async () => {
    const id = await projectUsed(daysAgo(CODE_RETENTION_DAYS + 1));
    await removeIdleProjectCode(id, IDLE_SECONDS);

    await persistProjectFiles(owner, id, [
      { relativePath: "src/index.ts", content: "export {};", sizeBytes: 10 },
    ]);

    const after = await stored(id);
    expect(after).toMatchObject({ files: 1, codeRemovedAt: null });
    expect(after.lastUsedAt!.getTime()).toBeGreaterThan(daysAgo(1).getTime());
  });
});

describe("touchProject", () => {
  it("records use when the last one is older than a day", async () => {
    const id = await projectUsed(daysAgo(2));

    await touchProject(owner, id);

    expect((await stored(id)).lastUsedAt!.getTime()).toBeGreaterThan(daysAgo(1).getTime());
  });

  it("writes at most once a day", async () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000);
    const id = await projectUsed(recent);

    await touchProject(owner, id);

    expect((await stored(id)).lastUsedAt).toEqual(recent);
  });

  it("ignores another user's project", async () => {
    const id = await projectUsed(daysAgo(2));

    await touchProject(stranger, id);

    expect((await stored(id)).lastUsedAt!.getTime()).toBeLessThan(daysAgo(1).getTime());
  });

  it("leaves a running analysis alone (its updatedAt drives the stale window)", async () => {
    const id = await projectUsed(daysAgo(2), "processing");

    await touchProject(owner, id);

    expect((await stored(id)).lastUsedAt!.getTime()).toBeLessThan(daysAgo(1).getTime());
  });
});
