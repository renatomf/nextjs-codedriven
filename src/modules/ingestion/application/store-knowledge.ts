import { createHash } from "node:crypto";

import { DomainError } from "@/shared/errors";

import type { ChunkDraft } from "../domain/knowledge";
import type { Embedder, VectorStore } from "./ports";

/** Fingerprint of a chunk's text: the only input of its embedding. */
export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export type StoreKnowledgeResult = {
  chunks: number;
  /** Chunks whose vector came from the previous knowledge (TD-03). */
  reused: number;
};

/**
 * Embeds a project's chunks and replaces its stored knowledge. Only content
 * the project has no vector for (from the same model) is embedded: a rebuild
 * of unchanged code embeds nothing (TD-03), and repeated content is embedded
 * once. Embedding is slow, so it runs before the store is touched: if it
 * fails, the previous knowledge stays as it was. `userId` must come from the
 * server session.
 */
export async function storeKnowledge(
  deps: { embedder: Embedder; store: VectorStore },
  userId: string,
  projectId: string,
  drafts: ChunkDraft[],
): Promise<StoreKnowledgeResult> {
  if (drafts.length === 0) {
    throw new DomainError("No code chunks were produced from the source files.");
  }

  const model = deps.embedder.model;
  const known = await deps.store.embeddingsByContent(userId, projectId, model);
  const hashes = drafts.map((draft) => contentHash(draft.content));

  const toEmbed = new Map<string, string>(); // hash → content, each once
  hashes.forEach((hash, i) => {
    if (!known.has(hash) && !toEmbed.has(hash)) toEmbed.set(hash, drafts[i].content);
  });

  const texts = [...toEmbed.values()];
  const embeddings = texts.length > 0 ? await deps.embedder.embed(texts) : [];
  if (embeddings.length !== texts.length) {
    throw new Error(`Embedder returned ${embeddings.length} vectors for ${texts.length} chunks`);
  }
  const fresh = new Map([...toEmbed.keys()].map((hash, i) => [hash, embeddings[i]]));

  await deps.store.replaceProjectChunks(
    userId,
    projectId,
    drafts.map((draft, i) => ({
      ...draft,
      contentHash: hashes[i],
      embeddingModel: model,
      embedding: known.get(hashes[i]) ?? fresh.get(hashes[i])!,
    })),
  );

  return {
    chunks: drafts.length,
    reused: hashes.filter((hash) => known.has(hash)).length,
  };
}
