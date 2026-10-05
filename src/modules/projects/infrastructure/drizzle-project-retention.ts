import { and, asc, eq, isNull, lt, notInArray, sql } from "drizzle-orm";

import { codeChunks, embeddingCache, projectDependencies, projectFiles, projects } from "@/db/schema";
import { db } from "@/lib/db";

import { ACTIVE_STATUSES, LAST_USED_RESOLUTION_SECONDS } from "../domain/project";

/**
 * Retention (roadmap Phase 6): a project's code is removed after a long time
 * without use; the project row and its report stay.
 */

const olderThan = (seconds: number) => sql`now() - make_interval(secs => ${seconds})`;

/**
 * Records that the owner used the project. At most one write a day: a page
 * view within the resolution changes nothing. A running analysis is left
 * alone: the write would bump `updatedAt`, which the stale and stuck windows
 * read (an analysis counts as use anyway, when it stores the files). Scoped
 * by `userId`, which must come from the server session.
 */
export async function touchProject(userId: string, projectId: string): Promise<void> {
  await db
    .update(projects)
    .set({ lastUsedAt: sql`now()` })
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.userId, userId),
        notInArray(projects.status, [...ACTIVE_STATUSES]),
        lt(projects.lastUsedAt, olderThan(LAST_USED_RESOLUTION_SECONDS)),
      ),
    );
}

/** The rule shared by the search and the removal, so both agree. */
const idleWithCode = (idleSeconds: number) =>
  and(
    isNull(projects.codeRemovedAt),
    notInArray(projects.status, [...ACTIVE_STATUSES]),
    lt(projects.lastUsedAt, olderThan(idleSeconds)),
  );

/**
 * Projects with code that nobody used for `idleSeconds`, least recently used
 * first. Not scoped by user: a system job behind CRON_SECRET, never
 * reachable from a session.
 */
export async function findIdleProjects(idleSeconds: number, limit: number) {
  return db
    .select({ id: projects.id })
    .from(projects)
    .where(idleWithCode(idleSeconds))
    .orderBy(asc(projects.lastUsedAt))
    .limit(limit);
}

/**
 * Removes the code of one idle project: files, chunks and kept vectors, in
 * one transaction with the mark. The mark is conditional on the same rule,
 * so a project used (or re-analyzed) since it was found is left alone.
 */
export async function removeIdleProjectCode(
  projectId: string,
  idleSeconds: number,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [marked] = await tx
      .update(projects)
      .set({ codeRemovedAt: sql`now()`, lockfileFound: null })
      .where(and(eq(projects.id, projectId), idleWithCode(idleSeconds)))
      .returning({ id: projects.id });
    if (!marked) return false;

    await tx.delete(projectFiles).where(eq(projectFiles.projectId, projectId));
    await tx.delete(projectDependencies).where(eq(projectDependencies.projectId, projectId));
    await tx.delete(codeChunks).where(eq(codeChunks.projectId, projectId));
    await tx.delete(embeddingCache).where(eq(embeddingCache.projectId, projectId));
    return true;
  });
}
