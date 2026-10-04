import { and, eq, exists } from "drizzle-orm";

import { accounts, githubInstallations, users } from "@/db/schema";
import { db } from "@/lib/db";

/**
 * The user's account data and GitHub connection. Every function takes the
 * session's `userId` (never a client-sent id). Repository access is the
 * GitHub App's (ADR-007): only installation ids are stored, never a token.
 */

/** What the settings page shows. */
export async function getAccountSettings(userId: string) {
  const [user] = await db
    .select({
      name: users.name,
      email: users.email,
      authProvider: users.authProvider,
      githubUsername: users.githubUsername,
      githubConnected: exists(
        db
          .select({ id: githubInstallations.id })
          .from(githubInstallations)
          .where(eq(githubInstallations.userId, users.id)),
      ).mapWith(Boolean),
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return user;
}

/**
 * Forgets the GitHub App links, the GitHub username and the GitHub sign-in
 * link, all or nothing. (The App is uninstalled first, by the caller.)
 */
export async function disconnectGitHub(userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(users).set({ githubUsername: null }).where(eq(users.id, userId));

    await tx.delete(githubInstallations).where(eq(githubInstallations.userId, userId));

    await tx
      .delete(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.provider, "github")));
  });
}
