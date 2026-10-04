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
   * The project's vectors made by `model`, by content hash: those of its
   * stored knowledge (TD-03) and those embedded by earlier batches (TD-46),
   * so a rebuild only embeds what is missing. Empty for another user's
   * project.
   */
  embeddingsByContent(
    userId: string,
    projectId: string,
    model: string,
  ): Promise<Map<string, number[]>>;
  /**
   * Keeps a batch of vectors until the knowledge is replaced (ADR-006).
   * Idempotent: a vector already kept is left as is. Throws when the
   * project does not belong to `userId`.
   */
  keepEmbeddings(
    userId: string,
    projectId: string,
    model: string,
    vectors: Array<{ contentHash: string; embedding: number[] }>,
  ): Promise<void>;
  /**
   * Replaces all chunks of the project at once (all or nothing) and drops the
   * kept batches. Throws when the project does not belong to `userId`.
   */
  replaceProjectChunks(userId: string, projectId: string, chunks: EmbeddedChunk[]): Promise<void>;
}
