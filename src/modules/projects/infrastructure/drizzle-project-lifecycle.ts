import { and, asc, eq, gt, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";

import { projects } from "@/db/schema";
import { db, type Db } from "@/lib/db";

import { ACTIVE_STATUSES, STALE_AFTER_SECONDS, type ProjectStatus } from "../domain/project";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

/**
 * Every write to a project's status. All scoped by `userId`, which must come
 * from the server session: another user's project is never read or changed.
 * The WHERE clauses enforce the domain rules atomically, so two requests
 * racing on the same project cannot both win.
 */

const owned = (userId: string, projectId: string) =>
  and(eq(projects.id, projectId), eq(projects.userId, userId));

export async function findAnalysisCandidate(userId: string, projectId: string) {
  const [project] = await db
    .select({
      id: projects.id,
      source: projects.source,
      status: projects.status,
      fileCount: projects.fileCount,
      progressStep: projects.progressStep,
      progressPercent: projects.progressPercent,
      updatedAt: projects.updatedAt,
      analysisRunId: projects.analysisRunId,
      codeRemovedAt: projects.codeRemovedAt,
    })
    .from(projects)
    .where(owned(userId, projectId))
    .limit(1);
  return project;
}

export async function readProgress(userId: string, projectId: string) {
  const [project] = await db
    .select({
      status: projects.status,
      progressStep: projects.progressStep,
      progressPercent: projects.progressPercent,
    })
    .from(projects)
    .where(owned(userId, projectId))
    .limit(1);
  return project;
}

/**
 * Creates a project whose files are being read (inside the quota
 * transaction, so the limit check and the insert commit together).
 */
export async function createImportingProject(
  executor: Executor,
  project: {
    userId: string;
    name: string;
    source: "github" | "upload";
    repositoryUrl?: string;
  },
) {
  const [created] = await executor
    .insert(projects)
    .values({
      ...project,
      status: "processing",
      progressStep: "Reading files",
      progressPercent: 10,
    })
    .returning({ id: projects.id });
  return created;
}

/**
 * Atomic claim: only one request can move the project into "processing", so
 * parallel calls (two tabs, a refresh) never run the analysis twice. Same
 * rule as `analysisStart` returning "claimable". `deadRunId`: the run the
 * caller saw finished while the project stayed "processing"; the claim clears
 * the run id, so of two requests that saw the same dead run only one wins.
 * A project whose code was removed (retention) is never claimed: there are
 * no stored files to analyze.
 */
export async function claimAnalysis(
  userId: string,
  projectId: string,
  deadRunId: string | null = null,
): Promise<boolean> {
  const [claimed] = await db
    .update(projects)
    .set({
      status: "processing",
      progressStep: "Starting analysis",
      progressPercent: 30,
      errorMessage: null,
      analysisRunId: null,
    })
    .where(
      and(
        owned(userId, projectId),
        isNull(projects.codeRemovedAt),
        or(
          eq(projects.status, "queued"),
          and(eq(projects.status, "failed"), gt(projects.fileCount, 0)),
          and(
            eq(projects.status, "processing"),
            lt(
              projects.updatedAt,
              sql`now() - make_interval(secs => ${STALE_AFTER_SECONDS})`,
            ),
          ),
          ...(deadRunId
            ? [and(eq(projects.status, "processing"), eq(projects.analysisRunId, deadRunId))]
            : []),
        ),
      ),
    )
    .returning({ id: projects.id });
  return Boolean(claimed);
}

/** Records the workflow run that now owns a claimed project (ADR-005). */
export async function setAnalysisRunId(
  userId: string,
  projectId: string,
  runId: string,
): Promise<void> {
  await db
    .update(projects)
    .set({ analysisRunId: runId })
    .where(and(owned(userId, projectId), eq(projects.status, "processing")));
}

/**
 * Re-analysis: moves an idle project to "processing". Pass the quota
 * transaction so the claim and the usage record commit together.
 */
export async function startReanalysis(
  executor: Executor,
  userId: string,
  projectId: string,
): Promise<boolean> {
  const [started] = await executor
    .update(projects)
    .set({ status: "processing", errorMessage: null })
    .where(and(owned(userId, projectId), notInArray(projects.status, [...ACTIVE_STATUSES])))
    .returning({ id: projects.id });
  return Boolean(started);
}

/** Queues an idle project again (stored files reused); false if active. */
export async function requeueIdleProject(
  userId: string,
  projectId: string,
  step: string,
): Promise<boolean> {
  const [queued] = await db
    .update(projects)
    .set({ status: "queued", progressStep: step, errorMessage: null })
    .where(and(owned(userId, projectId), notInArray(projects.status, [...ACTIVE_STATUSES])))
    .returning({ id: projects.id });
  return Boolean(queued);
}

/**
 * Deletes a project. Files, chunks and the report go with it
 * (ON DELETE CASCADE). False when there is no such project for this user.
 */
export async function deleteProject(userId: string, projectId: string): Promise<boolean> {
  const deleted = await db
    .delete(projects)
    .where(owned(userId, projectId))
    .returning({ id: projects.id });
  return deleted.length > 0;
}

/**
 * Cancels an active analysis by deleting the project, so nothing is kept. The
 * running pipeline stops at its next step (`setProjectProgress` finds no row)
 * and any late write fails on the FK. False when it is no longer active.
 */
export async function cancelActiveAnalysis(userId: string, projectId: string): Promise<boolean> {
  const canceled = await db
    .delete(projects)
    .where(and(owned(userId, projectId), inArray(projects.status, [...ACTIVE_STATUSES])))
    .returning({ id: projects.id });
  return canceled.length > 0;
}

/**
 * Ends a run that stopped without writing its own failure (a step that timed
 * out, retries exhausted): only a project still "processing" becomes "failed",
 * so a message a step already stored (e.g. no source files) is kept.
 */
export async function failRunningAnalysis(
  userId: string,
  projectId: string,
  errorMessage: string,
): Promise<boolean> {
  const [failed] = await db
    .update(projects)
    .set({ status: "failed", errorMessage })
    .where(and(owned(userId, projectId), eq(projects.status, "processing")))
    .returning({ id: projects.id });
  return Boolean(failed);
}

/**
 * Projects left "processing" with no write for `olderThanSeconds`, oldest
 * first (the daily reaper, TD-11). Not scoped by user: a system job behind
 * CRON_SECRET, never reachable from a session.
 */
export async function findStuckProjects(olderThanSeconds: number, limit: number) {
  return db
    .select({
      id: projects.id,
      userId: projects.userId,
      fileCount: projects.fileCount,
      analysisRunId: projects.analysisRunId,
    })
    .from(projects)
    .where(
      and(
        eq(projects.status, "processing"),
        lt(projects.updatedAt, sql`now() - make_interval(secs => ${olderThanSeconds})`),
      ),
    )
    .orderBy(asc(projects.updatedAt))
    .limit(limit);
}

/**
 * Fails a project found stuck, only if it is still the same stuck run: no
 * write since and the same run id. A project the user restarted in the
 * meantime (fresh write, new run) is left alone.
 */
export async function failStuckProject(
  project: { id: string; userId: string; analysisRunId: string | null },
  olderThanSeconds: number,
  errorMessage: string,
): Promise<boolean> {
  const [failed] = await db
    .update(projects)
    .set({ status: "failed", errorMessage })
    .where(
      and(
        owned(project.userId, project.id),
        eq(projects.status, "processing"),
        lt(projects.updatedAt, sql`now() - make_interval(secs => ${olderThanSeconds})`),
        project.analysisRunId === null
          ? isNull(projects.analysisRunId)
          : eq(projects.analysisRunId, project.analysisRunId),
      ),
    )
    .returning({ id: projects.id });
  return Boolean(failed);
}

/** Status change without a progress step (report generation). */
export async function setProjectStatus(
  userId: string,
  projectId: string,
  status: ProjectStatus,
  errorMessage: string | null,
): Promise<void> {
  await db.update(projects).set({ status, errorMessage }).where(owned(userId, projectId));
}

/** Returns `false` when the project no longer exists (canceled). */
export async function setProjectProgress(
  userId: string,
  projectId: string,
  options: {
    step: string;
    percent: number;
    status?: ProjectStatus;
    errorMessage?: string | null;
    framework?: string | null;
    fileCount?: number;
  },
) {
  const updated = await db
    .update(projects)
    .set({
      progressStep: options.step,
      progressPercent: options.percent,
      ...(options.status ? { status: options.status } : {}),
      ...(options.errorMessage !== undefined
        ? { errorMessage: options.errorMessage }
        : {}),
      ...(options.framework !== undefined
        ? { framework: options.framework }
        : {}),
      ...(options.fileCount !== undefined
        ? { fileCount: options.fileCount }
        : {}),
    })
    .where(owned(userId, projectId))
    .returning({ id: projects.id });

  return updated.length > 0;
}
