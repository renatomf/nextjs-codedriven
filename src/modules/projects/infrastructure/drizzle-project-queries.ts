import { and, desc, eq, ne, sql } from "drizzle-orm";

import { codeChunks, projects, reports } from "@/db/schema";
import { db } from "@/lib/db";

/**
 * Read models for the pages and the status route. Every query is scoped by
 * `userId`, which must come from the server session: another user's project
 * resolves to undefined. Same queries the pages ran before.
 */

const owned = (userId: string, projectId: string) =>
  and(eq(projects.id, projectId), eq(projects.userId, userId));

/**
 * An earlier import of the same repository / ZIP that did not fail.
 * Re-importing it needs an explicit confirmation.
 */
export async function findExistingImport(
  userId: string,
  match: { source: "github"; repositoryUrl: string } | { source: "upload"; name: string },
) {
  const [existing] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.userId, userId),
        eq(projects.source, match.source),
        match.source === "github"
          ? eq(projects.repositoryUrl, match.repositoryUrl)
          : eq(projects.name, match.name),
        ne(projects.status, "failed"),
      ),
    )
    .limit(1);
  return existing;
}

/** The dashboard list: only the columns it renders, newest first. */
export function listUserProjects(userId: string) {
  return db
    .select({
      id: projects.id,
      name: projects.name,
      source: projects.source,
      framework: projects.framework,
      status: projects.status,
      fileCount: projects.fileCount,
      healthScore: reports.healthScore,
      chunkCount: sql<number>`(select count(*) from ${codeChunks} where ${codeChunks.projectId} = ${projects.id})`.mapWith(Number),
    })
    .from(projects)
    .leftJoin(reports, eq(reports.projectId, projects.id))
    .where(eq(projects.userId, userId))
    .orderBy(desc(projects.createdAt));
}

/** Project header data shared by the project layout and its tabs. */
export async function getProjectSummary(userId: string, projectId: string) {
  const [project] = await db
    .select({
      id: projects.id,
      name: projects.name,
      source: projects.source,
      framework: projects.framework,
      status: projects.status,
      fileCount: projects.fileCount,
      repositoryUrl: projects.repositoryUrl,
      errorMessage: projects.errorMessage,
      codeRemovedAt: projects.codeRemovedAt,
      healthScore: reports.healthScore,
      chunkCount: sql<number>`(select count(*) from ${codeChunks} where ${codeChunks.projectId} = ${projects.id})`.mapWith(Number),
      issueCount: sql<number>`coalesce(jsonb_array_length(${reports.issues}), 0)`.mapWith(Number),
      criticalCount: sql<number>`(select count(*) from jsonb_array_elements(coalesce(${reports.issues}, '[]'::jsonb)) as issue where issue->>'severity' = 'critical')`.mapWith(Number),
    })
    .from(projects)
    .leftJoin(reports, eq(reports.projectId, projects.id))
    .where(owned(userId, projectId))
    .limit(1);

  return project;
}

/** Live progress: the progress page and the status route it polls. */
export function getProjectProgress(userId: string, projectId: string) {
  return db.query.projects.findFirst({
    where: owned(userId, projectId),
    columns: {
      id: true,
      name: true,
      status: true,
      progressStep: true,
      progressPercent: true,
      errorMessage: true,
      framework: true,
      fileCount: true,
    },
    with: { report: { columns: { healthScore: true } } },
  });
}

/** The owner's project: what the chat and the explorer routes need. */
export async function findOwnedProject(userId: string, projectId: string) {
  const [project] = await db
    .select({ id: projects.id, name: projects.name, framework: projects.framework })
    .from(projects)
    .where(owned(userId, projectId))
    .limit(1);
  return project;
}

/** What the analysis actions need to re-run, rebuild or report on a project. */
export async function findReanalysisTarget(userId: string, projectId: string) {
  const [project] = await db
    .select({
      id: projects.id,
      userId: projects.userId,
      name: projects.name,
      source: projects.source,
      repositoryUrl: projects.repositoryUrl,
      progressPercent: projects.progressPercent,
      codeRemovedAt: projects.codeRemovedAt,
    })
    .from(projects)
    .where(owned(userId, projectId))
    .limit(1);
  return project;
}

/** The chat needs the project and to know whether its code is indexed. */
export async function getChatProject(userId: string, projectId: string) {
  const project = await findOwnedProject(userId, projectId);
  if (!project) return undefined;
  return { ...project, hasChunks: await hasCodeChunks(project.id) };
}

/** Called only after the ownership check of the caller in this file. */
async function hasCodeChunks(projectId: string) {
  const [chunk] = await db
    .select({ id: codeChunks.id })
    .from(codeChunks)
    .where(eq(codeChunks.projectId, projectId))
    .limit(1);
  return Boolean(chunk);
}

export async function getProjectIssues(userId: string, projectId: string) {
  const project = await db.query.projects.findFirst({
    where: owned(userId, projectId),
    columns: { id: true, name: true },
    with: {
      report: {
        columns: {
          issues: true,
          healthScore: true,
        },
      },
    },
  });
  if (!project) return undefined;
  return { ...project, hasChunks: await hasCodeChunks(project.id) };
}

export async function getProjectReport(userId: string, projectId: string) {
  const project = await db.query.projects.findFirst({
    where: owned(userId, projectId),
    columns: { id: true, name: true, errorMessage: true },
    // Only what the page shows. `report: true` would also load every new
    // column: llm_review (TD-43) is internal, and loading a column that was
    // not migrated yet broke every report page in production (2026-10-03).
    with: { report: { columns: { healthScore: true, categoryScores: true, issues: true } } },
  });
  if (!project) return undefined;
  return { ...project, hasChunks: await hasCodeChunks(project.id) };
}
