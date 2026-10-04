import "server-only";

/**
 * Public API of the identity module — server part (ADR-001). No domain:
 * account data and the GitHub integration only. Every `userId` must come
 * from the server session.
 */

export {
  disconnectGitHub,
  getAccountSettings,
  getGitHubConnection,
  saveGitHubConnection,
} from "./infrastructure/drizzle-github-connection";
export {
  createEmailAccount,
  dropUnverifiedPassword,
  recordSignIn,
  verifyCredentials,
} from "./infrastructure/drizzle-accounts";
export { deleteAccountData } from "./infrastructure/drizzle-account-deletion";
export {
  forgetGitHubInstallation,
  type GitHubInstallation,
  installationForOwner,
  listGitHubInstallations,
  saveGitHubInstallation,
} from "./infrastructure/drizzle-github-installations";
