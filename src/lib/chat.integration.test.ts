import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { and, eq } from "drizzle-orm";

import { codeChunks, llmCalls, projects } from "@/db/schema";
import { createFakeLanguageModel, FAKE_CHAT_ANSWER } from "@/lib/ai/fake-llm";
import { db } from "@/lib/db";
import { axisEmbedding, createUser, deleteUsers } from "@/test/integration/factories";

// Characterization of the chat (RAG) before it moves into the chat module:
// session → owned project with knowledge → rate limit → retrieval from
// pgvector → system prompt → streamed answer with its sources. Real
// Postgres, real retrieval and rate limit; the session, the question
// embedding and the model (the E2E fake, so its input can be inspected)
// are replaced.

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  embedQuery: vi.fn(),
  model: undefined as undefined | ReturnType<typeof createFakeLanguageModel>,
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/modules/ingestion/infrastructure/onnx-embedder", () => ({
  onnxEmbedder: { model: "test-model@1:q8", embed: vi.fn() },
  embedTexts: vi.fn(),
  embedQuery: mocks.embedQuery,
}));
vi.mock("@/lib/ai/llm", () => ({
  getLanguageModel: () => mocks.model,
  languageModelId: () => "e2e-fake-model",
}));

import { POST } from "@/app/api/chat/route";

const created: string[] = [];
let alice: string;
let bob: string;
let aliceProject: string;

async function projectWithChunks(userId: string, name: string, chunkCount: number) {
  const [project] = await db
    .insert(projects)
    .values({
      userId,
      name,
      framework: "nextjs",
      source: "upload",
      status: "completed",
      progressPercent: 100,
    })
    .returning({ id: projects.id });
  for (let i = 0; i < chunkCount; i += 1) {
    await db.insert(codeChunks).values({
      projectId: project.id,
      filePath: `src/${name}-${i}.ts`,
      content: `export const ${name}${i} = ${i}; // ${name} chunk ${i}`,
      startLine: 10 * i + 1,
      endLine: 10 * i + 5,
      embedding: axisEmbedding(i),
    });
  }
  return project.id;
}

beforeAll(async () => {
  alice = await createUser();
  bob = await createUser();
  created.push(alice, bob);
  aliceProject = await projectWithChunks(alice, "alice", 3);
});

afterAll(async () => {
  await deleteUsers(created);
});

beforeEach(() => {
  mocks.auth.mockReset().mockResolvedValue({ user: { id: alice } });
  // The question lands on axis 1: chunk 1 is the closest.
  mocks.embedQuery.mockReset().mockResolvedValue(axisEmbedding(1));
  mocks.model = createFakeLanguageModel();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

function ask(projectId: string, text: string) {
  return POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text }] }],
      }),
    }),
  );
}

/** Text and metadata from the UI message stream (SSE `data:` lines). */
async function readStream(response: Response) {
  const events = (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice("data: ".length)));
  const text = events
    .filter((event) => event.type === "text-delta")
    .map((event) => event.delta)
    .join("");
  const metadata = events.filter((event) => event.messageMetadata).at(-1)?.messageMetadata;
  return { text, metadata };
}

describe("POST /api/chat (characterization)", () => {
  it("answers from the retrieved code and returns the sources, closest first", async () => {
    const response = await ask(aliceProject, "What does chunk 1 do?");

    expect(response.status).toBe(200);
    const { text, metadata } = await readStream(response);
    expect(text).toBe(FAKE_CHAT_ANSWER);
    expect(metadata.sources.map((s: { filePath: string }) => s.filePath)).toEqual([
      "src/alice-1.ts",
      "src/alice-0.ts",
      "src/alice-2.ts",
    ]);
    expect(metadata.sources[0]).toMatchObject({ startLine: 11, endLine: 15 });
    expect(metadata.sources[0].score).toBeCloseTo(1, 5);
    expect(mocks.embedQuery).toHaveBeenCalledWith("What does chunk 1 do?");
  });

  it("records the call's usage when the answer ends (Phase 4)", async () => {
    const chatCalls = () =>
      db
        .select({ ok: llmCalls.ok, inputTokens: llmCalls.inputTokens, outputTokens: llmCalls.outputTokens, userId: llmCalls.userId })
        .from(llmCalls)
        .where(and(eq(llmCalls.projectId, aliceProject), eq(llmCalls.feature, "chat")));
    const before = (await chatCalls()).length;

    await readStream(await ask(aliceProject, "What does chunk 1 do?"));

    const after = await chatCalls();
    expect(after).toHaveLength(before + 1);
    // The E2E fake model reports 10 input and 10 output tokens.
    expect(after.at(-1)).toEqual({ ok: true, inputTokens: 10, outputTokens: 10, userId: alice });
  });

  it("builds the system prompt from the project and its retrieved code", async () => {
    await readStream(await ask(aliceProject, "Explain the project"));

    const [call] = mocks.model!.doStreamCalls;
    const system = call.prompt.find((message) => message.role === "system");
    // The data-block boundary is random per request (TD-28).
    const content = String(system?.content);
    const [boundary] = content.match(/<<<DATA ([0-9a-f]{16})/)?.slice(1) ?? [];
    expect(boundary).toMatch(/^[0-9a-f]{16}$/);
    expect(content.replaceAll(boundary, "<boundary>")).toMatchSnapshot();
    const user = call.prompt.filter((message) => message.role === "user");
    expect(JSON.stringify(user)).toContain("Explain the project");
  });

  it("never answers about another user's project", async () => {
    mocks.auth.mockResolvedValue({ user: { id: bob } });

    const response = await ask(aliceProject, "Leak it");

    expect(response.status).toBe(404);
    expect(mocks.model!.doStreamCalls).toHaveLength(0);
  });

  it("only retrieves the asker's own project's code", async () => {
    mocks.auth.mockResolvedValue({ user: { id: bob } });
    const bobProject = await projectWithChunks(bob, "bob", 2);

    const { metadata } = await readStream(await ask(bobProject, "Anything"));

    expect(
      metadata.sources.every((s: { filePath: string }) => s.filePath.startsWith("src/bob-")),
    ).toBe(true);
  });

  it("asks to build the knowledge first when the project has none", async () => {
    const empty = await projectWithChunks(alice, "empty", 0);

    const response = await ask(empty, "Hello?");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "This project has no indexed code chunks yet. Finish knowledge building first.",
    });
  });

  it("rejects a question over 4000 characters before any retrieval", async () => {
    const response = await ask(aliceProject, "x".repeat(4001));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Questions are limited to 4000 characters.",
    });
    expect(mocks.embedQuery).not.toHaveBeenCalled();
  });
});
