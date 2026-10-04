import { and, eq, exists } from "drizzle-orm";

import { accounts, githubInstallations, users } from "@/db/schema";
import { db } from "@/lib/db";

/**
 * The user's account data and GitHub connection. Every function takes the
 * session's `userId` (never a client-sent id). The GitHub token is stored
 * encrypted and bound to its owner (see lib/encryption); only server code
 * that calls GitHub reads it, and pages only get a boolean.
 */

/** For server code that calls GitHub: the encrypted token and the login. */
export async function getGitHubConnection(userId: string) {
  const [user] = await db
    .select({
      githubAccessToken: users.githubAccessToken,
      githubUsername: users.githubUsername,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return user;
}

/** What the settings page shows. The token never leaves this function. */
export async function getAccountSettings(userId: string) {
  const [user] = await db
    .select({
      name: users.name,
      email: users.email,
      authProvider: users.authProvider,
      githubUsername: users.githubUsername,
      githubAccessToken: users.githubAccessToken,
      githubAppInstalled: exists(
        db
          .select({ id: githubInstallations.id })
          .from(githubInstallations)
          .where(eq(githubInstallations.userId, users.id)),
      ).mapWith(Boolean),
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return undefined;
  const { githubAccessToken, githubAppInstalled, ...account } = user;
  // Connected through the GitHub App (ADR-007) or the legacy OAuth token.
  return { ...account, githubConnected: githubAppInstalled || Boolean(githubAccessToken) };
}

/** Stores a (already encrypted) token after the OAuth callback. */
export async function saveGitHubConnection(
  userId: string,
  connection: { encryptedToken: string; login: string },
): Promise<boolean> {
  const updated = await db
    .update(users)
    .set({
      githubAccessToken: connection.encryptedToken,
      githubUsername: connection.login,
    })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  return updated.length > 0;
}

/**
 * Forgets the token, the GitHub App links and the GitHub sign-in link, all
 * or nothing.
 */
export async function disconnectGitHub(userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ githubAccessToken: null, githubUsername: null })
      .where(eq(users.id, userId));

    await tx.delete(githubInstallations).where(eq(githubInstallations.userId, userId));

    await tx
      .delete(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.provider, "github")));
  });
}
