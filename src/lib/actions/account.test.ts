import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  signOut: vi.fn(),
  assertRateLimit: vi.fn(),
  getAccountSettings: vi.fn(),
  deleteAccount: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth, signOut: mocks.signOut }));
vi.mock("@/lib/rate-limit", async () => {
  class RateLimitError extends Error {}
  return { assertRateLimit: mocks.assertRateLimit, RateLimitError };
});
vi.mock("@/modules/identity/server", () => ({ getAccountSettings: mocks.getAccountSettings }));
vi.mock("@/lib/account-deletion", () => ({ deleteAccount: mocks.deleteAccount }));
vi.mock("@/shared/logger", () => ({ logger: { error: vi.fn() } }));

import { deleteAccountAction } from "./account";

const USER_ID = "11111111-1111-4111-8111-111111111111";

function form(confirmation: string, extra: Record<string, string> = {}) {
  const data = new FormData();
  data.set("confirmation", confirmation);
  for (const [key, value] of Object.entries(extra)) data.set(key, value);
  return data;
}

beforeEach(() => {
  mocks.auth.mockReset().mockResolvedValue({ user: { id: USER_ID } });
  mocks.signOut.mockReset().mockResolvedValue(undefined);
  mocks.assertRateLimit.mockReset().mockResolvedValue(undefined);
  mocks.getAccountSettings.mockReset().mockResolvedValue({ email: "Ana@Example.com" });
  mocks.deleteAccount.mockReset().mockResolvedValue(true);
});

describe("deleteAccountAction", () => {
  it("deletes the session's account when the typed email matches (case and spaces ignored)", async () => {
    await deleteAccountAction({}, form("  ana@example.COM "));

    expect(mocks.deleteAccount).toHaveBeenCalledWith(USER_ID);
    expect(mocks.signOut).toHaveBeenCalledWith({ redirectTo: "/" });
  });

  it("refuses a wrong email without deleting anything", async () => {
    const state = await deleteAccountAction({}, form("someone@else.com"));

    expect(state.error).toMatch(/Type your account email/);
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
  });

  it("never takes the account from the form", async () => {
    await deleteAccountAction({}, form("ana@example.com", { userId: "22222222-2222-4222-8222-222222222222" }));

    expect(mocks.deleteAccount).toHaveBeenCalledWith(USER_ID);
  });

  it("sends a signed-out visitor to login", async () => {
    mocks.auth.mockResolvedValue(null);

    await expect(deleteAccountAction({}, form("ana@example.com"))).rejects.toThrow("redirect:/login");
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
  });

  it("answers a generic error and keeps the session when the deletion fails", async () => {
    mocks.deleteAccount.mockRejectedValue(new Error("stripe: sk_live_secret detail"));

    const state = await deleteAccountAction({}, form("ana@example.com"));

    expect(state.error).toBe("Could not delete your account. Please try again.");
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
});
