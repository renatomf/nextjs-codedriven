import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// GitHub App callback (ADR-007): the installation id comes in the URL and
// can be forged, so it is linked only when GitHub lists it among the user's
// own installations. State, session and GitHub are mocked.

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  verifyState: vi.fn(),
  installationsOfUser: vi.fn(),
  saveGitHubInstallation: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/github", () => ({
  getAppUrl: () => "https://app.test",
  GITHUB_OAUTH_NONCE_COOKIE: "github_oauth_nonce",
  verifyGitHubOAuthState: mocks.verifyState,
}));
vi.mock("@/lib/github-app", () => ({ installationsOfUser: mocks.installationsOfUser }));
vi.mock("@/modules/identity/server", () => ({ saveGitHubInstallation: mocks.saveGitHubInstallation }));
vi.mock("@/shared/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
  requestIdFrom: () => "req",
}));

import { GET } from "./route";

const USER = "11111111-1111-4111-8111-111111111111";

function callback(query: Record<string, string>) {
  const url = new URL("https://app.test/api/github/app/callback");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return new NextRequest(url, { headers: { cookie: "github_oauth_nonce=nonce-1" } });
}

const valid = { code: "the-code", state: "signed-state", installation_id: "777" };

function outcome(response: Response) {
  const location = new URL(response.headers.get("location")!);
  return location.searchParams.get("github") ?? location.searchParams.get("github_error");
}

beforeEach(() => {
  mocks.auth.mockReset().mockResolvedValue({ user: { id: USER } });
  mocks.verifyState.mockReset().mockReturnValue(true);
  mocks.installationsOfUser.mockReset().mockResolvedValue([{ id: 777, accountLogin: "octo" }]);
  mocks.saveGitHubInstallation.mockReset().mockResolvedValue(undefined);
});

describe("GitHub App callback", () => {
  it("links the installation GitHub confirms is the user's, with GitHub's account name", async () => {
    const response = await GET(callback(valid));

    expect(outcome(response)).toBe("connected");
    expect(mocks.saveGitHubInstallation).toHaveBeenCalledWith(USER, {
      installationId: 777,
      accountLogin: "octo",
    });
  });

  it("refuses an installation id the user cannot access (forged in the URL)", async () => {
    const response = await GET(callback({ ...valid, installation_id: "999" }));

    expect(outcome(response)).toBe("installation_not_yours");
    expect(mocks.saveGitHubInstallation).not.toHaveBeenCalled();
  });

  it("refuses a bad state before calling GitHub", async () => {
    mocks.verifyState.mockReturnValue(false);

    const response = await GET(callback(valid));

    expect(outcome(response)).toBe("invalid_state");
    expect(mocks.installationsOfUser).not.toHaveBeenCalled();
    expect(mocks.saveGitHubInstallation).not.toHaveBeenCalled();
  });

  it("checks the state against the session user and this browser's nonce", async () => {
    await GET(callback(valid));

    expect(mocks.verifyState).toHaveBeenCalledWith("signed-state", {
      sessionUserId: USER,
      nonce: "nonce-1",
    });
  });

  it("drops the single-use nonce cookie", async () => {
    const response = await GET(callback(valid));

    expect(response.headers.get("set-cookie")).toMatch(/github_oauth_nonce=;/);
  });

  it("sends a signed-out visitor to sign in, linking nothing", async () => {
    mocks.auth.mockResolvedValue(null);

    const response = await GET(callback(valid));

    expect(response.headers.get("location")).toBe("https://app.test/login");
    expect(mocks.saveGitHubInstallation).not.toHaveBeenCalled();
  });

  it("tells the user an org admin must approve first", async () => {
    const response = await GET(callback({ setup_action: "request", state: "signed-state" }));

    expect(outcome(response)).toBe("approval_requested");
    expect(mocks.saveGitHubInstallation).not.toHaveBeenCalled();
  });

  it("answers a generic error when GitHub fails, never its details", async () => {
    mocks.installationsOfUser.mockRejectedValue(new Error("bad_verification_code secret-detail"));

    const response = await GET(callback(valid));

    expect(outcome(response)).toBe("exchange_failed");
    expect(response.headers.get("location")).not.toContain("secret-detail");
  });

  it("rejects a malformed installation id", async () => {
    const response = await GET(callback({ ...valid, installation_id: "1;drop" }));

    expect(outcome(response)).toBe("missing_code");
    expect(mocks.installationsOfUser).not.toHaveBeenCalled();
  });
});
