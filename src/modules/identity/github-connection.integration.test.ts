import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { accounts, users } from "@/db/schema";
import { db } from "@/lib/db";
import {
  disconnectGitHub,
  forgetGitHubInstallation,
  getAccountSettings,
  listGitHubInstallations,
  saveGitHubInstallation,
} from "@/modules/identity/server";
import { createUser, deleteUsers } from "@/test/integration/factories";

// The GitHub connection on a real Postgres (ADR-007: App installations, no
// token): pages only ever see a boolean, disconnecting forgets the links and
// the GitHub sign-in together, and nothing reaches another user's row.

const created: string[] = [];
let alice: string;
let bob: string;

beforeAll(async () => {
  alice = await createUser();
  bob = await createUser();
  created.push(alice, bob);
});

afterAll(async () => {
  await deleteUsers(created);
});

async function linkAccount(userId: string, provider: string) {
  await db
    .insert(accounts)
    .values({ userId, type: "oauth", provider, providerAccountId: randomUUID() });
}

const providersOf = async (userId: string) =>
  (await db.select({ provider: accounts.provider }).from(accounts).where(eq(accounts.userId, userId)))
    .map((row) => row.provider)
    .sort();

describe("GitHub connection", () => {
  it("gives the settings page a boolean, never an installation id", async () => {
    await saveGitHubInstallation(alice, { installationId: 9_100_001, accountLogin: "alice-gh" });

    const settings = await getAccountSettings(alice);

    expect(settings).toMatchObject({ githubConnected: true });
    expect(JSON.stringify(settings)).not.toContain("9100001");
    expect((await getAccountSettings(bob))?.githubConnected).toBe(false);
  });

  it("disconnects: forgets the App links, the username and the GitHub sign-in, keeps other sign-ins", async () => {
    await saveGitHubInstallation(alice, { installationId: 9_100_002, accountLogin: "alice-gh" });
    await db.update(users).set({ githubUsername: "alice-gh" }).where(eq(users.id, alice));
    await linkAccount(alice, "github");
    await linkAccount(alice, "google");
    await saveGitHubInstallation(bob, { installationId: 9_100_003, accountLogin: "bob-gh" });
    await linkAccount(bob, "github");

    await disconnectGitHub(alice);

    expect(await listGitHubInstallations(alice)).toEqual([]);
    expect((await getAccountSettings(alice))?.githubUsername).toBeNull();
    expect(await providersOf(alice)).toEqual(["google"]);
    // Bob is untouched.
    expect(await listGitHubInstallations(bob)).toEqual([{ installationId: 9_100_003, accountLogin: "bob-gh" }]);
    expect(await providersOf(bob)).toEqual(["github"]);
  });

  it("reports an unknown user", async () => {
    expect(await getAccountSettings(randomUUID())).toBeUndefined();
  });

  describe("GitHub App installations (ADR-007)", () => {
    it("links an installation once, refreshing the account name, for that user only", async () => {
      const carol = await createUser();
      const dave = await createUser();
      created.push(carol, dave);

      await saveGitHubInstallation(carol, { installationId: 101, accountLogin: "old-name" });
      await saveGitHubInstallation(carol, { installationId: 101, accountLogin: "carol-gh" });
      await saveGitHubInstallation(dave, { installationId: 202, accountLogin: "dave-gh" });

      expect(await listGitHubInstallations(carol)).toEqual([{ installationId: 101, accountLogin: "carol-gh" }]);
      expect(await listGitHubInstallations(dave)).toEqual([{ installationId: 202, accountLogin: "dave-gh" }]);
    });

    it("forgets only the user's own link", async () => {
      const erin = await createUser();
      const frank = await createUser();
      created.push(erin, frank);
      // An org installation shared by two members.
      await saveGitHubInstallation(erin, { installationId: 303, accountLogin: "org" });
      await saveGitHubInstallation(frank, { installationId: 303, accountLogin: "org" });

      await forgetGitHubInstallation(erin, 303);

      expect(await listGitHubInstallations(erin)).toEqual([]);
      expect(await listGitHubInstallations(frank)).toEqual([{ installationId: 303, accountLogin: "org" }]);
    });

    it("counts as connected in settings, without a token", async () => {
      const gina = await createUser();
      created.push(gina);
      expect((await getAccountSettings(gina))?.githubConnected).toBe(false);

      await saveGitHubInstallation(gina, { installationId: 404, accountLogin: "gina-gh" });

      expect((await getAccountSettings(gina))?.githubConnected).toBe(true);
    });

    it("disconnecting drops the user's installation links too", async () => {
      const hank = await createUser();
      created.push(hank);
      await saveGitHubInstallation(hank, { installationId: 505, accountLogin: "hank-gh" });

      await disconnectGitHub(hank);

      expect(await listGitHubInstallations(hank)).toEqual([]);
      expect((await getAccountSettings(hank))?.githubConnected).toBe(false);
    });
  });
});
