import "server-only";

import { CODE_RETENTION_DAYS, STUCK_AFTER_SECONDS, stuckProjectMessage } from "@/modules/projects";
import {
  failStuckProject,
  findIdleProjects,
  findStuckProjects,
  removeIdleProjectCode,
} from "@/modules/projects/server";
import { deleteObject, staleObjects, storageConfig } from "@/lib/storage/neon-storage";
import { UPLOADS_PREFIX } from "@/lib/storage/upload-keys";
import { logger } from "@/shared/logger";

import { analysisRunStatus } from "./analysis-job";

/** Bounds one daily run; the rest waits for the next day. */
const REAP_LIMIT = 100;

export type ReapResult = {
  checked: number;
  failed: number;
  alive: number;
  uploadsDeleted: number;
  codeRemoved: number;
};

/**
 * ZIPs sent to object storage but never imported (the tab closed between the
 * upload and the start, a start that failed). Neon does not run lifecycle
 * rules (ADR-011), so the reaper deletes uploads older than an import could
 * still need them.
 */
async function deleteAbandonedUploads(): Promise<number> {
  const config = storageConfig();
  if (!config) return 0;
  const olderThan = new Date(Date.now() - STUCK_AFTER_SECONDS * 1000);
  const keys = await staleObjects(config, UPLOADS_PREFIX, olderThan, REAP_LIMIT);
  for (const key of keys) await deleteObject(config, key);
  return keys.length;
}

/**
 * Retention (roadmap Phase 6): removes the code of projects nobody used for
 * CODE_RETENTION_DAYS. Each removal re-checks the rule in its transaction,
 * so a project opened in the meantime keeps its code.
 */
async function removeIdleCode(): Promise<number> {
  const idleSeconds = CODE_RETENTION_DAYS * 24 * 60 * 60;
  const idle = await findIdleProjects(idleSeconds, REAP_LIMIT);
  let removed = 0;
  for (const project of idle) {
    if (await removeIdleProjectCode(project.id, idleSeconds)) removed += 1;
  }
  return removed;
}

/**
 * Fails projects stuck in "processing" that nobody reopened (TD-11). A
 * project whose workflow run is still pending or running is left alone,
 * however old its last write; an import (no run) or a finished run that
 * left the project "processing" is failed with a message the user can act
 * on. Also deletes abandoned uploads and removes the code of idle projects
 * (retention). Called by the daily cron (`/api/cron/reap-stuck-projects`).
 */
export async function reapStuckProjects(): Promise<ReapResult> {
  const stuck = await findStuckProjects(STUCK_AFTER_SECONDS, REAP_LIMIT);
  let failed = 0;
  let alive = 0;

  for (const project of stuck) {
    if (project.analysisRunId) {
      const status = await analysisRunStatus(project.analysisRunId);
      if (status === "pending" || status === "running") {
        alive += 1;
        continue;
      }
    }
    if (await failStuckProject(project, STUCK_AFTER_SECONDS, stuckProjectMessage(project.fileCount))) {
      failed += 1;
    }
  }

  const uploadsDeleted = await deleteAbandonedUploads();
  const codeRemoved = await removeIdleCode();

  const result = { checked: stuck.length, failed, alive, uploadsDeleted, codeRemoved };
  logger.info("projects.reaped", result);
  return result;
}
