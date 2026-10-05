import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { projectFiles, projects } from "@/db/schema";
import { loadProjectSourceFiles } from "@/lib/analysis/project-files";
import { setProjectProgress } from "@/lib/analysis/progress";
import { db } from "@/lib/db";
import { listProjectFilePaths, readProjectFile } from "@/lib/files/explorer";
import {
  deleteProjectFiles,
  persistProjectFiles,
  readProjectFiles,
  readProjectManifest,
} from "@/lib/files/storage";
import { getProjectSummary } from "@/lib/projects";
import {
  getProjectIssues,
  getProjectProgress,
  getProjectReport,
  listUserProjects,
} from "@/modules/projects/server";
import { searchProjectChunks } from "@/modules/ingestion/server";
import {
  axisEmbedding,
  createProjectWithData,
  createUser,
  deleteUsers,
} from "@/test/integration/factories";

// Tenant isolation (IDOR): every data-access function takes the session's
// userId and must never read, change or delete another user's project, even
// when given that project's real id.

let alice: string;
let bob: string;
let aliceProject: string;

beforeAll(async () => {
  alice = await createUser();
  bob = await createUser();
  aliceProject = await createProjectWithData(alice, "alice");
  await createProjectWithData(bob, "bob");
});

afterAll(async () => {
  await deleteUsers([alice, bob]);
});

describe("owner access (sanity check: the data is really there)", () => {
  it("lets the owner read their own project", async () => {
    expect((await getProjectSummary(alice, aliceProject))?.id).toBe(aliceProject);
    expect(await listProjectFilePaths(alice, aliceProject)).toEqual(["src/alice.ts"]);
    expect(await readProjectFile(alice, aliceProject, "src/alice.ts")).not.toBeNull();
    expect(await searchProjectChunks(alice, aliceProject, axisEmbedding(0))).toHaveLength(1);
    expect((await getProjectReport(alice, aliceProject))?.hasChunks).toBe(true);
    expect((await listUserProjects(alice)).map((p) => p.id)).toContain(aliceProject);
  });

  it("gets only the report fields the page shows (not the stored LLM review)", async () => {
    const report = (await getProjectReport(alice, aliceProject))?.report;

    expect(Object.keys(report ?? {}).sort()).toEqual(["categoryScores", "healthScore", "issues"]);
  });
});

describe("another user with the owner's project id", () => {
  it("cannot see the project summary", async () => {
    expect(await getProjectSummary(bob, aliceProject)).toBeUndefined();
  });

  it("cannot see the project's progress, issues or report", async () => {
    expect(await getProjectProgress(bob, aliceProject)).toBeUndefined();
    expect(await getProjectIssues(bob, aliceProject)).toBeUndefined();
    expect(await getProjectReport(bob, aliceProject)).toBeUndefined();
  });

  it("does not get the project in their dashboard list", async () => {
    expect((await listUserProjects(bob)).map((p) => p.id)).not.toContain(aliceProject);
  });

  it("cannot list, read or load the project's files", async () => {
    expect(await readProjectManifest(bob, aliceProject)).toEqual([]);
    expect(await readProjectFiles(bob, aliceProject)).toEqual([]);
    expect(await listProjectFilePaths(bob, aliceProject)).toEqual([]);
    expect(await readProjectFile(bob, aliceProject, "src/alice.ts")).toBeNull();
    expect(await loadProjectSourceFiles(bob, aliceProject)).toEqual([]);
  });

  it("cannot retrieve the project's code chunks through vector search", async () => {
    expect(await searchProjectChunks(bob, aliceProject, axisEmbedding(0))).toEqual([]);
  });

  it("cannot overwrite the project's files", async () => {
    await expect(
      persistProjectFiles(bob, aliceProject, [
        { relativePath: "src/evil.ts", content: "evil", sizeBytes: 4 },
      ], null),
    ).rejects.toThrow("Project not found");

    const stored = await db
      .select({ path: projectFiles.relativePath })
      .from(projectFiles)
      .where(eq(projectFiles.projectId, aliceProject));
    expect(stored).toEqual([{ path: "src/alice.ts" }]);
  });

  it("cannot delete the project's files", async () => {
    await deleteProjectFiles(bob, aliceProject);
    expect(await listProjectFilePaths(alice, aliceProject)).toEqual(["src/alice.ts"]);
  });

  it("cannot change the project's status or progress", async () => {
    const updated = await setProjectProgress(bob, aliceProject, {
      step: "hijacked",
      percent: 0,
      status: "failed",
      errorMessage: "hijacked",
    });
    expect(updated).toBe(false);

    const [row] = await db
      .select({ status: projects.status, step: projects.progressStep })
      .from(projects)
      .where(eq(projects.id, aliceProject));
    expect(row).toEqual({ status: "completed", step: "Done" });
  });
});
