import { describe, expect, it, vi } from "vitest";

import { DomainError } from "@/shared/errors";

import type { ChunkDraft, EmbeddedChunk } from "../domain/knowledge";
import type { Embedder, VectorStore } from "./ports";
import { contentHash, storeKnowledge } from "./store-knowledge";

// The use case with fakes: no database, no 23 MB model.

const MODEL = "test-model@1:q8";

const drafts: ChunkDraft[] = [
  { filePath: "src/a.ts", content: "function a() {}", startLine: 1, endLine: 1 },
  { filePath: "src/b.ts", content: "function b() {}", startLine: 3, endLine: 5 },
];

function fakeEmbedder(model = MODEL): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    model,
    calls,
    async embed(texts) {
      calls.push(texts);
      return texts.map((_, i) => [i, i]);
    },
  };
}

/** Keeps what was stored and serves it back by content hash, per model. */
function inMemoryStore(): VectorStore & { saved: Map<string, EmbeddedChunk[]> } {
  const saved = new Map<string, EmbeddedChunk[]>();
  return {
    saved,
    async embeddingsByContent(userId, projectId, model) {
      const chunks = saved.get(`${userId}/${projectId}`) ?? [];
      return new Map(
        chunks.filter((chunk) => chunk.embeddingModel === model).map((chunk) => [chunk.contentHash, chunk.embedding]),
      );
    },
    async replaceProjectChunks(userId, projectId, chunks) {
      saved.set(`${userId}/${projectId}`, chunks);
    },
  };
}

describe("storeKnowledge", () => {
  it("embeds every chunk in order and stores each with its vector, hash and model", async () => {
    const embedder = fakeEmbedder();
    const store = inMemoryStore();

    const result = await storeKnowledge({ embedder, store }, "u1", "p1", drafts);

    expect(result).toEqual({ chunks: 2, reused: 0 });
    expect(embedder.calls).toEqual([["function a() {}", "function b() {}"]]);
    expect(store.saved.get("u1/p1")).toEqual([
      { ...drafts[0], embedding: [0, 0], contentHash: contentHash("function a() {}"), embeddingModel: MODEL },
      { ...drafts[1], embedding: [1, 1], contentHash: contentHash("function b() {}"), embeddingModel: MODEL },
    ]);
  });

  describe("reusing vectors of unchanged content (TD-03)", () => {
    it("embeds nothing when the code did not change", async () => {
      const store = inMemoryStore();
      await storeKnowledge({ embedder: fakeEmbedder(), store }, "u1", "p1", drafts);
      const again = fakeEmbedder();

      const result = await storeKnowledge({ embedder: again, store }, "u1", "p1", drafts);

      expect(again.calls).toEqual([]);
      expect(result).toEqual({ chunks: 2, reused: 2 });
      expect(store.saved.get("u1/p1")!.map((chunk) => chunk.embedding)).toEqual([[0, 0], [1, 1]]);
    });

    it("embeds only the chunks whose content changed", async () => {
      const store = inMemoryStore();
      await storeKnowledge({ embedder: fakeEmbedder(), store }, "u1", "p1", drafts);
      const again = fakeEmbedder();
      const edited = [drafts[0], { ...drafts[1], content: "function b() { return 2; }" }];

      const result = await storeKnowledge({ embedder: again, store }, "u1", "p1", edited);

      expect(again.calls).toEqual([["function b() { return 2; }"]]);
      expect(result).toEqual({ chunks: 2, reused: 1 });
    });

    it("re-embeds everything when the model changed", async () => {
      const store = inMemoryStore();
      await storeKnowledge({ embedder: fakeEmbedder(), store }, "u1", "p1", drafts);
      const newModel = fakeEmbedder("other-model@2:q8");

      const result = await storeKnowledge({ embedder: newModel, store }, "u1", "p1", drafts);

      expect(newModel.calls).toEqual([["function a() {}", "function b() {}"]]);
      expect(result.reused).toBe(0);
      expect(store.saved.get("u1/p1")!.every((chunk) => chunk.embeddingModel === "other-model@2:q8")).toBe(true);
    });

    it("embeds repeated content once", async () => {
      const embedder = fakeEmbedder();
      const repeated = [drafts[0], { ...drafts[0], filePath: "src/copy.ts" }];

      await storeKnowledge({ embedder, store: inMemoryStore() }, "u1", "p1", repeated);

      expect(embedder.calls).toEqual([["function a() {}"]]);
    });

    it("never reuses another project's vectors", async () => {
      const store = inMemoryStore();
      await storeKnowledge({ embedder: fakeEmbedder(), store }, "u1", "p1", drafts);
      const other = fakeEmbedder();

      await storeKnowledge({ embedder: other, store }, "u1", "p2", drafts);

      expect(other.calls).toEqual([["function a() {}", "function b() {}"]]);
    });
  });

  it("rejects an empty chunk list with a user-facing error, touching nothing", async () => {
    const embedder = fakeEmbedder();
    const store = inMemoryStore();

    await expect(storeKnowledge({ embedder, store }, "u1", "p1", [])).rejects.toBeInstanceOf(
      DomainError,
    );
    expect(embedder.calls).toEqual([]);
    expect(store.saved.size).toBe(0);
  });

  it("keeps the previous knowledge when embedding fails", async () => {
    const store = inMemoryStore();
    const replace = vi.spyOn(store, "replaceProjectChunks");
    const failing: Embedder = { model: MODEL, embed: async () => Promise.reject(new Error("model down")) };

    await expect(storeKnowledge({ embedder: failing, store }, "u1", "p1", drafts)).rejects.toThrow(
      "model down",
    );
    expect(replace).not.toHaveBeenCalled();
  });

  it("refuses to store when the embedder returns the wrong number of vectors", async () => {
    const store = inMemoryStore();
    const short: Embedder = { model: MODEL, embed: async () => [[0, 0]] };

    await expect(storeKnowledge({ embedder: short, store }, "u1", "p1", drafts)).rejects.toThrow(
      "Embedder returned 1 vectors for 2 chunks",
    );
    expect(store.saved.size).toBe(0);
  });
});
