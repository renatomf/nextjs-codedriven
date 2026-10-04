import { DomainError } from "@/shared/errors";
import { logger } from "@/shared/logger";
import { publicErrorMessage } from "@/shared/public-error-message";

import { extractFromZipBuffer } from "@/lib/files/extract";
import { isSourceFile, type ExtractedFile } from "@/lib/files/filters";
import { detectFramework } from "@/lib/files/framework";
import { deleteProjectFiles, persistProjectFiles } from "@/lib/files/storage";
import { deleteObject, readObject, storageConfig } from "@/lib/storage/neon-storage";
import { isOwnUploadKey } from "@/lib/storage/upload-keys";
import {
  downloadGitHubZipball,
  type GitHubCredentials,
  GitHubError,
  GitHubNotConnectedError,
} from "@/lib/github";
import { GitHubInstallationGoneError } from "@/lib/github-app";
import { refundAnalysisUsage, withQuota } from "@/modules/billing/server";
import {
  forgetGitHubInstallation,
  installationForOwner,
  listGitHubInstallations,
} from "@/modules/identity/server";

import { AnalysisCanceledError } from "../domain/project";
import { createImportingProject, setProjectProgress } from "./drizzle-project-lifecycle";
import { findReanalysisTarget } from "./drizzle-project-queries";

/**
 * Import: creates the project under the plan quota, extracts the archive and
 * stores its files, leaving the project queued for analysis. The analysis
 * itself runs later, from the progress page.
 *
 * Quota (ADR-003): an invalid archive is the user's error and stays charged;
 * a failure on our side (an exception) gives the analysis back.
 */
export async function importArchive(options: {
  userId: string;
  name: string;
  source: "github" | "upload";
  repositoryUrl?: string;
  zipBuffer: Buffer;
}) {
  // Limit check, insert and usage record in one transaction: the user row is
  // locked, so parallel requests cannot all pass the check.
  const { project, usageId } = await withQuota(options.userId, "project", async (tx, usage) => {
    const created = await createImportingProject(tx, {
      userId: options.userId,
      name: options.name,
      source: options.source,
      repositoryUrl: options.repositoryUrl,
    });
    return { consumed: true, value: { project: created, usageId: usage.id } };
  });

  try {
    await setProjectProgress(options.userId, project.id, {
      step: "Reading files",
      percent: 15,
      status: "processing",
    });

    const extracted = await extractFromZipBuffer(options.zipBuffer, {
      stripRoot: options.source === "github",
    });

    // A bad archive (corrupt, too big, no JS/TS) is the user's error: the
    // analysis stays charged (ADR-003), so invalid uploads cannot be free.
    if (!extracted.ok) {
      await setProjectProgress(options.userId, project.id, {
        step: "Import failed",
        percent: 15,
        status: "failed",
        errorMessage: extracted.error,
      });
      return { projectId: project.id, failed: true as const };
    }

    await setProjectProgress(options.userId, project.id, {
      step: "Detecting framework",
      percent: 22,
      status: "processing",
    });

    await storeExtractedFiles(options.userId, project.id, extracted);

    return { projectId: project.id, failed: false as const };
  } catch (error) {
    // Mark as failed first: if the cleanup below also fails, the project must
    // still leave `processing`.
    await setProjectProgress(options.userId, project.id, {
      step: "Import failed",
      percent: 10,
      status: "failed",
      errorMessage: publicErrorMessage(error, "Project ingestion failed."),
    });
    // A failure on our side (database, storage) gives the analysis back.
    await refundAnalysisUsage(options.userId, usageId).catch((refundError) => {
      logger.error("billing.refund_failed", { err: refundError, projectId: project.id });
    });
    // Best effort: persistProjectFiles is atomic, so there is rarely anything left.
    await deleteProjectFiles(options.userId, project.id).catch((cleanupError) => {
      logger.error("project.cleanup_failed", { err: cleanupError, projectId: project.id });
    });
    return { projectId: project.id, failed: true as const };
  }
}

/**
 * Shared by the import and the re-analysis: stores the extracted files
 * (atomically: the previous files stay if this fails) and queues the
 * project with its framework and source file count. Inside the analysis
 * workflow the project stays "processing": "queued" would let the progress
 * page start a second run.
 */
async function storeExtractedFiles(
  userId: string,
  projectId: string,
  extracted: {
    sourceFiles: ExtractedFile[];
    allRelativePaths: string[];
    skippedLargeFiles: string[];
  },
  nextStatus: "queued" | "processing" = "queued",
) {
  const framework = detectFramework(
    extracted.sourceFiles,
    extracted.allRelativePaths,
  );
  const sourceOnly = extracted.sourceFiles.filter((file) =>
    isSourceFile(file.relativePath),
  );

  await persistProjectFiles(userId, projectId, extracted.sourceFiles);

  await setProjectProgress(userId, projectId, {
    step: "Files ready for analysis",
    percent: 25,
    status: nextStatus,
    framework,
    fileCount: sourceOnly.length,
    errorMessage:
      extracted.skippedLargeFiles.length > 0
        ? `Skipped ${extracted.skippedLargeFiles.length} file(s) over the size limit.`
        : null,
  });
}

function githubFullName(project: {
  name: string;
  repositoryUrl: string | null;
}): string | null {
  if (project.name.includes("/")) return project.name;
  const match = project.repositoryUrl?.match(/github\.com\/([^/]+\/[^/#?]+)/i);
  return match?.[1]?.replace(/\.git$/i, "") ?? null;
}

/**
 * The GitHub archive was fetched but has nothing to analyze (no JS/TS
 * files, too big once extracted): the user's error, so a new import stays
 * charged (ADR-003). Anything GitHub itself refuses is a `GitHubError`.
 */
export class ArchiveError extends DomainError {
  name = "ArchiveError";
}

type GitHubSourceProject = {
  id: string;
  userId: string;
  name: string;
  source: "github" | "upload";
  repositoryUrl: string | null;
};

/**
 * What a GitHub project needs before its code can be fetched: the
 * repository's name and the GitHub App installation of its owner (ADR-007,
 * read-only). Cheap, so callers run it before charging the quota and answer
 * at once.
 */
export async function assertGitHubSourceReady(
  project: Pick<GitHubSourceProject, "userId" | "name" | "repositoryUrl">,
): Promise<{ fullName: string; credentials: GitHubCredentials }> {
  const fullName = githubFullName(project);
  if (!fullName) {
    throw new GitHubError(
      "Could not determine the GitHub repository for this project.",
    );
  }

  const installations = await listGitHubInstallations(project.userId);
  const installation = installationForOwner(installations, fullName.split("/")[0]);
  if (installation) {
    return { fullName, credentials: { installationId: installation.installationId } };
  }

  if (installations.length > 0) {
    throw new GitHubError(
      "The GitHub App is not installed on this repository's account. Add it in Settings → Connect GitHub.",
    );
  }
  throw new GitHubNotConnectedError("Connect GitHub in Settings before re-analyzing this repository.");
}

/**
 * Re-analysis of a GitHub project: fetches the latest code and replaces the
 * stored files. Errors are user-facing (`GitHubError`, `ArchiveError`); the
 * caller marks the project failed. Uploaded (ZIP) projects reuse their
 * stored files. `keepProcessing`: called from the analysis workflow.
 */
export async function refreshGitHubSources(
  project: GitHubSourceProject,
  { keepProcessing = false }: { keepProcessing?: boolean } = {},
): Promise<void> {
  if (project.source !== "github") return;

  const { fullName, credentials } = await assertGitHubSourceReady(project);
  await setProjectProgress(project.userId, project.id, {
    step: "Fetching latest code from GitHub",
    percent: 10,
    status: "processing",
    errorMessage: null,
  });

  // Validates `fullName` and aborts past MAX_REPO_SIZE_BYTES.
  let zipBuffer: Buffer;
  try {
    zipBuffer = await downloadGitHubZipball(credentials, fullName);
  } catch (error) {
    // Uninstalled on GitHub: forget the link, so the next try asks to connect.
    if (error instanceof GitHubInstallationGoneError) {
      await forgetGitHubInstallation(project.userId, credentials.installationId);
    }
    throw error;
  }

  await setProjectProgress(project.userId, project.id, {
    step: "Reading updated files",
    percent: 18,
    status: "processing",
  });

  const extracted = await extractFromZipBuffer(zipBuffer, { stripRoot: true });
  if (!extracted.ok) {
    // Extraction errors are fixed, user-facing messages.
    throw new ArchiveError(extracted.error);
  }

  await storeExtractedFiles(
    project.userId,
    project.id,
    extracted,
    keepProcessing ? "processing" : "queued",
  );
}

/**
 * A new GitHub import, before any download: the project is created under
 * the plan quota and left "processing" for the analysis workflow, which
 * fetches the code (ADR-005). `usageId` lets the workflow give the analysis
 * back if GitHub then fails.
 */
export async function startGitHubImport(options: {
  userId: string;
  name: string;
  repositoryUrl: string;
}): Promise<{ projectId: string; usageId: string }> {
  const { project, usageId } = await withQuota(options.userId, "project", async (tx, usage) => {
    const created = await createImportingProject(tx, { ...options, source: "github" });
    return { consumed: true, value: { project: created, usageId: usage.id } };
  });
  await setProjectProgress(options.userId, project.id, {
    step: "Fetching code from GitHub",
    percent: 10,
    status: "processing",
  });
  return { projectId: project.id, usageId };
}

/**
 * A ZIP the browser already sent to object storage (ADR-011): the project is
 * created under the plan quota and left "processing" for the analysis
 * workflow, which reads the upload. `usageId` lets the workflow give the
 * analysis back on a failure on our side.
 */
export async function startUploadImport(options: {
  userId: string;
  name: string;
}): Promise<{ projectId: string; usageId: string }> {
  const { project, usageId } = await withQuota(options.userId, "project", async (tx, usage) => {
    const created = await createImportingProject(tx, { ...options, source: "upload" });
    return { consumed: true, value: { project: created, usageId: usage.id } };
  });
  return { projectId: project.id, usageId };
}

/**
 * Workflow stage (ADR-011): reads the uploaded ZIP from object storage,
 * extracts and stores its files, and deletes the upload. Writes its own
 * failure; an invalid archive stays charged, a failure on our side gives the
 * analysis back (ADR-003), as in the in-request import. The upload is
 * deleted once nothing will read it again (success, user error, last try).
 */
export async function fetchUploadedZipStage(
  userId: string,
  projectId: string,
  options: { key: string; importUsageId?: string; finalAttempt?: boolean },
): Promise<void> {
  const { key, importUsageId, finalAttempt = true } = options;
  const config = storageConfig();
  if (!config) throw new Error("Object storage is not configured.");
  if (!isOwnUploadKey(userId, key)) throw new DomainError("Upload not found.");
  const discardUpload = () =>
    deleteObject(config, key).catch((error: unknown) =>
      logger.warn("project.upload_delete_failed", { err: error, projectId }),
    );

  if (!(await findReanalysisTarget(userId, projectId))) {
    await discardUpload();
    throw new AnalysisCanceledError();
  }

  try {
    await setProjectProgress(userId, projectId, {
      step: "Reading files",
      percent: 15,
      status: "processing",
    });
    const extracted = await extractFromZipBuffer(await readObject(config, key));
    if (!extracted.ok) throw new ArchiveError(extracted.error);

    await setProjectProgress(userId, projectId, {
      step: "Detecting framework",
      percent: 22,
      status: "processing",
    });
    await storeExtractedFiles(userId, projectId, extracted, "processing");
    await discardUpload();
  } catch (error) {
    const isDomain = error instanceof DomainError;
    if (!isDomain && !finalAttempt) {
      logger.warn("project.upload_import_retrying", { err: error, userId, projectId });
      throw error;
    }
    if (!isDomain) logger.error("project.upload_import_failed", { err: error, userId, projectId });

    const stillExists = await setProjectProgress(userId, projectId, {
      step: "Import failed",
      percent: 15,
      status: "failed",
      errorMessage: publicErrorMessage(error, "Project ingestion failed."),
    });
    if (importUsageId && !(error instanceof ArchiveError)) {
      await refundAnalysisUsage(userId, importUsageId).catch((refundError) => {
        logger.error("billing.refund_failed", { err: refundError, projectId });
      });
    }
    await discardUpload();
    if (!stillExists) throw new AnalysisCanceledError();
    throw error;
  }
}

/**
 * Workflow stage (ADR-005): fetches the GitHub code into a project the
 * workflow owns, for a new import or a re-analysis. Writes its own failure,
 * with a user-facing message. A new import (`importUsageId`) charges nothing
 * when GitHub refuses or fails, as before the job (the download came before
 * the quota); an archive with nothing to analyze stays charged (ADR-003).
 * `finalAttempt`: false while the workflow will retry a transient failure.
 */
export async function fetchGitHubSourcesStage(
  userId: string,
  projectId: string,
  options: { finalAttempt?: boolean; importUsageId?: string } = {},
): Promise<void> {
  const { finalAttempt = true, importUsageId } = options;
  const project = await findReanalysisTarget(userId, projectId);
  if (!project) throw new AnalysisCanceledError();

  try {
    await refreshGitHubSources(project, { keepProcessing: true });
  } catch (error) {
    const isDomain = error instanceof DomainError;
    if (!isDomain && !finalAttempt) {
      logger.warn("project.github_fetch_retrying", { err: error, userId, projectId });
      throw error;
    }
    if (!isDomain) logger.error("project.github_fetch_failed", { err: error, userId, projectId });

    const stillExists = await setProjectProgress(userId, projectId, {
      step: importUsageId ? "Import failed" : "Re-analyze failed",
      percent: 10,
      status: "failed",
      errorMessage: publicErrorMessage(error, "Failed to fetch the repository from GitHub."),
    });
    if (!stillExists) throw new AnalysisCanceledError();

    if (importUsageId && !(error instanceof ArchiveError)) {
      await refundAnalysisUsage(userId, importUsageId).catch((refundError) => {
        logger.error("billing.refund_failed", { err: refundError, projectId });
      });
    }
    throw error;
  }
}
