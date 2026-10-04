import { createVerify, generateKeyPairSync } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { GitHubError } from "@/lib/github";
import {
  appJwt,
  GitHubInstallationGoneError,
  installationsOfUser,
  listInstallationRepos,
  mintInstallationToken,
  uninstallInstallation,
} from "@/lib/github-app";

// GitHub App client (ADR-007) against a fake GitHub (fetch stubbed). The key
// pair is real, so the JWT signature is checked with the public key.

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubEnv("GITHUB_APP_ID", "12345");
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv-test");
  vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "client-secret");
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", privateKey);
  vi.stubEnv("GITHUB_APP_SLUG", "codedriven-test");
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function decode(part: string) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

describe("appJwt", () => {
  it("is RS256, issued by the App, short-lived and signed with its key", () => {
    const now = Date.UTC(2026, 9, 4, 12, 0, 0);
    const [header, payload, signature] = appJwt({ appId: "12345", privateKey }, now).split(".");

    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = decode(payload);
    expect(claims.iss).toBe("12345");
    expect(claims.iat).toBe(now / 1000 - 60);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600); // GitHub's maximum

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });
});

describe("mintInstallationToken", () => {
  it("asks for a read-only token limited to the repository", async () => {
    fetchMock.mockResolvedValue(json(201, { token: "ghs_test", expires_at: "x" }));

    expect(await mintInstallationToken(42, { repository: "demo" })).toBe("ghs_test");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.github.com/app/installations/42/access_tokens");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      repositories: ["demo"],
      permissions: { contents: "read", metadata: "read" },
    });
    expect(init.headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("reports an uninstalled App", async () => {
    fetchMock.mockResolvedValue(json(404, { message: "Not Found" }));

    await expect(mintInstallationToken(42)).rejects.toBeInstanceOf(GitHubInstallationGoneError);
  });

  it("explains a repository the installation cannot read", async () => {
    fetchMock.mockResolvedValue(json(422, { message: "There is at least one repository that does not exist" }));

    await expect(mintInstallationToken(42, { repository: "other" })).rejects.toThrow(
      /Add it to the codedriven installation/,
    );
  });

  it("never passes GitHub's error body to the user", async () => {
    fetchMock.mockResolvedValue(json(500, { message: "internal details" }));

    const error = await mintInstallationToken(42).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as Error).message).not.toContain("internal");
  });
});

describe("listInstallationRepos", () => {
  it("lists the chosen repositories with a fresh installation token", async () => {
    const repo = {
      id: 1,
      full_name: "octo/demo",
      name: "demo",
      private: true,
      html_url: "https://github.com/octo/demo",
      default_branch: "main",
      pushed_at: null,
      size: 10,
    };
    fetchMock
      .mockResolvedValueOnce(json(201, { token: "ghs_list" }))
      .mockResolvedValueOnce(json(200, { total_count: 1, repositories: [repo] }));

    expect(await listInstallationRepos(42)).toEqual([repo]);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toContain("/installation/repositories");
    expect(init.headers.Authorization).toBe("Bearer ghs_list");
  });
});

describe("installationsOfUser", () => {
  it("exchanges the code with the App's credentials and lists the user's installations", async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { access_token: "ghu_user" }))
      .mockResolvedValueOnce(
        json(200, { installations: [{ id: 7, account: { login: "Octo" } }] }),
      );

    expect(await installationsOfUser("the-code")).toEqual([{ id: 7, accountLogin: "Octo" }]);

    const exchange = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(exchange).toEqual({ client_id: "Iv-test", client_secret: "client-secret", code: "the-code" });
    expect(fetchMock.mock.calls[1][0]).toContain("/user/installations");
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer ghu_user");
  });

  it("fails when GitHub returns no user token (bad or reused code)", async () => {
    fetchMock.mockResolvedValue(json(200, { error: "bad_verification_code" }));

    await expect(installationsOfUser("reused")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("uninstallInstallation", () => {
  it("asks GitHub, as the App, to remove the installation", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await uninstallInstallation(42);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.github.com/app/installations/42");
    expect(init.method).toBe("DELETE");
    expect(init.headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("treats an installation already gone as done", async () => {
    fetchMock.mockResolvedValue(json(404, { message: "Not Found" }));

    await expect(uninstallInstallation(42)).resolves.toBeUndefined();
  });

  it("fails on any other refusal (the caller logs it)", async () => {
    fetchMock.mockResolvedValue(json(500, { message: "boom" }));

    await expect(uninstallInstallation(42)).rejects.toThrow(/HTTP 500/);
  });
});
