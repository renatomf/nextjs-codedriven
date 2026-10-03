import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { codeChunks, projects } from "@/db/schema";
import { db } from "@/lib/db";
import { persistProjectFiles } from "@/lib/files/storage";
import { axisEmbedding, createUser, deleteUsers } from "@/test/integration/factories";

// Characterization of building a project's code knowledge (load files →
// Tree-sitter chunks → embeddings → pgvector) before it moves into the
// ingestion module. Real Postgres and real chunking; only the embedding
// model is replaced by deterministic vectors (no 23 MB download).

const mocks = vi.hoisted(() => ({ embedTexts: vi.fn() }));

vi.mock("@/modules/ingestion/infrastructure/onnx-embedder", () => ({
  onnxEmbedder: { model: "test-model@1:q8", embed: mocks.embedTexts },
  embedTexts: mocks.embedTexts,
  embedQuery: vi.fn(),
}));

import { buildProjectKnowledge } from "@/lib/analysis/pipeline";
import { AnalysisCanceledError } from "@/lib/analysis/progress";
import { searchProjectChunks } from "@/modules/ingestion/server";

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
  // One distinct unit vector per chunk, in order.
  mocks.embedTexts.mockReset().mockImplementation(async (texts: string[]) =>
    texts.map((_, i) => axisEmbedding(i)),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const SOURCES = [
  {
    relativePath: "src/math.ts",
    content: "export function add(a: number, b: number) {\n  return a + b;\n}\n",
  },
  {
    relativePath: "src/greeting.ts",
    content: "export function greet(name: string) {\n  return `Hello, ${name}!`;\n}\n",
  },
];

async function projectWithFiles(files = SOURCES) {
  const [project] = await db
    .insert(projects)
    .values({ userId: owner, name: "k", source: "upload", status: "processing", progressPercent: 30 })
    .returning({ id: projects.id });
  await persistProjectFiles(
    owner,
    project.id,
    files.map((file) => ({ ...file, sizeBytes: file.content.length })),
  );
  return project.id;
}

async function readProject(projectId: string) {
  const [project] = await db
    .select({
      status: projects.status,
      progressStep: projects.progressStep,
      progressPercent: projects.progressPercent,
      errorMessage: projects.errorMessage,
      fileCount: projects.fileCount,
    })
    .from(projects)
    .where(eq(projects.id, projectId));
  return project;
}

const chunksOf = (projectId: string) =>
  db
    .select({ filePath: codeChunks.filePath, content: codeChunks.content })
    .from(codeChunks)
    .where(eq(codeChunks.projectId, projectId));

describe("buildProjectKnowledge", () => {
  it("chunks every file, embeds the chunks and stores them for search", async () => {
    const projectId = await projectWithFiles();

    const result = await buildProjectKnowledge(owner, projectId);

    expect(result).toEqual({ chunkCount: 2, fileCount: 2 });
    const chunks = await chunksOf(projectId);
    expect(chunks.map((chunk) => chunk.filePath).sort()).toEqual(["src/greeting.ts", "src/math.ts"]);
    expect(await readProject(projectId)).toMatchObject({
      progressStep: "Code knowledge ready",
      progressPercent: 75,
      fileCount: 2,
    });

    // A query equal to the first chunk's vector finds that chunk first.
    const firstEmbeddedText = mocks.embedTexts.mock.calls[0][0][0];
    const [best, second] = await searchProjectChunks(owner, projectId, axisEmbedding(0), 2);
    expect(best.content).toBe(firstEmbeddedText);
    expect(best.score).toBeCloseTo(1, 5);
    expect(second.score).toBeCloseTo(0, 5);
  });

  it("replaces the previous knowledge on a rebuild", async () => {
    const projectId = await projectWithFiles();
    await buildProjectKnowledge(owner, projectId);
    await persistProjectFiles(owner, projectId, [
      {
        relativePath: "src/only.ts",
        content: "export const only = () => 1;\n",
        sizeBytes: 30,
      },
    ]);

    await buildProjectKnowledge(owner, projectId);

    expect((await chunksOf(projectId)).map((chunk) => chunk.filePath)).toEqual(["src/only.ts"]);
  });

  // TD-03: the embedding is the costliest step of a re-analysis; unchanged
  // content keeps its stored vector (same hash, same model).
  it("embeds nothing again when a rebuild finds the same code", async () => {
    const projectId = await projectWithFiles();
    await buildProjectKnowledge(owner, projectId);
    const before = await chunksOf(projectId);
    mocks.embedTexts.mockClear();

    await buildProjectKnowledge(owner, projectId);

    expect(mocks.embedTexts).not.toHaveBeenCalled();
    const after = await chunksOf(projectId);
    expect(after.map((chunk) => chunk.content)).toEqual(before.map((chunk) => chunk.content));
    // The reused vectors still answer the search as before.
    const [best] = await searchProjectChunks(owner, projectId, axisEmbedding(0), 1);
    expect(best.content).toBe(before[0].content);
  });

  it("fails with a user-facing message when there is nothing to analyze", async () => {
    const projectId = await projectWithFiles([
      { relativePath: "README.md", content: "# docs only" },
    ]);

    await expect(buildProjectKnowledge(owner, projectId)).rejects.toThrow(
      "No JavaScript/TypeScript source files found to analyze.",
    );
    expect(await readProject(projectId)).toMatchObject({
      status: "failed",
      errorMessage: "No JavaScript/TypeScript source files found to analyze.",
    });
  });

  it("hides internal errors and keeps the previous knowledge when embedding fails", async () => {
    const projectId = await projectWithFiles();
    await buildProjectKnowledge(owner, projectId);
    const before = await chunksOf(projectId);
    // New code, so the rebuild has something to embed (unchanged code would
    // reuse its vectors and never call the model, TD-03).
    await persistProjectFiles(owner, projectId, [
      { relativePath: "src/changed.ts", content: "export const changed = () => 2;\n", sizeBytes: 32 },
    ]);
    mocks.embedTexts.mockRejectedValue(new Error("model download failed: token=hunter2"));

    await expect(buildProjectKnowledge(owner, projectId)).rejects.toThrow();

    expect(await readProject(projectId)).toMatchObject({
      status: "failed",
      errorMessage: "Failed to build code knowledge base.",
    });
    expect(await chunksOf(projectId)).toEqual(before);
  });

  it("leaves a transient failure unwritten while the workflow will retry", async () => {
    const projectId = await projectWithFiles();
    mocks.embedTexts.mockRejectedValueOnce(new Error("hub timeout"));

    await expect(
      buildProjectKnowledge(owner, projectId, { finalAttempt: false }),
    ).rejects.toThrow("hub timeout");

    // Still "processing": the progress page keeps polling the next attempt.
    expect(await readProject(projectId)).toMatchObject({ status: "processing", errorMessage: null });
  });

  it("writes a user error even when the workflow could retry", async () => {
    const projectId = await projectWithFiles([
      { relativePath: "README.md", content: "# docs only" },
    ]);

    await expect(
      buildProjectKnowledge(owner, projectId, { finalAttempt: false }),
    ).rejects.toThrow("No JavaScript/TypeScript source files found to analyze.");
    expect(await readProject(projectId)).toMatchObject({ status: "failed" });
  });

  it("stops as canceled when the project was deleted", async () => {
    const projectId = await projectWithFiles();
    await db.delete(projects).where(eq(projects.id, projectId));

    await expect(buildProjectKnowledge(owner, projectId)).rejects.toBeInstanceOf(
      AnalysisCanceledError,
    );
    expect(mocks.embedTexts).not.toHaveBeenCalled();
  });

  it("never builds knowledge for another user's project", async () => {
    const projectId = await projectWithFiles();
    const intruder = await createUser();
    created.push(intruder);

    await expect(buildProjectKnowledge(intruder, projectId)).rejects.toBeInstanceOf(
      AnalysisCanceledError,
    );
    expect(await chunksOf(projectId)).toEqual([]);
    expect(await readProject(projectId)).toMatchObject({ status: "processing" });
  });
});
