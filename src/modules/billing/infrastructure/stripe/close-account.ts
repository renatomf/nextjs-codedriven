import { eq } from "drizzle-orm";
import Stripe from "stripe";

import { users } from "@/db/schema";
import { db } from "@/lib/db";

import { getStripe } from "./client";

/**
 * Account deletion (roadmap Phase 6, LGPD): deletes the user's Stripe
 * customer, which cancels its subscriptions at once (no more charges) and
 * removes its payment methods. Stripe keeps its own payment records.
 * Idempotent: a customer already deleted counts as done. Any other failure
 * throws, so the caller deletes nothing and the user can retry.
 */
export async function closeBillingAccount(userId: string): Promise<void> {
  const [user] = await db
    .select({ customerId: users.stripeCustomerId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user?.customerId) return;

  try {
    await getStripe().customers.del(user.customerId);
  } catch (error) {
    if (error instanceof Stripe.errors.StripeInvalidRequestError && error.code === "resource_missing") {
      return;
    }
    throw error;
  }
}
