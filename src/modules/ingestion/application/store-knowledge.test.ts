import { describe, expect, it, vi } from "vitest";

import { DomainError } from "@/shared/errors";

import type { ChunkDraft, EmbeddedChunk } from "../domain/knowledge";
import type { Embedder, VectorStore } from "./ports";
import { contentHash, embedMissingBatch, storeKnowledge } from "./store-knowledge";

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

/**
 * Keeps what was stored (and the batches kept for the swap) and serves it
 * back by content hash, per model.
 */
function inMemoryStore(): VectorStore & {
  saved: Map<string, EmbeddedChunk[]>;
  kept: Map<string, Map<string, number[]>>;
} {
  const saved = new Map<string, EmbeddedChunk[]>();
  const kept = new Map<string, Map<string, number[]>>();
  return {
    saved,
    kept,
    async embeddingsByContent(userId, projectId, model) {
      const chunks = saved.get(`${userId}/${projectId}`) ?? [];
      return new Map([
        ...chunks
          .filter((chunk) => chunk.embeddingModel === model)
          .map((chunk) => [chunk.contentHash, chunk.embedding] as const),
        ...(kept.get(`${userId}/${projectId}/${model}`) ?? new Map()),
      ]);
    },
    async keepEmbeddings(userId, projectId, model, vectors) {
      const key = `${userId}/${projectId}/${model}`;
      const batch = kept.get(key) ?? new Map<string, number[]>();
      for (const vector of vectors) if (!batch.has(vector.contentHash)) batch.set(vector.contentHash, vector.embedding);
      kept.set(key, batch);
    },
    async replaceProjectChunks(userId, projectId, chunks) {
      saved.set(`${userId}/${projectId}`, chunks);
      for (const key of [...kept.keys()]) if (key.startsWith(`${userId}/${projectId}/`)) kept.delete(key);
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

  describe("embedding in batches across steps (ADR-006, TD-46)", () => {
    const many: ChunkDraft[] = Array.from({ length: 5 }, (_, i) => ({
      filePath: `src/f${i}.ts`,
      content: `function f${i}() {}`,
      startLine: 1,
      endLine: 1,
    }));

    it("embeds up to the limit per batch, then the swap embeds nothing", async () => {
      const store = inMemoryStore();
      const embedder = fakeEmbedder();

      expect(await embedMissingBatch({ embedder, store }, "u1", "p1", many, 2)).toEqual({ embedded: 2, remaining: 3 });
      expect(await embedMissingBatch({ embedder, store }, "u1", "p1", many, 2)).toEqual({ embedded: 2, remaining: 1 });
      expect(await embedMissingBatch({ embedder, store }, "u1", "p1", many, 2)).toEqual({ embedded: 1, remaining: 0 });
      expect(embedder.calls.map((texts) => texts.length)).toEqual([2, 2, 1]);

      const swap = fakeEmbedder();
      const result = await storeKnowledge({ embedder: swap, store }, "u1", "p1", many);

      expect(swap.calls).toEqual([]);
      expect(result).toEqual({ chunks: 5, reused: 5 });
      expect(store.kept.size).toBe(0); // the batches are now the knowledge
    });

    it("skips what a retried batch already kept", async () => {
      const store = inMemoryStore();
      await embedMissingBatch({ embedder: fakeEmbedder(), store }, "u1", "p1", many, 3);
      const retry = fakeEmbedder();

      await embedMissingBatch({ embedder: retry, store }, "u1", "p1", many, 3);

      expect(retry.calls).toEqual([["function f3() {}", "function f4() {}"]]);
    });

    it("has nothing to do for unchanged code", async () => {
      const store = inMemoryStore();
      await storeKnowledge({ embedder: fakeEmbedder(), store }, "u1", "p1", many);
      const again = fakeEmbedder();

      expect(await embedMissingBatch({ embedder: again, store }, "u1", "p1", many, 2)).toEqual({ embedded: 0, remaining: 0 });
      expect(again.calls).toEqual([]);
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
