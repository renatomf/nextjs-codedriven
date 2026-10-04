import "server-only";

import { closeBillingAccount } from "@/modules/billing/server";
import { deleteAccountData } from "@/modules/identity/server";
import { deleteObject, staleObjects, storageConfig } from "@/lib/storage/neon-storage";
import { UPLOADS_PREFIX } from "@/lib/storage/upload-keys";
import { logger } from "@/shared/logger";

/** More than a user can have: uploads are capped per hour and deleted after import. */
const MAX_UPLOADS = 1_000;

/** ZIPs the user sent but that were not imported yet (ADR-011). */
async function deleteUploads(userId: string): Promise<void> {
  const config = storageConfig();
  if (!config) return;
  // Every object under the prefix, however recent.
  const keys = await staleObjects(
    config,
    `${UPLOADS_PREFIX}${userId}/`,
    new Date(Date.now() + 60_000),
    MAX_UPLOADS,
  );
  for (const key of keys) await deleteObject(config, key);
}

/**
 * Deletes an account end to end (roadmap Phase 6, LGPD). `userId` must come
 * from the server session. Order matters:
 * 1. Stripe first: if it fails, nothing is deleted, so no subscription is
 *    left charging an account that no longer exists.
 * 2. Pending uploads: best effort; the daily reaper deletes any left.
 * 3. The database rows, in one transaction (the user and everything it owns).
 */
export async function deleteAccount(userId: string): Promise<boolean> {
  await closeBillingAccount(userId);

  try {
    await deleteUploads(userId);
  } catch (error) {
    logger.warn("account.uploads_not_deleted", { err: error, userId });
  }

  const deleted = await deleteAccountData(userId);
  if (deleted) logger.info("account.deleted", { userId });
  return deleted;
}
