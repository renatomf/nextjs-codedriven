import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  assertRateLimit: vi.fn(),
  createPremiumCheckout: vi.fn(),
  createBillingPortalSession: vi.fn(),
  syncCustomerSubscriptionsForUser: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/rate-limit", () => ({ assertRateLimit: mocks.assertRateLimit }));
vi.mock("@/modules/billing/server", () => ({
  createPremiumCheckout: mocks.createPremiumCheckout,
  createBillingPortalSession: mocks.createBillingPortalSession,
  syncCustomerSubscriptionsForUser: mocks.syncCustomerSubscriptionsForUser,
}));

import { openBillingPortal, refreshBillingFromStripe, startPremiumCheckout } from "./billing";

const USER_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  mocks.auth.mockReset().mockResolvedValue({ user: { id: USER_ID } });
  mocks.assertRateLimit.mockReset().mockResolvedValue(undefined);
  mocks.createPremiumCheckout.mockReset().mockResolvedValue({ url: "https://checkout.stripe.test/s" });
  mocks.createBillingPortalSession.mockReset().mockResolvedValue({ url: "https://billing.stripe.test/p" });
  mocks.syncCustomerSubscriptionsForUser.mockReset().mockResolvedValue(true);
});

describe("every billing action", () => {
  it.each([
    ["startPremiumCheckout", startPremiumCheckout],
    ["openBillingPortal", openBillingPortal],
    ["refreshBillingFromStripe", refreshBillingFromStripe],
  ] as const)("%s sends a signed-out visitor to login without calling Stripe", async (_, action) => {
    mocks.auth.mockResolvedValue(null);

    await expect(action()).rejects.toThrow("redirect:/login");
    expect(mocks.createPremiumCheckout).not.toHaveBeenCalled();
    expect(mocks.createBillingPortalSession).not.toHaveBeenCalled();
    expect(mocks.syncCustomerSubscriptionsForUser).not.toHaveBeenCalled();
  });

  it("is rate-limited per user before Stripe is called", async () => {
    mocks.assertRateLimit.mockRejectedValue(new Error("Too many billing requests. Try again later."));

    await expect(openBillingPortal()).rejects.toThrow(/Too many billing requests/);
    expect(mocks.assertRateLimit).toHaveBeenCalledWith(
      `billing:${USER_ID}`,
      20,
      60 * 60 * 1000,
      expect.any(String),
    );
    expect(mocks.createBillingPortalSession).not.toHaveBeenCalled();
  });
});

describe("startPremiumCheckout", () => {
  it("opens Stripe Checkout for the session's user", async () => {
    await expect(startPremiumCheckout()).rejects.toThrow("redirect:https://checkout.stripe.test/s");
    expect(mocks.createPremiumCheckout).toHaveBeenCalledWith(USER_ID);
  });

  it("never starts a second subscription", async () => {
    mocks.createPremiumCheckout.mockResolvedValue({ alreadySubscribed: true });

    await expect(startPremiumCheckout()).rejects.toThrow("redirect:/settings");
  });
});

describe("openBillingPortal", () => {
  it("returns the portal URL for the session's user", async () => {
    await expect(openBillingPortal()).resolves.toEqual({ url: "https://billing.stripe.test/p" });
    expect(mocks.createBillingPortalSession).toHaveBeenCalledWith(USER_ID);
  });

  it("asks a user without a Stripe customer to upgrade first", async () => {
    mocks.createBillingPortalSession.mockResolvedValue({ error: "no_customer" });

    const result = await openBillingPortal();

    expect(result).toHaveProperty("error");
    expect("error" in result && result.error).toMatch(/^No Stripe customer on file\. Upgrade to .+ first\.$/);
  });

  it("answers any other failure with a generic message", async () => {
    mocks.createBillingPortalSession.mockResolvedValue({ error: "stripe_failed" });

    await expect(openBillingPortal()).resolves.toEqual({
      error: "Could not open the billing portal. Try again.",
    });
  });
});

describe("refreshBillingFromStripe", () => {
  it("syncs the session's user and refreshes the pages that show the plan", async () => {
    await expect(refreshBillingFromStripe()).rejects.toThrow("redirect:/settings?billing=synced");
    expect(mocks.syncCustomerSubscriptionsForUser).toHaveBeenCalledWith(USER_ID);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/settings");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("says when the sync failed", async () => {
    mocks.syncCustomerSubscriptionsForUser.mockResolvedValue(false);

    await expect(refreshBillingFromStripe()).rejects.toThrow("redirect:/settings?billing=sync_failed");
  });
});
