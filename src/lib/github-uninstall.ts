import "server-only";

import { githubAppConfig, uninstallInstallation } from "@/lib/github-app";
import { installationsOnlyLinkedBy } from "@/modules/identity/server";
import { logger } from "@/shared/logger";

/**
 * When a user disconnects GitHub or deletes the account (ADR-007): removes
 * the App from the accounts only this user linked, so codedriven keeps no
 * access there. Best effort: a GitHub failure never blocks the disconnect or
 * the deletion (the user can still uninstall on GitHub), it is logged.
 * Call before the links are deleted.
 */
export async function uninstallGitHubAppFor(userId: string): Promise<void> {
  if (!githubAppConfig()) return;
  for (const installationId of await installationsOnlyLinkedBy(userId)) {
    try {
      await uninstallInstallation(installationId);
    } catch (error) {
      logger.warn("github.uninstall_failed", { err: error, userId, installationId });
    }
  }
}
