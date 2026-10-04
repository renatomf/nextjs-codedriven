import { and, asc, eq, ne, notExists } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { githubInstallations } from "@/db/schema";
import { db } from "@/lib/db";

/**
 * GitHub App installations a user linked (ADR-007). Only ids: no token is
 * stored. Every function takes the session's `userId`, and the callback
 * links an installation only after GitHub confirmed, with the user's own
 * token, that the user can access it.
 */

export type GitHubInstallation = { installationId: number; accountLogin: string };

/** Links (or refreshes) an installation the user proved access to. */
export async function saveGitHubInstallation(
  userId: string,
  installation: GitHubInstallation,
): Promise<void> {
  await db
    .insert(githubInstallations)
    .values({ userId, ...installation })
    .onConflictDoUpdate({
      target: [githubInstallations.userId, githubInstallations.installationId],
      set: { accountLogin: installation.accountLogin },
    });
}

/** The user's installations, oldest first. */
export async function listGitHubInstallations(userId: string): Promise<GitHubInstallation[]> {
  return db
    .select({
      installationId: githubInstallations.installationId,
      accountLogin: githubInstallations.accountLogin,
    })
    .from(githubInstallations)
    .where(eq(githubInstallations.userId, userId))
    .orderBy(asc(githubInstallations.createdAt));
}

/** Drops one link (the App was uninstalled on GitHub). */
export async function forgetGitHubInstallation(userId: string, installationId: number): Promise<void> {
  await db
    .delete(githubInstallations)
    .where(
      and(
        eq(githubInstallations.userId, userId),
        eq(githubInstallations.installationId, installationId),
      ),
    );
}

/**
 * The installation that can read `owner`'s repositories, if the user linked
 * one. GitHub logins are case-insensitive.
 */
export function installationForOwner(
  installations: GitHubInstallation[],
  owner: string,
): GitHubInstallation | undefined {
  const wanted = owner.toLowerCase();
  return installations.find((i) => i.accountLogin.toLowerCase() === wanted);
}

/**
 * The user's installations no other user has linked: the ones the App may
 * be uninstalled from when this user leaves. An org installation shared with
 * another member stays installed for them.
 */
export async function installationsOnlyLinkedBy(userId: string): Promise<number[]> {
  const others = alias(githubInstallations, "others");
  const rows = await db
    .select({ installationId: githubInstallations.installationId })
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.userId, userId),
        notExists(
          db
            .select({ id: others.id })
            .from(others)
            .where(
              and(
                eq(others.installationId, githubInstallations.installationId),
                ne(others.userId, userId),
              ),
            ),
        ),
      ),
    );
  return rows.map((row) => row.installationId);
}
