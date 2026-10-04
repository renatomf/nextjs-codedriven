"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { deleteAccount } from "@/lib/account-deletion";
import { auth, signOut } from "@/lib/auth";
import { assertRateLimit, RateLimitError } from "@/lib/rate-limit";
import { getAccountSettings } from "@/modules/identity/server";
import { logger } from "@/shared/logger";

export type DeleteAccountState = { error?: string };

// Each attempt may call Stripe: a few per hour is plenty for a human.
const DELETE_ACCOUNT_MAX_PER_HOUR = 5;

const confirmationSchema = z.string().trim().min(1).max(320);

/**
 * Deletes the signed-in user's account (roadmap Phase 6, LGPD). The user
 * types their email to confirm; it is compared on the server with the
 * account's own email, never trusted from the client. The account to
 * delete is always the session's.
 */
export async function deleteAccountAction(
  _prev: DeleteAccountState,
  formData: FormData,
): Promise<DeleteAccountState> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  try {
    await assertRateLimit(
      `account-delete:${userId}`,
      DELETE_ACCOUNT_MAX_PER_HOUR,
      60 * 60 * 1000,
      "Too many attempts. Try again later.",
    );
  } catch (error) {
    if (error instanceof RateLimitError) return { error: error.message };
    throw error;
  }

  const account = await getAccountSettings(userId);
  const typed = confirmationSchema.safeParse(formData.get("confirmation"));
  if (
    !account?.email ||
    !typed.success ||
    typed.data.toLowerCase() !== account.email.toLowerCase()
  ) {
    return { error: "Type your account email exactly to confirm." };
  }

  try {
    await deleteAccount(userId);
  } catch (error) {
    logger.error("account.delete_failed", { err: error, userId });
    // Every step can run again (a deleted Stripe customer counts as done).
    return { error: "Could not delete your account. Please try again." };
  }

  // Ends this browser's session (the JWT cookie) and leaves the app.
  await signOut({ redirectTo: "/" });
  return {};
}
