"use server";
import { publicErrorMessage } from "@/shared/public-error-message";

import { revalidatePath } from "next/cache";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { redirect } from "next/navigation";
import { z } from "zod";

import { startAnalysisRun } from "@/lib/analysis/analysis-job";
import { uninstallGitHubAppFor } from "@/lib/github-uninstall";
import { auth } from "@/lib/auth";
import { fullNameSchema, GitHubNotConnectedError, refSchema } from "@/lib/github";
import { MAX_REPO_SIZE_BYTES, MAX_UPLOAD_BYTES, UPLOAD_TOO_BIG_MESSAGE } from "@/lib/limits";
import { assertRateLimit } from "@/lib/rate-limit";
import {
  deleteObject,
  objectSize,
  presignedUpload,
  storageConfig,
} from "@/lib/storage/neon-storage";
import { isOwnUploadKey, newUploadKey } from "@/lib/storage/upload-keys";
import { BillingLimitError } from "@/modules/billing";
import { getPlanCatalogWithPricing } from "@/modules/billing/server";
import { disconnectGitHub as forgetGitHubConnection } from "@/modules/identity/server";
import {
  assertGitHubSourceReady,
  findExistingImport,
  importArchive,
  startGitHubImport,
  startUploadImport,
} from "@/modules/projects/server";

export type ProjectActionState = {
  error?: string;
  /** Set when this project was already imported; the form asks to confirm. */
  duplicate?: { name: string };
  /** Plan limit reached: shown as a notice with the upgrade button. */
  limit?: LimitNotice;
};

export type LimitNotice = {
  title: string;
  detail: string;
  upgrade: { label: string; priceLabel: string; features: string[] } | null;
};

async function limitNotice(error: BillingLimitError): Promise<LimitNotice> {
  const paid = error.canUpgrade
    ? (await getPlanCatalogWithPricing()).premium
    : null;
  return {
    title: error.title ?? "Plan limit reached",
    detail: error.detail ?? error.message,
    upgrade: paid
      ? { label: paid.label, priceLabel: paid.priceLabel, features: paid.features }
      : null,
  };
}

const MAX_PROJECT_NAME_LENGTH = 100;

function projectNameFromFileName(fileName: string): string {
  return (
    fileName
      .replace(/\.zip$/i, "")
      .trim()
      .slice(0, MAX_PROJECT_NAME_LENGTH) || "Uploaded project"
  );
}

// Signed upload URLs are cheap but not free: per user, per hour.
const UPLOAD_URLS_PER_HOUR = 20;

const githubImportSchema = z.object({
  fullName: fullNameSchema,
  defaultBranch: refSchema.optional(),
});

async function requireUser() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }
  return session.user;
}


export async function disconnectGitHub() {
  const user = await requireUser();

  // Removes the App from the accounts only this user linked (ADR-007), then
  // forgets the links and any legacy token.
  await uninstallGitHubAppFor(user.id);
  await forgetGitHubConnection(user.id);

  revalidatePath("/settings");
  revalidatePath("/projects/new");
}

export async function createProjectFromGitHub(
  _prev: ProjectActionState,
  formData: FormData,
): Promise<ProjectActionState> {
  const user = await requireUser();
  const parsed = githubImportSchema.safeParse({
    fullName: formData.get("fullName") ?? undefined,
    defaultBranch: formData.get("defaultBranch") || undefined,
  });

  if (!parsed.success) {
    return { error: "Invalid repository selection." };
  }
  const { fullName } = parsed.data;

  const repositoryUrl = `https://github.com/${fullName}`;

  // How the code will be read (GitHub App installation of the owner, or the
  // legacy token): checked now, before the quota, so the answer is instant.
  try {
    await assertGitHubSourceReady({ userId: user.id, name: fullName, repositoryUrl });
  } catch (error) {
    if (error instanceof GitHubNotConnectedError) {
      return { error: "Connect GitHub in Settings before selecting a repository." };
    }
    return { error: publicErrorMessage(error, "Failed to import repository.") };
  }
  if (
    formData.get("confirmReanalyze") !== "1" &&
    (await findExistingImport(user.id, { source: "github", repositoryUrl }))
  ) {
    return { duplicate: { name: fullName } };
  }

  try {
    // The download (up to 100 MB), extraction and storage run in the
    // analysis workflow (ADR-005, TD-10): this request only creates the
    // project under the quota and starts the run. GitHub refusing the
    // download then gives the analysis back (fetchGitHubSourcesStage).
    const { projectId, usageId } = await startGitHubImport({
      userId: user.id,
      name: fullName,
      repositoryUrl,
    });
    const started = await startAnalysisRun(user.id, projectId, {
      fetchFromGitHub: true,
      importUsageId: usageId,
    });
    if (!started) return { error: "Failed to import repository." };

    revalidatePath("/dashboard");
    redirect(`/projects/${projectId}/progress`);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    if (error instanceof BillingLimitError) {
      return { limit: await limitNotice(error) };
    }
    return {
      error: publicErrorMessage(error, "Failed to import repository."),
    };
  }
}

export async function createProjectFromZip(
  _prev: ProjectActionState,
  formData: FormData,
): Promise<ProjectActionState> {
  const user = await requireUser();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return { error: "Please choose a ZIP file to upload." };
  }

  if (!file.name.toLowerCase().endsWith(".zip")) {
    return { error: "Only .zip uploads are supported." };
  }

  // Same rule as the form (UX only there): a bigger body would not reach a
  // Vercel function at all (TD-45).
  if (file.size > MAX_UPLOAD_BYTES) {
    return { error: UPLOAD_TOO_BIG_MESSAGE };
  }

  if (file.size === 0) {
    return { error: "The uploaded ZIP is empty." };
  }

  const name = projectNameFromFileName(file.name);

  if (
    formData.get("confirmReanalyze") !== "1" &&
    (await findExistingImport(user.id, { source: "upload", name }))
  ) {
    return { duplicate: { name } };
  }

  try {
    const zipBuffer = Buffer.from(await file.arrayBuffer());

    const result = await importArchive({
      userId: user.id,
      name,
      source: "upload",
      zipBuffer,
    });

    revalidatePath("/dashboard");
    redirect(`/projects/${result.projectId}/progress`);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    if (error instanceof BillingLimitError) {
      return { limit: await limitNotice(error) };
    }
    return {
      error: publicErrorMessage(error, "Failed to upload project."),
    };
  }
}

export type ZipUploadPlan = {
  error?: string;
  duplicate?: { name: string };
  /** Where the browser sends the file: a short-lived signed POST (ADR-011). */
  upload?: { key: string; url: string; fields: Record<string, string> };
};

const uploadRequestSchema = z.object({
  fileName: z.string().min(1).max(255),
  size: z.coerce.number().int().nonnegative(),
  confirmReanalyze: z.literal("1").optional(),
});

/**
 * Step 1 of a direct ZIP upload (ADR-011): checks the session, the file the
 * browser describes and duplicates, then signs a POST for the bucket. Nothing
 * is charged yet: the quota is used when the import starts. The signed
 * policy enforces the size again on the bucket side.
 */
export async function prepareZipUpload(formData: FormData): Promise<ZipUploadPlan> {
  const user = await requireUser();
  const config = storageConfig();
  if (!config) return { error: "Direct uploads are not available here." };

  const parsed = uploadRequestSchema.safeParse({
    fileName: formData.get("fileName"),
    size: formData.get("size"),
    confirmReanalyze: formData.get("confirmReanalyze") ?? undefined,
  });
  if (!parsed.success) return { error: "Please choose a ZIP file to upload." };
  const { fileName, size, confirmReanalyze } = parsed.data;

  if (!fileName.toLowerCase().endsWith(".zip")) {
    return { error: "Only .zip uploads are supported." };
  }
  if (size === 0) return { error: "The uploaded ZIP is empty." };
  if (size > MAX_REPO_SIZE_BYTES) {
    return { error: `ZIP exceeds the ${MAX_REPO_SIZE_BYTES / (1024 * 1024)} MB limit.` };
  }

  const name = projectNameFromFileName(fileName);
  if (!confirmReanalyze && (await findExistingImport(user.id, { source: "upload", name }))) {
    return { duplicate: { name } };
  }

  try {
    await assertRateLimit(
      `zip-upload:${user.id}`,
      UPLOAD_URLS_PER_HOUR,
      60 * 60 * 1000,
      `Rate limit reached (${UPLOAD_URLS_PER_HOUR} uploads/hour). Try again later.`,
    );
    const key = newUploadKey(user.id);
    const post = await presignedUpload(config, key, MAX_REPO_SIZE_BYTES);
    return { upload: { key, url: post.url, fields: post.fields } };
  } catch (error) {
    return { error: publicErrorMessage(error, "Failed to prepare the upload.") };
  }
}

const uploadStartSchema = z.object({
  key: z.string().min(1).max(200),
  fileName: z.string().min(1).max(255),
});

/**
 * Step 2 of a direct ZIP upload: the file is in the bucket. Checks that the
 * key is this user's and the object really exists within the limit (never
 * the browser's word), creates the project under the quota and starts the
 * analysis workflow, which reads, extracts and deletes the upload.
 */
export async function startZipUpload(formData: FormData): Promise<ProjectActionState> {
  const user = await requireUser();
  const config = storageConfig();
  if (!config) return { error: "Direct uploads are not available here." };

  const parsed = uploadStartSchema.safeParse({
    key: formData.get("key"),
    fileName: formData.get("fileName"),
  });
  if (!parsed.success || !isOwnUploadKey(user.id, parsed.data.key)) {
    return { error: "Upload not found. Please try again." };
  }
  const { key, fileName } = parsed.data;
  const discardUpload = () => deleteObject(config, key).catch(() => undefined);

  try {
    const size = await objectSize(config, key);
    if (size === null) return { error: "Upload not found. Please try again." };
    if (size === 0 || size > MAX_REPO_SIZE_BYTES) {
      await discardUpload();
      return { error: `ZIP exceeds the ${MAX_REPO_SIZE_BYTES / (1024 * 1024)} MB limit.` };
    }

    const { projectId, usageId } = await startUploadImport({
      userId: user.id,
      name: projectNameFromFileName(fileName),
    });
    if (!(await startAnalysisRun(user.id, projectId, { uploadKey: key, importUsageId: usageId }))) {
      await discardUpload();
      return { error: "Failed to upload project." };
    }

    revalidatePath("/dashboard");
    redirect(`/projects/${projectId}/progress`);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    await discardUpload();
    if (error instanceof BillingLimitError) {
      return { limit: await limitNotice(error) };
    }
    return { error: publicErrorMessage(error, "Failed to upload project.") };
  }
}
