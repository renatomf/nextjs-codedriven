import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signIn: vi.fn(),
  signOut: vi.fn(),
  assertRateLimit: vi.fn(),
  createEmailAccount: vi.fn(),
  forwardedFor: null as string | null,
}));

vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(mocks.forwardedFor ? { "x-forwarded-for": mocks.forwardedFor } : {}),
}));
vi.mock("@/lib/auth", () => ({ signIn: mocks.signIn, signOut: mocks.signOut }));
vi.mock("@/lib/rate-limit", () => {
  class RateLimitError extends Error {}
  return { assertRateLimit: mocks.assertRateLimit, RateLimitError };
});
vi.mock("@/modules/identity/server", () => ({ createEmailAccount: mocks.createEmailAccount }));

import { AuthError } from "next-auth";

import { RateLimitError } from "@/lib/rate-limit";

import { loginWithEmail, registerWithEmail } from "./auth";

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const LOGIN = { email: " Ana@Example.com ", password: "correct horse" };
const REGISTER = { firstName: "Ana", lastName: "Lima", ...LOGIN };

beforeEach(() => {
  mocks.forwardedFor = "203.0.113.7, 10.0.0.1";
  mocks.signIn.mockReset().mockResolvedValue(undefined);
  mocks.assertRateLimit.mockReset().mockResolvedValue(undefined);
  mocks.createEmailAccount.mockReset().mockResolvedValue(true);
});

describe("loginWithEmail", () => {
  it("signs in with the normalized email", async () => {
    await expect(loginWithEmail({}, form(LOGIN))).resolves.toEqual({ success: true });
    expect(mocks.signIn).toHaveBeenCalledWith("credentials", {
      email: "ana@example.com",
      password: "correct horse",
      redirectTo: "/dashboard",
    });
  });

  it("rejects invalid input before any lookup", async () => {
    const state = await loginWithEmail({}, form({ email: "not-an-email", password: "short" }));

    expect(state).toEqual({ error: "Invalid email or password." });
    expect(mocks.assertRateLimit).not.toHaveBeenCalled();
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it("gives the same message for a wrong password as for a bad email", async () => {
    mocks.signIn.mockRejectedValue(new AuthError("CredentialsSignin"));

    await expect(loginWithEmail({}, form(LOGIN))).resolves.toEqual({
      error: "Invalid email or password.",
    });
  });

  it("lets Next.js redirects through", async () => {
    mocks.signIn.mockRejectedValue(new Error("NEXT_REDIRECT"));

    await expect(loginWithEmail({}, form(LOGIN))).rejects.toThrow("NEXT_REDIRECT");
  });

  it("limits attempts per IP + email and per IP (the first forwarded address)", async () => {
    await loginWithEmail({}, form(LOGIN));

    expect(mocks.assertRateLimit).toHaveBeenCalledWith(
      "login:203.0.113.7:ana@example.com",
      10,
      15 * 60 * 1000,
      expect.any(String),
    );
    expect(mocks.assertRateLimit).toHaveBeenCalledWith(
      "login:203.0.113.7",
      50,
      15 * 60 * 1000,
      expect.any(String),
    );
  });

  it("skips the per-IP bucket without an IP, so unknown clients don't share one", async () => {
    mocks.forwardedFor = null;

    await loginWithEmail({}, form(LOGIN));

    expect(mocks.assertRateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.assertRateLimit).toHaveBeenCalledWith(
      "login:unknown:ana@example.com",
      10,
      15 * 60 * 1000,
      expect.any(String),
    );
  });

  it("stops at the limit without trying the password", async () => {
    mocks.assertRateLimit.mockRejectedValue(new RateLimitError("Too many attempts."));

    await expect(loginWithEmail({}, form(LOGIN))).resolves.toEqual({
      error: "Too many attempts. Please try again later.",
    });
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it("does not hide a rate-limit store failure as a limit", async () => {
    mocks.assertRateLimit.mockRejectedValue(new Error("db down"));

    await expect(loginWithEmail({}, form(LOGIN))).rejects.toThrow("db down");
    expect(mocks.signIn).not.toHaveBeenCalled();
  });
});

describe("registerWithEmail", () => {
  it("creates the account and signs in", async () => {
    await expect(registerWithEmail({}, form(REGISTER))).resolves.toEqual({ success: true });
    expect(mocks.createEmailAccount).toHaveBeenCalledWith({
      name: "Ana Lima",
      email: "ana@example.com",
      password: "correct horse",
    });
    expect(mocks.signIn).toHaveBeenCalledWith("credentials", {
      email: "ana@example.com",
      password: "correct horse",
      redirectTo: "/dashboard",
    });
  });

  it("rejects invalid input without creating anything", async () => {
    const state = await registerWithEmail({}, form({ ...REGISTER, password: "short" }));

    expect(state).toEqual({ error: "Please check the form fields and try again." });
    expect(mocks.createEmailAccount).not.toHaveBeenCalled();
  });

  it("rejects a password over bcrypt's 72 bytes", async () => {
    const state = await registerWithEmail({}, form({ ...REGISTER, password: "é".repeat(37) }));

    expect(state.error).toBeDefined();
    expect(mocks.createEmailAccount).not.toHaveBeenCalled();
  });

  it("stops at the limit without creating anything", async () => {
    mocks.assertRateLimit.mockRejectedValue(new RateLimitError("Too many attempts."));

    await expect(registerWithEmail({}, form(REGISTER))).resolves.toEqual({
      error: "Too many attempts. Please try again later.",
    });
    expect(mocks.createEmailAccount).not.toHaveBeenCalled();
  });

  it("does not say whether the email is taken, and does not sign in", async () => {
    mocks.createEmailAccount.mockResolvedValue(false);

    const state = await registerWithEmail({}, form(REGISTER));

    expect(state.error).toBe("Unable to create an account with this email. Try signing in instead.");
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it("reports a sign-in failure after the account was created", async () => {
    mocks.signIn.mockRejectedValue(new AuthError("CredentialsSignin"));

    await expect(registerWithEmail({}, form(REGISTER))).resolves.toEqual({
      error: "Account created, but sign-in failed. Please try signing in.",
    });
  });
});
