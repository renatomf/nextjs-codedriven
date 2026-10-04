import { randomBytes, randomUUID } from "node:crypto";

import { compare } from "bcryptjs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { users } from "@/db/schema";
import { db } from "@/lib/db";
import {
  createEmailAccount,
  dropUnverifiedPassword,
  recordSignIn,
  verifyCredentials,
} from "@/modules/identity/server";
import { createUser, deleteUsers } from "@/test/integration/factories";

// Account security on a real Postgres: passwords stored only as bcrypt
// hashes, one account per email even under concurrency, credentials that
// fail the same way for unknown emails and OAuth-only accounts, unverified
// passwords dropped when a provider proves the email, and the GitHub token
// stored encrypted and bound to its owner.

vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("base64"));

const emails: string[] = [];
const created: string[] = [];

const newEmail = () => {
  const email = `acc-${randomUUID()}@example.test`;
  emails.push(email);
  return email;
};

async function userByEmail(email: string) {
  const [user] = await db.select().from(users).where(eq(users.email, email));
  return user;
}

afterAll(async () => {
  for (const email of emails) await db.delete(users).where(eq(users.email, email));
  await deleteUsers(created);
});

describe("createEmailAccount", () => {
  it("stores only a bcrypt hash of the password", async () => {
    const email = newEmail();

    expect(await createEmailAccount({ name: "A B", email, password: "s3cret-password" })).toBe(true);

    const user = await userByEmail(email);
    expect(user.passwordHash).not.toContain("s3cret-password");
    expect(await compare("s3cret-password", user.passwordHash!)).toBe(true);
    expect(user.authProvider).toBe("email");
  });

  it("refuses a taken email without touching the existing account", async () => {
    const email = newEmail();
    await createEmailAccount({ name: "First", email, password: "first-password" });

    expect(await createEmailAccount({ name: "Second", email, password: "second-password" })).toBe(
      false,
    );
    expect((await userByEmail(email)).name).toBe("First");
  });

  it("creates exactly one account when two sign-ups race", async () => {
    const email = newEmail();

    const results = await Promise.all([
      createEmailAccount({ name: "One", email, password: "password-one" }),
      createEmailAccount({ name: "Two", email, password: "password-two" }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await db.$count(users, eq(users.email, email))).toBe(1);
  });
});

describe("verifyCredentials", () => {
  const email = `cred-${randomUUID()}@example.test`;

  beforeAll(async () => {
    emails.push(email);
    await createEmailAccount({ name: "Cred User", email, password: "right-password" });
  });

  it("returns the user (never the hash) for the right password", async () => {
    const user = await verifyCredentials(email, "right-password");

    expect(user).toMatchObject({ email, name: "Cred User" });
    expect(user).not.toHaveProperty("passwordHash");
  });

  it("rejects a wrong password and an unknown email the same way", async () => {
    expect(await verifyCredentials(email, "wrong-password")).toBeNull();
    expect(await verifyCredentials(`nobody-${randomUUID()}@example.test`, "whatever")).toBeNull();
  });

  it("never matches an account without a password (OAuth only)", async () => {
    const oauthOnly = await createUser();
    created.push(oauthOnly);
    const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, oauthOnly));

    expect(await verifyCredentials(row.email!, "")).toBeNull();
  });
});

describe("dropUnverifiedPassword", () => {
  it("drops a password nobody verified and marks the email verified", async () => {
    const email = newEmail();
    await createEmailAccount({ name: "Squatter", email, password: "squatter-password" });
    const { id } = await userByEmail(email);

    await dropUnverifiedPassword(id);

    const user = await userByEmail(email);
    expect(user.passwordHash).toBeNull();
    expect(user.emailVerified).toBeInstanceOf(Date);
    expect(await verifyCredentials(email, "squatter-password")).toBeNull();
  });

  it("keeps the password of an already verified account", async () => {
    const email = newEmail();
    await createEmailAccount({ name: "Owner", email, password: "owner-password" });
    const { id } = await userByEmail(email);
    await db.update(users).set({ emailVerified: new Date() }).where(eq(users.id, id));

    await dropUnverifiedPassword(id);

    expect(await verifyCredentials(email, "owner-password")).not.toBeNull();
  });
});

describe("recordSignIn", () => {
  it("records a GitHub sign-in with the username and never a token (ADR-007)", async () => {
    const userId = await createUser();
    created.push(userId);

    await recordSignIn(userId, {
      provider: "github",
      image: "https://avatars.example/u.png",
      githubUsername: "octo",
    });

    const [user] = await db.select().from(users).where(eq(users.id, userId));
    expect(user).toMatchObject({ authProvider: "github", githubUsername: "octo", githubAccessToken: null });
  });

  it("records an email sign-in as the email provider, without touching GitHub", async () => {
    const userId = await createUser();
    created.push(userId);

    await recordSignIn(userId, { provider: "credentials" });

    const [user] = await db.select().from(users).where(eq(users.id, userId));
    expect(user).toMatchObject({ authProvider: "email", githubAccessToken: null });
  });
});
