import { and, eq } from "drizzle-orm";
import JSZip from "jszip";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { projects, usageEvents } from "@/db/schema";
import { db } from "@/lib/db";
import { persistProjectFiles, readProjectFiles } from "@/lib/files/storage";
import {
  listGitHubInstallations,
  saveGitHubInstallation,
} from "@/modules/identity/server";
import { createUser, deleteUsers } from "@/test/integration/factories";

// Re-analyzing a GitHub project. The action checks the repository and the
// connection (before the quota), claims the project and starts the analysis
// workflow (ADR-005); the workflow's first step fetches the latest code and
// replaces the stored files. Here the workflow start is recorded and that
// step (fetchGitHubSourcesStage) is run directly, as Workflow would. Every
// failure leaves the project failed with a user-facing message and the
// previous files in place. Real Postgres, extraction and quota; only the
// session, Next's cache, the GitHub download and the Workflow start are
// mocked.

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  downloadGitHubZipball: vi.fn(),
  start: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github")>()),
  downloadGitHubZipball: mocks.downloadGitHubZipball,
}));
vi.mock("workflow/api", () => ({ start: mocks.start, getRun: vi.fn() }));
vi.mock("@/lib/analysis/analysis-workflow", () => ({ analysisWorkflow: "analysisWorkflow" }));

import { retryFullAnalysis } from "@/lib/actions/analysis";
import { GitHubError } from "@/lib/github";
import { GitHubInstallationGoneError } from "@/lib/github-app";
import { fetchGitHubSourcesStage } from "@/modules/projects/server";

const created: string[] = [];

afterAll(async () => {
  await deleteUsers(created);
});

beforeEach(() => {
  mocks.auth.mockReset();
  mocks.downloadGitHubZipball.mockReset();
  mocks.start.mockReset().mockResolvedValue({ runId: "wrun_reanalysis" });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

let nextInstallationId = 700_000;

/** A signed-in user; `connected` links a GitHub App installation of "octo". */
async function githubUser({ connected = true } = {}) {
  const userId = await createUser();
  created.push(userId);
  mocks.auth.mockResolvedValue({ user: { id: userId } });
  if (connected) {
    await saveGitHubInstallation(userId, { installationId: (nextInstallationId += 1), accountLogin: "octo" });
  }
  return userId;
}

async function githubProject(
  userId: string,
  identity: { name: string; repositoryUrl: string | null } = {
    name: "octo/demo",
    repositoryUrl: "https://github.com/octo/demo",
  },
) {
  const [project] = await db
    .insert(projects)
    .values({
      userId,
      source: "github",
      status: "completed",
      fileCount: 1,
      progressStep: "Complete",
      progressPercent: 100,
      ...identity,
    })
    .returning({ id: projects.id });
  await persistProjectFiles(userId, project.id, [
    { relativePath: "src/old.ts", content: "export const old = 1;\n", sizeBytes: 22 },
  ]);
  return project.id;
}

/** A GitHub zipball: everything under one root folder. */
async function zipball() {
  const zip = new JSZip();
  zip.file("octo-demo-abc123/src/new.ts", "export const fresh = 2;\n");
  zip.file("octo-demo-abc123/src/more.ts", "export const more = 3;\n");
  return zip.generateAsync({ type: "nodebuffer" });
}

function form(projectId: string) {
  const data = new FormData();
  data.set("projectId", projectId);
  return data;
}

async function projectState(projectId: string) {
  const [row] = await db
    .select({
      status: projects.status,
      progressStep: projects.progressStep,
      errorMessage: projects.errorMessage,
      fileCount: projects.fileCount,
      analysisRunId: projects.analysisRunId,
    })
    .from(projects)
    .where(eq(projects.id, projectId));
  return row;
}

const storedPaths = async (userId: string, projectId: string) =>
  (await readProjectFiles(userId, projectId)).map((file) => file.relativePath).sort();

const usageCount = (userId: string) =>
  db.$count(usageEvents, and(eq(usageEvents.userId, userId), eq(usageEvents.type, "analysis")));

const redirectsToProgress = { digest: expect.stringMatching(/\/projects\/[0-9a-f-]+\/progress/) };

/** The action, then the workflow's GitHub step (as Workflow would run it). */
async function reanalyze(userId: string, projectId: string) {
  await expect(retryFullAnalysis({}, form(projectId))).rejects.toMatchObject(redirectsToProgress);
  return fetchGitHubSourcesStage(userId, projectId);
}

describe("retryFullAnalysis (GitHub project)", () => {
  it("starts the workflow, which fetches the latest code and replaces the stored files", async () => {
    const userId = await githubUser();
    const projectId = await githubProject(userId);
    mocks.downloadGitHubZipball.mockResolvedValue(await zipball());

    await expect(retryFullAnalysis({}, form(projectId))).rejects.toMatchObject(redirectsToProgress);

    expect(mocks.start).toHaveBeenCalledWith("analysisWorkflow", [
      userId,
      projectId,
      { fetchFromGitHub: true },
    ]);
    expect(await projectState(projectId)).toMatchObject({
      status: "processing",
      progressStep: "Fetching latest code from GitHub",
      analysisRunId: "wrun_reanalysis",
    });
    expect(await usageCount(userId)).toBe(1);

    await fetchGitHubSourcesStage(userId, projectId);

    expect(mocks.downloadGitHubZipball).toHaveBeenCalledWith(
      { installationId: expect.any(Number) },
      "octo/demo",
    );
    expect(await storedPaths(userId, projectId)).toEqual(["src/more.ts", "src/new.ts"]);
    // Still the workflow's: "queued" would let the progress page start a second run.
    expect(await projectState(projectId)).toMatchObject({
      status: "processing",
      progressStep: "Files ready for analysis",
      fileCount: 2,
      errorMessage: null,
    });
  });

  it("finds the repository from the URL when the name has no owner", async () => {
    const userId = await githubUser();
    const projectId = await githubProject(userId, {
      name: "demo",
      repositoryUrl: "https://github.com/octo/demo.git",
    });
    mocks.downloadGitHubZipball.mockResolvedValue(await zipball());

    await reanalyze(userId, projectId);

    expect(mocks.downloadGitHubZipball.mock.calls[0][1]).toBe("octo/demo");
  });

  it.each([
    {
      name: "an invalid archive",
      setup: async () => mocks.downloadGitHubZipball.mockResolvedValue(Buffer.from("not a zip")),
      message: "Invalid or corrupted ZIP file.",
    },
    {
      name: "a failed download",
      setup: async () =>
        mocks.downloadGitHubZipball.mockRejectedValue(
          new GitHubError("Repository not found or you do not have access to this private repo."),
        ),
      message: "Repository not found or you do not have access to this private repo.",
    },
  ])("fails on $name, keeping the previous files", async ({ setup, message }) => {
    const userId = await githubUser();
    const projectId = await githubProject(userId);
    await setup();

    await expect(reanalyze(userId, projectId)).rejects.toThrow(message);

    expect(await projectState(projectId)).toMatchObject({
      status: "failed",
      progressStep: "Re-analyze failed",
      errorMessage: message,
    });
    expect(await storedPaths(userId, projectId)).toEqual(["src/old.ts"]);
  });

  it("leaves a transient failure unwritten while the workflow will retry", async () => {
    const userId = await githubUser();
    const projectId = await githubProject(userId);
    await expect(retryFullAnalysis({}, form(projectId))).rejects.toMatchObject(redirectsToProgress);
    mocks.downloadGitHubZipball.mockRejectedValue(new Error("socket hang up"));

    await expect(
      fetchGitHubSourcesStage(userId, projectId, { finalAttempt: false }),
    ).rejects.toThrow("socket hang up");

    expect((await projectState(projectId)).status).toBe("processing");
    expect(await storedPaths(userId, projectId)).toEqual(["src/old.ts"]);
  });

  it("asks to connect GitHub when there is no installation, before using the quota", async () => {
    const userId = await githubUser({ connected: false });
    const projectId = await githubProject(userId);

    expect(await retryFullAnalysis({}, form(projectId))).toEqual({
      error: "Connect GitHub in Settings before re-analyzing this repository.",
    });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(await usageCount(userId)).toBe(0);
    expect((await projectState(projectId)).status).toBe("completed");
  });

  it("fails when the repository cannot be determined, before using the quota", async () => {
    const userId = await githubUser();
    const projectId = await githubProject(userId, { name: "demo", repositoryUrl: null });

    expect(await retryFullAnalysis({}, form(projectId))).toEqual({
      error: "Could not determine the GitHub repository for this project.",
    });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(await usageCount(userId)).toBe(0);
  });

  it("fails the project at once when the workflow cannot start", async () => {
    const userId = await githubUser();
    const projectId = await githubProject(userId);
    mocks.start.mockRejectedValueOnce(new Error("queue unavailable"));

    expect(await retryFullAnalysis({}, form(projectId))).toEqual({
      error: "Failed to restart project analysis.",
    });
    expect(await projectState(projectId)).toMatchObject({
      status: "failed",
      errorMessage: "Failed to start the analysis. Please try again.",
    });
    expect(await storedPaths(userId, projectId)).toEqual(["src/old.ts"]);
  });
});

// GitHub App (ADR-007): the installation of the repository's owner reads the
// code.
describe("retryFullAnalysis (GitHub App)", () => {
  it("reads with the installation of the repository's owner (login case ignored)", async () => {
    const userId = await githubUser({ connected: false });
    await saveGitHubInstallation(userId, { installationId: 55, accountLogin: "Octo" });
    const projectId = await githubProject(userId);
    mocks.downloadGitHubZipball.mockResolvedValue(await zipball());

    await reanalyze(userId, projectId);

    expect(mocks.downloadGitHubZipball).toHaveBeenCalledWith({ installationId: 55 }, "octo/demo");
    expect(await storedPaths(userId, projectId)).toEqual(["src/more.ts", "src/new.ts"]);
  });

  it("explains an App installed only on another account, before using the quota", async () => {
    const userId = await githubUser({ connected: false });
    await saveGitHubInstallation(userId, { installationId: 57, accountLogin: "someone-else" });
    const projectId = await githubProject(userId);

    expect(await retryFullAnalysis({}, form(projectId))).toEqual({
      error: "The GitHub App is not installed on this repository's account. Add it in Settings → Connect GitHub.",
    });
    expect(await usageCount(userId)).toBe(0);
  });

  it("forgets an installation removed on GitHub, and fails the project with a message", async () => {
    const userId = await githubUser({ connected: false });
    await saveGitHubInstallation(userId, { installationId: 58, accountLogin: "octo" });
    const projectId = await githubProject(userId);
    mocks.downloadGitHubZipball.mockRejectedValue(new GitHubInstallationGoneError());

    await reanalyze(userId, projectId).catch(() => undefined);

    expect(await listGitHubInstallations(userId)).toEqual([]);
    expect(await storedPaths(userId, projectId)).toEqual(["src/old.ts"]);
  });

  it("never uses another user's installation", async () => {
    const owner = await githubUser({ connected: false });
    await saveGitHubInstallation(owner, { installationId: 59, accountLogin: "octo" });
    const userId = await githubUser({ connected: false });
    const projectId = await githubProject(userId);

    expect(await retryFullAnalysis({}, form(projectId))).toEqual({
      error: "Connect GitHub in Settings before re-analyzing this repository.",
    });
    expect(mocks.downloadGitHubZipball).not.toHaveBeenCalled();
  });
});
