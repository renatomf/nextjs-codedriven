import { and, eq } from "drizzle-orm";
import JSZip from "jszip";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { projects, usageEvents } from "@/db/schema";
import { db } from "@/lib/db";
import { getPlanCatalog } from "@/modules/billing";
import { createUser, deleteUsers } from "@/test/integration/factories";

// Project import (ZIP upload and GitHub) against a real Postgres, with real
// ZIP archives. Quota rule (ADR-003, TD-12): a user error (bad archive) keeps
// the analysis charged; a failure on our side gives it back. Only the
// session, Next's cache, the GitHub download and, in one test, file storage
// are mocked.

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  downloadGitHubZipball: vi.fn(),
  persistProjectFiles: vi.fn(),
  realPersist: undefined as undefined | ((...args: never[]) => Promise<unknown>),
  start: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth, signIn: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github")>()),
  downloadGitHubZipball: mocks.downloadGitHubZipball,
}));
vi.mock("@/lib/files/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/files/storage")>();
  mocks.realPersist = original.persistProjectFiles as never;
  return { ...original, persistProjectFiles: mocks.persistProjectFiles };
});
// A GitHub import runs in the analysis workflow (ADR-005): the start is
// recorded and its GitHub step is run directly, as Workflow would.
vi.mock("workflow/api", () => ({ start: mocks.start, getRun: vi.fn() }));
vi.mock("@/lib/analysis/analysis-workflow", () => ({ analysisWorkflow: "analysisWorkflow" }));

import { createProjectFromGitHub, createProjectFromZip } from "@/lib/actions/github";
import { GitHubError } from "@/lib/github";
import { saveGitHubInstallation } from "@/modules/identity/server";
import { fetchGitHubSourcesStage } from "@/modules/projects/server";

const created: string[] = [];

afterAll(async () => {
  await deleteUsers(created);
});

beforeEach(() => {
  mocks.auth.mockReset();
  mocks.downloadGitHubZipball.mockReset();
  mocks.persistProjectFiles.mockReset().mockImplementation(mocks.realPersist!);
  mocks.start.mockReset().mockResolvedValue({ runId: "wrun_import" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

async function signedInUser() {
  const id = await createUser();
  created.push(id);
  mocks.auth.mockResolvedValue({ user: { id } });
  return id;
}

async function validZip(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("src/index.ts", "export const answer = 42;\n");
  return zip.generateAsync({ type: "nodebuffer" });
}

function zipForm(bytes: Buffer, name = "demo.zip") {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], name, { type: "application/zip" }));
  return form;
}

async function userProjects(userId: string) {
  return db
    .select({
      id: projects.id,
      status: projects.status,
      fileCount: projects.fileCount,
      errorMessage: projects.errorMessage,
    })
    .from(projects)
    .where(eq(projects.userId, userId));
}

const usageCount = (userId: string) =>
  db.$count(usageEvents, and(eq(usageEvents.userId, userId), eq(usageEvents.type, "analysis")));

/** Success and failure both end on the progress page (thrown by Next). */
const redirectsToProgress = { digest: expect.stringMatching(/\/projects\/[0-9a-f-]+\/progress/) };

describe("createProjectFromZip", () => {
  it("imports a valid ZIP: files ready for analysis, one analysis charged", async () => {
    const userId = await signedInUser();

    await expect(createProjectFromZip({}, zipForm(await validZip()))).rejects.toMatchObject(
      redirectsToProgress,
    );

    const [project] = await userProjects(userId);
    expect(project).toMatchObject({ status: "queued", fileCount: 1 });
    expect(await usageCount(userId)).toBe(1);
  });

  it("keeps the analysis charged for an invalid archive (user error)", async () => {
    const userId = await signedInUser();

    await expect(
      createProjectFromZip({}, zipForm(Buffer.from("definitely not a zip"))),
    ).rejects.toMatchObject(redirectsToProgress);

    const [project] = await userProjects(userId);
    expect(project).toMatchObject({
      status: "failed",
      errorMessage: "Invalid or corrupted ZIP file.",
    });
    expect(await usageCount(userId)).toBe(1);
  });

  it("gives the analysis back when storing the files fails (our side)", async () => {
    const userId = await signedInUser();
    mocks.persistProjectFiles.mockRejectedValueOnce(new Error("connection reset"));

    await expect(createProjectFromZip({}, zipForm(await validZip()))).rejects.toMatchObject(
      redirectsToProgress,
    );

    const [project] = await userProjects(userId);
    expect(project).toMatchObject({ status: "failed", errorMessage: "Project ingestion failed." });
    expect(await usageCount(userId)).toBe(0);
  });

  it("shows the plan limit instead of importing when the quota is used up", async () => {
    const userId = await signedInUser();
    const { analysesPerDay } = getPlanCatalog().free;
    for (let i = 0; i < analysesPerDay; i += 1) {
      await db.insert(usageEvents).values({ userId, type: "analysis" });
    }

    const result = await createProjectFromZip({}, zipForm(await validZip()));

    expect(result.limit?.title).toBe("Daily analysis limit reached");
    expect(await userProjects(userId)).toEqual([]);
    expect(await usageCount(userId)).toBe(analysesPerDay);
  });

  it("asks for confirmation before importing the same ZIP again", async () => {
    const userId = await signedInUser();
    await expect(createProjectFromZip({}, zipForm(await validZip()))).rejects.toMatchObject(
      redirectsToProgress,
    );

    expect(await createProjectFromZip({}, zipForm(await validZip()))).toEqual({
      duplicate: { name: "demo" },
    });
    expect(await userProjects(userId)).toHaveLength(1);
  });

  it("refuses a ZIP over 4 MB before touching the quota (TD-45)", async () => {
    const userId = await signedInUser();
    const tooBig = Buffer.alloc(4 * 1024 * 1024 + 1);

    expect(await createProjectFromZip({}, zipForm(tooBig))).toEqual({
      error: "ZIP uploads are limited to 4 MB. For a bigger project, import it from GitHub.",
    });
    expect(await userProjects(userId)).toEqual([]);
    expect(await usageCount(userId)).toBe(0);
  });

  it("rejects a non-ZIP upload before touching the quota", async () => {
    const userId = await signedInUser();

    expect(await createProjectFromZip({}, zipForm(await validZip(), "demo.tar"))).toEqual({
      error: "Only .zip uploads are supported.",
    });
    expect(await userProjects(userId)).toEqual([]);
    expect(await usageCount(userId)).toBe(0);
  });
});

describe("createProjectFromGitHub", () => {
  let nextInstallationId = 600_000;

  /** Connected through the GitHub App installation of "octo" (ADR-007). */
  async function githubUser() {
    const userId = await signedInUser();
    await saveGitHubInstallation(userId, { installationId: (nextInstallationId += 1), accountLogin: "octo" });
    return userId;
  }

  function repoForm(fullName = "octo/demo") {
    const form = new FormData();
    form.set("fullName", fullName);
    return form;
  }

  /** The action, then the workflow's GitHub step for the new project. */
  async function importRepository(userId: string) {
    await expect(createProjectFromGitHub({}, repoForm())).rejects.toMatchObject(
      redirectsToProgress,
    );
    const [project] = await userProjects(userId);
    const [, , options] = mocks.start.mock.calls[0][1];
    return { projectId: project.id, run: () => fetchGitHubSourcesStage(userId, project.id, options) };
  }

  it("answers at once and imports the repository in the workflow", async () => {
    const userId = await githubUser();
    mocks.downloadGitHubZipball.mockResolvedValue(await validZip());

    const { projectId, run } = await importRepository(userId);

    // The request only created the project and started the run.
    expect(mocks.downloadGitHubZipball).not.toHaveBeenCalled();
    expect(mocks.start).toHaveBeenCalledWith("analysisWorkflow", [
      userId,
      projectId,
      { fetchFromGitHub: true, importUsageId: expect.any(String) },
    ]);
    expect(await usageCount(userId)).toBe(1);

    await run();

    const [project] = await userProjects(userId);
    expect(project).toMatchObject({ status: "processing", fileCount: 1 });
  });

  it("charges nothing when GitHub refuses the download", async () => {
    const userId = await githubUser();
    mocks.downloadGitHubZipball.mockRejectedValue(
      new GitHubError("Repository exceeds the 100 MB size limit."),
    );
    const { run } = await importRepository(userId);

    await expect(run()).rejects.toThrow("Repository exceeds the 100 MB size limit.");

    const [project] = await userProjects(userId);
    expect(project).toMatchObject({
      status: "failed",
      errorMessage: "Repository exceeds the 100 MB size limit.",
    });
    expect(await usageCount(userId)).toBe(0);
  });

  it("keeps the analysis charged when the repository has nothing to analyze (user error)", async () => {
    const userId = await githubUser();
    mocks.downloadGitHubZipball.mockResolvedValue(Buffer.from("not a zip"));
    const { run } = await importRepository(userId);

    await expect(run()).rejects.toThrow("Invalid or corrupted ZIP file.");

    expect((await userProjects(userId))[0]).toMatchObject({ status: "failed" });
    expect(await usageCount(userId)).toBe(1);
  });

  it("gives the analysis back when the workflow cannot start", async () => {
    const userId = await githubUser();
    mocks.start.mockRejectedValueOnce(new Error("queue unavailable"));

    expect(await createProjectFromGitHub({}, repoForm())).toEqual({
      error: "Failed to import repository.",
    });
    expect((await userProjects(userId))[0]).toMatchObject({ status: "failed" });
    expect(await usageCount(userId)).toBe(0);
  });

  it("asks to connect GitHub first when there is no installation", async () => {
    const userId = await signedInUser();

    expect(await createProjectFromGitHub({}, repoForm())).toEqual({
      error: "Connect GitHub in Settings before selecting a repository.",
    });
    expect(mocks.downloadGitHubZipball).not.toHaveBeenCalled();
    expect(await usageCount(userId)).toBe(0);
  });
});
