import "server-only";

import { and, asc, eq, exists, sql } from "drizzle-orm";

import { projectFiles, projects } from "@/db/schema";
import { db, type Db } from "@/lib/db";
import {
  isSafeRelativePath,
  normalizePath,
  type ExtractedFile,
} from "@/lib/files/filters";

/**
 * Extracted files live in `project_files` (Postgres) local `.data/` folder: serverless disks are ephemeral and not
 * shared between instances, so the pipeline/explorer would not find them.
 *
 * Every function is scoped by the owner's `userId` (from the server session,
 * never from the client) in addition to `projectId`.
 */

export type ProjectManifestEntry = {
  relativePath: string;
  sizeBytes: number;
};

// Keep each INSERT well below Postgres' 65535-parameter limit and avoid
// one huge statement (up to MAX_FILE_COUNT × MAX_FILE_SIZE_BYTES).
const INSERT_BATCH_MAX_ROWS = 200;
const INSERT_BATCH_MAX_BYTES = 4 * 1024 * 1024;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function ownedProject(executor: Db | Tx, userId: string, projectId: string) {
  return executor
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
}

function toBatches(files: ExtractedFile[]): ExtractedFile[][] {
  const batches: ExtractedFile[][] = [];
  let current: ExtractedFile[] = [];
  let currentBytes = 0;

  for (const file of files) {
    if (
      current.length > 0 &&
      (current.length >= INSERT_BATCH_MAX_ROWS ||
        currentBytes + file.sizeBytes > INSERT_BATCH_MAX_BYTES)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += file.sizeBytes;
  }
  if (current.length > 0) batches.push(current);

  return batches;
}

/**
 * Replaces all stored files of the project atomically. An import is a use
 * of the project and brings removed code back (retention, Phase 6); the
 * update also locks the row, so the retention job cannot remove the new
 * files half-way (its own update waits, then sees a fresh `lastUsedAt`).
 */
export async function persistProjectFiles(
  userId: string,
  projectId: string,
  files: ExtractedFile[],
): Promise<void> {
  await db.transaction(async (tx) => {
    const [project] = await tx
      .update(projects)
      .set({ lastUsedAt: sql`now()`, codeRemovedAt: null })
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .returning({ id: projects.id });
    if (!project) throw new Error("Project not found");

    await tx.delete(projectFiles).where(eq(projectFiles.projectId, projectId));

    for (const batch of toBatches(files)) {
      await tx.insert(projectFiles).values(
        batch.map((file) => ({
          projectId,
          relativePath: file.relativePath,
          content: file.content,
          sizeBytes: file.sizeBytes,
        })),
      );
    }
  });
}

/** Paths and sizes only (no content, to keep egress low). */
export async function readProjectManifest(
  userId: string,
  projectId: string,
): Promise<ProjectManifestEntry[]> {
  return db
    .select({
      relativePath: projectFiles.relativePath,
      sizeBytes: projectFiles.sizeBytes,
    })
    .from(projectFiles)
    .where(
      and(
        eq(projectFiles.projectId, projectId),
        exists(ownedProject(db, userId, projectId)),
      ),
    )
    .orderBy(asc(projectFiles.relativePath));
}

export async function readProjectFiles(
  userId: string,
  projectId: string,
): Promise<ExtractedFile[]> {
  return db
    .select({
      relativePath: projectFiles.relativePath,
      content: projectFiles.content,
      sizeBytes: projectFiles.sizeBytes,
    })
    .from(projectFiles)
    .where(
      and(
        eq(projectFiles.projectId, projectId),
        exists(ownedProject(db, userId, projectId)),
      ),
    )
    .orderBy(asc(projectFiles.relativePath));
}

/** `relativePath` may come from the client (explorer), so it is validated. */
export async function readProjectFile(
  userId: string,
  projectId: string,
  relativePath: string,
): Promise<ExtractedFile | null> {
  const normalized = normalizePath(relativePath);
  if (!normalized || !isSafeRelativePath(normalized)) return null;

  const [file] = await db
    .select({
      relativePath: projectFiles.relativePath,
      content: projectFiles.content,
      sizeBytes: projectFiles.sizeBytes,
    })
    .from(projectFiles)
    .where(
      and(
        eq(projectFiles.projectId, projectId),
        eq(projectFiles.relativePath, normalized),
        exists(ownedProject(db, userId, projectId)),
      ),
    )
    .limit(1);

  return file ?? null;
}

export async function deleteProjectFiles(
  userId: string,
  projectId: string,
): Promise<void> {
  await db
    .delete(projectFiles)
    .where(
      and(
        eq(projectFiles.projectId, projectId),
        exists(ownedProject(db, userId, projectId)),
      ),
    );
}
