import { eq } from "drizzle-orm";

import { users, verificationTokens } from "@/db/schema";
import { db } from "@/lib/db";

/**
 * Deletes the account's rows (roadmap Phase 6, LGPD). The user row goes and
 * everything owned by it follows by ON DELETE CASCADE: login accounts,
 * sessions, projects (files, chunks, vectors, reports, share links), usage
 * and LLM call records. Verification tokens have no foreign key but hold
 * the email: deleted here, in the same transaction. Rate-limit rows store
 * only a SHA-256 of their key, never the id or the email. False when there
 * is no such user.
 */
export async function deleteAccountData(userId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!user) return false;

    if (user.email) {
      await tx.delete(verificationTokens).where(eq(verificationTokens.identifier, user.email));
    }
    await tx.delete(users).where(eq(users.id, userId));
    return true;
  });
}
