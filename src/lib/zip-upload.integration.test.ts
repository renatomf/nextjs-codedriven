import { and, eq } from "drizzle-orm";
import JSZip from "jszip";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { projects, usageEvents } from "@/db/schema";
import { db } from "@/lib/db";
import { readProjectFiles } from "@/lib/files/storage";
import { getPlanCatalog } from "@/modules/billing";
import { createUser, deleteUsers } from "@/test/integration/factories";

// Direct ZIP upload (ADR-011) against a real Postgres, quota and extraction.
// The browser's upload to the bucket is outside the server; here the object
// store is a fake, the Workflow start is recorded and its upload step
// (fetchUploadedZipStage) is run directly, as Workflow would.

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  start: vi.fn(),
  presignedUpload: vi.fn(),
  objectSize: vi.fn(),
  readObject: vi.fn(),
  deleteObject: vi.fn(),
}));

const CONFIG = {
  endpoint: "https://br-test.storage.neon.tech",
  region: "us-east-1",
  accessKeyId: "test",
  secretAccessKey: "test",
  bucket: "uploads",
};

vi.mock("@/lib/auth", () => ({ auth: mocks.auth, signIn: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("workflow/api", () => ({ start: mocks.start, getRun: vi.fn() }));
vi.mock("@/lib/analysis/analysis-workflow", () => ({ analysisWorkflow: "analysisWorkflow" }));
vi.mock("@/lib/storage/neon-storage", () => ({
  storageConfig: () => CONFIG,
  presignedUpload: mocks.presignedUpload,
  objectSize: mocks.objectSize,
  readObject: mocks.readObject,
  deleteObject: mocks.deleteObject,
}));

import { prepareZipUpload, startZipUpload } from "@/lib/actions/github";
import { newUploadKey } from "@/lib/storage/upload-keys";
import { fetchUploadedZipStage } from "@/modules/projects/server";

const created: string[] = [];

afterAll(async () => {
  await deleteUsers(created);
});

beforeEach(() => {
  mocks.auth.mockReset();
  mocks.start.mockReset().mockResolvedValue({ runId: "wrun_upload" });
  mocks.presignedUpload.mockReset().mockResolvedValue({
    url: "https://br-test.storage.neon.tech/uploads",
    fields: { key: "signed", Policy: "p" },
  });
  mocks.objectSize.mockReset();
  mocks.readObject.mockReset();
  mocks.deleteObject.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
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

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const userProjects = (userId: string) =>
  db
    .select({ id: projects.id, status: projects.status, fileCount: projects.fileCount, errorMessage: projects.errorMessage })
    .from(projects)
    .where(eq(projects.userId, userId));

const usageCount = (userId: string) =>
  db.$count(usageEvents, and(eq(usageEvents.userId, userId), eq(usageEvents.type, "analysis")));

const redirectsToProgress = { digest: expect.stringMatching(/\/projects\/[0-9a-f-]+\/progress/) };

describe("prepareZipUpload", () => {
  it("signs an upload under the user's own prefix and charges nothing", async () => {
    const userId = await signedInUser();

    const plan = await prepareZipUpload(form({ fileName: "demo.zip", size: "1024" }));

    expect(plan.upload?.key).toMatch(new RegExp(`^uploads/${userId}/[0-9a-f-]{36}\\.zip$`));
    expect(mocks.presignedUpload).toHaveBeenCalledWith(CONFIG, plan.upload?.key, 100 * 1024 * 1024);
    expect(await usageCount(userId)).toBe(0);
  });

  it("refuses a file over 100 MB, or not a ZIP, before signing anything", async () => {
    await signedInUser();

    expect(await prepareZipUpload(form({ fileName: "demo.zip", size: String(100 * 1024 * 1024 + 1) }))).toEqual({
      error: "ZIP exceeds the 100 MB limit.",
    });
    expect(await prepareZipUpload(form({ fileName: "demo.tar", size: "10" }))).toEqual({
      error: "Only .zip uploads are supported.",
    });
    expect(mocks.presignedUpload).not.toHaveBeenCalled();
  });
});

describe("startZipUpload + the workflow's upload step", () => {
  async function upload(userId: string) {
    const key = newUploadKey(userId);
    mocks.objectSize.mockResolvedValue(2048);
    await expect(startZipUpload(form({ key, fileName: "demo.zip" }))).rejects.toMatchObject(
      redirectsToProgress,
    );
    const [project] = await userProjects(userId);
    const [, , runOptions] = mocks.start.mock.calls[0][1];
    // The workflow step maps the run options to the stage options.
    const options = { key: runOptions.uploadKey, importUsageId: runOptions.importUsageId };
    return { key, projectId: project.id, options, runOptions };
  }

  it("imports the uploaded ZIP in the workflow and deletes the upload", async () => {
    const userId = await signedInUser();
    const { key, projectId, options, runOptions } = await upload(userId);

    expect(runOptions).toEqual({ uploadKey: key, importUsageId: expect.any(String) });
    expect(await usageCount(userId)).toBe(1);

    mocks.readObject.mockResolvedValue(await validZip());
    await fetchUploadedZipStage(userId, projectId, options);

    expect((await userProjects(userId))[0]).toMatchObject({ status: "processing", fileCount: 1 });
    expect((await readProjectFiles(userId, projectId)).map((file) => file.relativePath)).toEqual([
      "src/index.ts",
    ]);
    expect(mocks.deleteObject).toHaveBeenCalledWith(CONFIG, key);
  });

  it("refuses another user's key, without touching the quota", async () => {
    const userId = await signedInUser();
    const someoneElse = await createUser();
    created.push(someoneElse);

    expect(await startZipUpload(form({ key: newUploadKey(someoneElse), fileName: "demo.zip" }))).toEqual({
      error: "Upload not found. Please try again.",
    });
    expect(mocks.objectSize).not.toHaveBeenCalled();
    expect(await userProjects(userId)).toEqual([]);
  });

  it("does not trust the browser: an object over the limit is deleted, nothing charged", async () => {
    const userId = await signedInUser();
    const key = newUploadKey(userId);
    mocks.objectSize.mockResolvedValue(100 * 1024 * 1024 + 1);

    expect(await startZipUpload(form({ key, fileName: "demo.zip" }))).toEqual({
      error: "ZIP exceeds the 100 MB limit.",
    });
    expect(mocks.deleteObject).toHaveBeenCalledWith(CONFIG, key);
    expect(await usageCount(userId)).toBe(0);
  });

  it("answers when the upload never reached the bucket", async () => {
    const userId = await signedInUser();
    mocks.objectSize.mockResolvedValue(null);

    expect(await startZipUpload(form({ key: newUploadKey(userId), fileName: "demo.zip" }))).toEqual({
      error: "Upload not found. Please try again.",
    });
    expect(await usageCount(userId)).toBe(0);
  });

  it("shows the plan limit and deletes the upload when the quota is used up", async () => {
    const userId = await signedInUser();
    const { analysesPerDay } = getPlanCatalog().free;
    for (let i = 0; i < analysesPerDay; i += 1) {
      await db.insert(usageEvents).values({ userId, type: "analysis" });
    }
    const key = newUploadKey(userId);
    mocks.objectSize.mockResolvedValue(2048);

    const result = await startZipUpload(form({ key, fileName: "demo.zip" }));

    expect(result.limit?.title).toBe("Daily analysis limit reached");
    expect(mocks.deleteObject).toHaveBeenCalledWith(CONFIG, key);
    expect(await userProjects(userId)).toEqual([]);
  });

  it("keeps an invalid archive charged (user error) and deletes the upload", async () => {
    const userId = await signedInUser();
    const { key, options, projectId } = await upload(userId);
    mocks.readObject.mockResolvedValue(Buffer.from("not a zip"));

    await expect(fetchUploadedZipStage(userId, projectId, options)).rejects.toThrow(
      "Invalid or corrupted ZIP file.",
    );

    expect((await userProjects(userId))[0]).toMatchObject({
      status: "failed",
      errorMessage: "Invalid or corrupted ZIP file.",
    });
    expect(await usageCount(userId)).toBe(1);
    expect(mocks.deleteObject).toHaveBeenCalledWith(CONFIG, key);
  });

  it("retries a storage failure, then fails generically, gives the analysis back and deletes", async () => {
    const userId = await signedInUser();
    const { key, options, projectId } = await upload(userId);
    mocks.readObject.mockRejectedValue(new Error("connect ETIMEDOUT key=nsk_live_secret"));

    await expect(
      fetchUploadedZipStage(userId, projectId, { ...options, finalAttempt: false }),
    ).rejects.toThrow();
    expect((await userProjects(userId))[0].status).toBe("processing");
    expect(mocks.deleteObject).not.toHaveBeenCalled();

    await expect(fetchUploadedZipStage(userId, projectId, options)).rejects.toThrow();
    expect((await userProjects(userId))[0]).toMatchObject({
      status: "failed",
      errorMessage: "Project ingestion failed.",
    });
    expect(await usageCount(userId)).toBe(0);
    expect(mocks.deleteObject).toHaveBeenCalledWith(CONFIG, key);
  });

  it("refuses a key that is not the project owner's in the step too", async () => {
    const userId = await signedInUser();
    const { projectId } = await upload(userId);
    const someoneElse = await createUser();
    created.push(someoneElse);

    await expect(
      fetchUploadedZipStage(userId, projectId, { key: newUploadKey(someoneElse) }),
    ).rejects.toThrow("Upload not found.");
    expect(mocks.readObject).not.toHaveBeenCalled();
  });
});
