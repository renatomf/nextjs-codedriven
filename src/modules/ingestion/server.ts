import "server-only";

import { logger } from "@/shared/logger";

import type { ChunkDraft } from "./domain/knowledge";
import { storeKnowledge } from "./application/store-knowledge";
import { onnxEmbedder } from "./infrastructure/onnx-embedder";
import { pgvectorStore } from "./infrastructure/pgvector-store";

/**
 * Public API of the ingestion module — server part (ADR-001). Every
 * `userId` must come from the server session, never from the client.
 */

export { embedQuery } from "./infrastructure/onnx-embedder";
export { searchProjectChunks, type StoredChunk } from "./infrastructure/pgvector-store";

/**
 * Embeds the chunks and replaces the project's knowledge in pgvector,
 * reusing the vectors of unchanged content (TD-03). Logs how many were
 * reused: the measure of what a re-analysis saved.
 */
export async function storeProjectChunks(
  userId: string,
  projectId: string,
  drafts: ChunkDraft[],
): Promise<number> {
  const result = await storeKnowledge(
    { embedder: onnxEmbedder, store: pgvectorStore },
    userId,
    projectId,
    drafts,
  );
  logger.info("ingestion.knowledge_stored", { projectId, ...result });
  return result.chunks;
}
