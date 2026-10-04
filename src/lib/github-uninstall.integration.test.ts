import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createUser, deleteUsers } from "@/test/integration/factories";

// Leaving GitHub (ADR-007), on a real Postgres: disconnecting or deleting the
// account removes the App only from the installations no other user linked,
// and a GitHub failure never blocks either. GitHub, the session and Next's
// cache are faked.

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  config: vi.fn(),
  uninstall: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/github-app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github-app")>()),
  githubAppConfig: mocks.config,
  uninstallInstallation: mocks.uninstall,
}));
vi.mock("@/lib/storage/neon-storage", () => ({
  storageConfig: () => null,
  staleObjects: vi.fn(),
  deleteObject: vi.fn(),
}));

import { deleteAccount } from "@/lib/account-deletion";
import { disconnectGitHub } from "@/lib/actions/github";
import {
  installationsOnlyLinkedBy,
  listGitHubInstallations,
  saveGitHubInstallation,
} from "@/modules/identity/server";

const created: string[] = [];

afterAll(async () => {
  await deleteUsers(created);
});

beforeEach(() => {
  mocks.auth.mockReset();
  mocks.config.mockReset().mockReturnValue({ slug: "codedriven-test" });
  mocks.uninstall.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

let nextId = 8_000_000;

/** A user with one installation of their own and one shared with a teammate. */
async function userWithInstallations() {
  const userId = await createUser();
  const teammate = await createUser();
  created.push(userId, teammate);
  const own = (nextId += 1);
  const shared = (nextId += 1);
  await saveGitHubInstallation(userId, { installationId: own, accountLogin: "me" });
  await saveGitHubInstallation(userId, { installationId: shared, accountLogin: "org" });
  await saveGitHubInstallation(teammate, { installationId: shared, accountLogin: "org" });
  return { userId, teammate, own, shared };
}

describe("installationsOnlyLinkedBy", () => {
  it("lists the user's installations nobody else linked", async () => {
    const { userId, teammate, own, shared } = await userWithInstallations();

    expect(await installationsOnlyLinkedBy(userId)).toEqual([own]);
    expect(await installationsOnlyLinkedBy(teammate)).toEqual([]);
    expect(shared).toBeGreaterThan(own);
  });
});

describe("disconnectGitHub", () => {
  it("uninstalls only the user's own installation, then forgets every link of theirs", async () => {
    const { userId, teammate, own, shared } = await userWithInstallations();
    mocks.auth.mockResolvedValue({ user: { id: userId } });

    await disconnectGitHub();

    expect(mocks.uninstall).toHaveBeenCalledTimes(1);
    expect(mocks.uninstall).toHaveBeenCalledWith(own);
    expect(await listGitHubInstallations(userId)).toEqual([]);
    // The teammate keeps using the org installation.
    expect(await listGitHubInstallations(teammate)).toEqual([{ installationId: shared, accountLogin: "org" }]);
  });

  it("still disconnects when GitHub refuses the uninstall", async () => {
    const { userId } = await userWithInstallations();
    mocks.auth.mockResolvedValue({ user: { id: userId } });
    mocks.uninstall.mockRejectedValue(new Error("GitHub refused (HTTP 500)"));

    await disconnectGitHub();

    expect(await listGitHubInstallations(userId)).toEqual([]);
  });

  it("calls GitHub for nothing when the App is not configured", async () => {
    const { userId } = await userWithInstallations();
    mocks.auth.mockResolvedValue({ user: { id: userId } });
    mocks.config.mockReturnValue(null);

    await disconnectGitHub();

    expect(mocks.uninstall).not.toHaveBeenCalled();
    expect(await listGitHubInstallations(userId)).toEqual([]);
  });
});

describe("deleteAccount", () => {
  it("uninstalls the user's own installation and keeps the shared one for the teammate", async () => {
    const { userId, teammate, own, shared } = await userWithInstallations();

    expect(await deleteAccount(userId)).toBe(true);

    expect(mocks.uninstall).toHaveBeenCalledWith(own);
    expect(mocks.uninstall).not.toHaveBeenCalledWith(shared);
    expect(await listGitHubInstallations(teammate)).toEqual([{ installationId: shared, accountLogin: "org" }]);
  });

  it("still deletes the account when GitHub refuses the uninstall", async () => {
    const { userId } = await userWithInstallations();
    mocks.uninstall.mockRejectedValue(new Error("GitHub refused (HTTP 500)"));

    expect(await deleteAccount(userId)).toBe(true);
    expect(await listGitHubInstallations(userId)).toEqual([]);
  });
});
