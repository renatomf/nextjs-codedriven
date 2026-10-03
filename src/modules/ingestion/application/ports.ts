import type { EmbeddedChunk } from "../domain/knowledge";

/** Turns texts into embeddings, in order. ONNX locally; a fake in tests. */
export interface Embedder {
  /** The model, its revision and dtype: vectors from another model differ. */
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

/** Where a project's knowledge lives. pgvector; in memory in tests. */
export interface VectorStore {
  /**
   * The project's stored vectors made by `model`, by content hash (TD-03),
   * so a rebuild only embeds what changed. Empty for another user's project.
   */
  embeddingsByContent(
    userId: string,
    projectId: string,
    model: string,
  ): Promise<Map<string, number[]>>;
  /**
   * Replaces all chunks of the project at once (all or nothing). Throws when
   * the project does not belong to `userId`.
   */
  replaceProjectChunks(userId: string, projectId: string, chunks: EmbeddedChunk[]): Promise<void>;
}
