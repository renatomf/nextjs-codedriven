import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (params: Record<string, unknown>) => Promise<unknown>;

/** The part of the NextAuth config these tests call. */
type CapturedConfig = {
  adapter: { linkAccount: Handler };
  session: unknown;
  providers: Array<{ id?: string; authorize?: Handler }>;
  callbacks: { signIn: Handler };
  events: { linkAccount: Handler; signIn: Handler };
};

const mocks = vi.hoisted(() => ({
  config: undefined as unknown as CapturedConfig,
  linkAccount: vi.fn(),
  verifyCredentials: vi.fn(),
  dropUnverifiedPassword: vi.fn(),
  recordSignIn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next-auth", () => ({
  default: (config: Record<string, unknown>) => {
    mocks.config = config as unknown as CapturedConfig;
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
}));
vi.mock("next-auth/providers/credentials", () => ({
  default: (options: Record<string, unknown>) => ({ id: "credentials", ...options }),
}));
vi.mock("@auth/drizzle-adapter", () => ({
  DrizzleAdapter: () => ({ createUser: vi.fn(), linkAccount: mocks.linkAccount }),
}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/db/schema", () => ({ accounts: {}, sessions: {}, users: {}, verificationTokens: {} }));
vi.mock("@/modules/identity/server", () => ({
  verifyCredentials: mocks.verifyCredentials,
  dropUnverifiedPassword: mocks.dropUnverifiedPassword,
  recordSignIn: mocks.recordSignIn,
}));
vi.mock("@/shared/logger", () => ({ logger: { error: mocks.loggerError } }));

import "./auth";

const USER = { id: "u1", email: "Ana@Example.com" };
const fetchMock = vi.fn();

function github(accessToken: string | undefined = "gho_token") {
  return { provider: "github", type: "oauth", providerAccountId: "1", access_token: accessToken };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

const signInCallback = (params: Record<string, unknown>) => mocks.config.callbacks.signIn(params);
const credentials = () =>
  mocks.config.providers.find((provider) => provider.id === "credentials")!.authorize!;

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  mocks.recordSignIn.mockReset().mockResolvedValue(undefined);
  mocks.dropUnverifiedPassword.mockReset().mockResolvedValue(undefined);
  mocks.verifyCredentials.mockReset();
  mocks.linkAccount.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the adapter", () => {
  it("never stores OAuth tokens when it links an account", async () => {
    await mocks.config.adapter.linkAccount({
      userId: "u1",
      provider: "github",
      type: "oauth",
      providerAccountId: "1",
      access_token: "gho_secret",
      refresh_token: "ghr_secret",
      id_token: "id_secret",
      scope: "read:user",
    });

    expect(mocks.linkAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        provider: "github",
        access_token: undefined,
        refresh_token: undefined,
        id_token: undefined,
      }),
    );
  });

  it("uses JWT sessions", () => {
    expect(mocks.config.session).toEqual({ strategy: "jwt" });
  });
});

describe("credentials sign-in", () => {
  it("checks the normalized email and the password", async () => {
    mocks.verifyCredentials.mockResolvedValue({ id: "u1" });

    await expect(
      credentials()({ email: " Ana@Example.com ", password: "correct horse" }),
    ).resolves.toEqual({ id: "u1" });
    expect(mocks.verifyCredentials).toHaveBeenCalledWith("ana@example.com", "correct horse");
  });

  it("refuses invalid input without a lookup", async () => {
    await expect(credentials()({ email: "x", password: "y" })).resolves.toBeNull();
    expect(mocks.verifyCredentials).not.toHaveBeenCalled();
  });
});

describe("signIn callback: links by email only when the provider verified it", () => {
  it("lets credentials through (the password was checked by authorize)", async () => {
    await expect(
      signInCallback({ user: USER, account: { provider: "credentials", type: "credentials" } }),
    ).resolves.toBe(true);
  });

  it("refuses an OAuth user without an email", async () => {
    await expect(
      signInCallback({ user: { id: "u1" }, account: github(), profile: {} }),
    ).resolves.toBe(false);
  });

  it("trusts Google only for a verified email", async () => {
    const account = { provider: "google", type: "oidc", providerAccountId: "g" };

    await expect(
      signInCallback({ user: USER, account, profile: { email_verified: true } }),
    ).resolves.toBe(true);
    await expect(
      signInCallback({ user: USER, account, profile: { email_verified: false } }),
    ).resolves.toBe(false);
    await expect(signInCallback({ user: USER, account, profile: {} })).resolves.toBe(false);
  });

  it("trusts GitHub only when the user's verified emails include this one", async () => {
    fetchMock.mockResolvedValue(
      json([
        { email: "other@example.com", verified: true },
        { email: "ana@example.com", verified: true },
      ]),
    );

    await expect(signInCallback({ user: USER, account: github() })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/user/emails",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("refuses a GitHub email that is there but not verified", async () => {
    fetchMock.mockResolvedValue(json([{ email: "ana@example.com", verified: false }]));

    await expect(signInCallback({ user: USER, account: github() })).resolves.toBe(false);
  });

  it("refuses GitHub without a token, on an error answer, or when GitHub fails", async () => {
    await expect(signInCallback({ user: USER, account: github(undefined) })).resolves.toBe(false);

    fetchMock.mockResolvedValue(json({ message: "Bad credentials" }, 401));
    await expect(signInCallback({ user: USER, account: github() })).resolves.toBe(false);

    fetchMock.mockRejectedValue(new Error("timeout"));
    await expect(signInCallback({ user: USER, account: github() })).resolves.toBe(false);
    expect(mocks.loggerError).toHaveBeenCalledWith("auth.github_email_check_failed", expect.anything());
  });

  it("refuses an unknown provider", async () => {
    await expect(
      signInCallback({ user: USER, account: { provider: "gitlab", type: "oauth", providerAccountId: "1" } }),
    ).resolves.toBe(false);
  });
});

describe("events", () => {
  it("drops an unverified password when an OAuth provider proves the email", async () => {
    await mocks.config.events.linkAccount({ user: { id: "u1" } });

    expect(mocks.dropUnverifiedPassword).toHaveBeenCalledWith("u1");
  });

  it("records a GitHub sign-in with the username, without keeping the token", async () => {
    fetchMock.mockResolvedValue(json({ login: "ana-dev" }));

    await mocks.config.events.signIn({
      user: { id: "u1" },
      account: github(),
      profile: { avatar_url: "https://github.test/a.png" },
    });

    expect(mocks.recordSignIn).toHaveBeenCalledWith("u1", {
      provider: "github",
      image: "https://github.test/a.png",
      githubUsername: "ana-dev",
    });
    expect(JSON.stringify(mocks.recordSignIn.mock.calls)).not.toContain("gho_token");
  });

  it("still records the sign-in when the GitHub profile fails", async () => {
    fetchMock.mockRejectedValue(new Error("timeout"));

    await mocks.config.events.signIn({ user: { id: "u1" }, account: github(), profile: {} });

    expect(mocks.recordSignIn).toHaveBeenCalledWith("u1", {
      provider: "github",
      image: undefined,
      githubUsername: undefined,
    });
  });

  it("records other sign-ins without calling GitHub", async () => {
    await mocks.config.events.signIn({
      user: { id: "u1" },
      account: { provider: "credentials", type: "credentials" },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.recordSignIn).toHaveBeenCalledWith("u1", { provider: "credentials", image: undefined });
  });
});
