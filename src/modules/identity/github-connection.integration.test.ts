import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { accounts, users } from "@/db/schema";
import { db } from "@/lib/db";
import {
  disconnectGitHub,
  forgetGitHubInstallation,
  getAccountSettings,
  getGitHubConnection,
  listGitHubInstallations,
  saveGitHubConnection,
  saveGitHubInstallation,
} from "@/modules/identity/server";
import { createUser, deleteUsers } from "@/test/integration/factories";

// The GitHub connection on a real Postgres: pages only ever see a boolean,
// disconnecting forgets the token and the GitHub sign-in link together, and
// nothing reaches another user's row.

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
  it("stores the encrypted token and login for the session's user only", async () => {
    expect(await saveGitHubConnection(alice, { encryptedToken: "enc-alice", login: "alice-gh" })).toBe(
      true,
    );

    expect(await getGitHubConnection(alice)).toEqual({
      githubAccessToken: "enc-alice",
      githubUsername: "alice-gh",
    });
    expect(await getGitHubConnection(bob)).toEqual({ githubAccessToken: null, githubUsername: null });
  });

  it("gives the settings page a boolean, never the token", async () => {
    await saveGitHubConnection(alice, { encryptedToken: "enc-alice", login: "alice-gh" });

    const settings = await getAccountSettings(alice);

    expect(settings).toMatchObject({ githubConnected: true, githubUsername: "alice-gh" });
    expect(settings).not.toHaveProperty("githubAccessToken");
    expect(JSON.stringify(settings)).not.toContain("enc-alice");
    expect((await getAccountSettings(bob))?.githubConnected).toBe(false);
  });

  it("disconnects: forgets the token and the GitHub link, keeps other sign-ins", async () => {
    await saveGitHubConnection(alice, { encryptedToken: "enc-alice", login: "alice-gh" });
    await linkAccount(alice, "github");
    await linkAccount(alice, "google");
    await saveGitHubConnection(bob, { encryptedToken: "enc-bob", login: "bob-gh" });
    await linkAccount(bob, "github");

    await disconnectGitHub(alice);

    expect(await getGitHubConnection(alice)).toEqual({ githubAccessToken: null, githubUsername: null });
    expect(await providersOf(alice)).toEqual(["google"]);
    // Bob is untouched.
    expect((await getGitHubConnection(bob))?.githubAccessToken).toBe("enc-bob");
    expect(await providersOf(bob)).toEqual(["github"]);
  });

  it("reports an unknown user instead of writing anything", async () => {
    const ghost = randomUUID();

    expect(await saveGitHubConnection(ghost, { encryptedToken: "x", login: "x" })).toBe(false);
    expect(await getAccountSettings(ghost)).toBeUndefined();
    expect(await db.select().from(users).where(eq(users.id, ghost))).toEqual([]);
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
