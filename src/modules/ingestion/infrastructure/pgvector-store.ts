import { and, cosineDistance, eq, exists, isNotNull, sql } from "drizzle-orm";

import { codeChunks, projects } from "@/db/schema";
import { db } from "@/lib/db";
import { traced } from "@/shared/tracing";

import type { VectorStore } from "../application/ports";

export type StoredChunk = {
  id: string;
  filePath: string;
  content: string;
  startLine: number | null;
  endLine: number | null;
  score?: number;
};

// Every function is scoped by the owner's `userId` (from the server session,
// never from the client) in addition to `projectId`.

export const pgvectorStore: VectorStore = {
  embeddingsByContent(userId, projectId, model) {
    return traced("vector.read_existing", {}, () => existingEmbeddings(userId, projectId, model));
  },
  replaceProjectChunks(userId, projectId, chunks) {
    return traced("vector.replace_chunks", { chunks: chunks.length }, () =>
      replaceChunks(userId, projectId, chunks),
    );
  },
};

async function existingEmbeddings(
  userId: string,
  projectId: string,
  model: string,
): Promise<Map<string, number[]>> {
  const rows = await db
    .select({ contentHash: codeChunks.contentHash, embedding: codeChunks.embedding })
    .from(codeChunks)
    .where(
      and(
        eq(codeChunks.projectId, projectId),
        eq(codeChunks.embeddingModel, model),
        isNotNull(codeChunks.contentHash),
        exists(
          db
            .select({ id: projects.id })
            .from(projects)
            .where(and(eq(projects.id, projectId), eq(projects.userId, userId))),
        ),
      ),
    );
  return new Map(rows.map((row) => [row.contentHash!, row.embedding]));
}

async function replaceChunks(
  userId: string,
  projectId: string,
  chunks: Parameters<VectorStore["replaceProjectChunks"]>[2],
): Promise<void> {
  await db.transaction(async (tx) => {
    const [project] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
    if (!project) throw new Error("Project not found");

    await tx.delete(codeChunks).where(eq(codeChunks.projectId, projectId));

    const INSERT_BATCH = 100;
    for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
      const batch = chunks.slice(i, i + INSERT_BATCH);
      await tx.insert(codeChunks).values(
        batch.map((chunk) => ({
          projectId,
          filePath: chunk.filePath,
          content: chunk.content,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          embedding: chunk.embedding,
          contentHash: chunk.contentHash,
          embeddingModel: chunk.embeddingModel,
        })),
      );
    }
  });
}

/** Top-k similarity search over a project's code chunks. */
export async function searchProjectChunks(
  userId: string,
  projectId: string,
  queryEmbedding: number[],
  limit = 8,
): Promise<StoredChunk[]> {
  const distance = cosineDistance(codeChunks.embedding, queryEmbedding);

  return traced("vector.search", { limit }, async () => db
    .select({
      id: codeChunks.id,
      filePath: codeChunks.filePath,
      content: codeChunks.content,
      startLine: codeChunks.startLine,
      endLine: codeChunks.endLine,
      score: sql<number>`1 - (${distance})`.mapWith(Number),
    })
    .from(codeChunks)
    .where(
      and(
        eq(codeChunks.projectId, projectId),
        exists(
          db
            .select({ id: projects.id })
            .from(projects)
            .where(and(eq(projects.id, projectId), eq(projects.userId, userId))),
        ),
      ),
    )
    .orderBy(distance)
    .limit(limit));
}
