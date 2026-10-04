import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  accounts,
  embeddingCache,
  githubInstallations,
  llmCalls,
  projects,
  reportShares,
  sessions,
  usageEvents,
  users,
  verificationTokens,
} from "@/db/schema";
import { db } from "@/lib/db";
import {
  axisEmbedding,
  createProjectWithData,
  createUser,
  deleteUsers,
} from "@/test/integration/factories";

// Account deletion (roadmap Phase 6, LGPD) against a real Postgres. Only
// Stripe and the object storage are faked.

const mocks = vi.hoisted(() => ({
  deleteCustomer: vi.fn(),
  storageConfig: vi.fn(),
  staleObjects: vi.fn(),
  deleteObject: vi.fn(),
}));

vi.mock("@/modules/billing/infrastructure/stripe/client", () => ({
  getStripe: () => ({ customers: { del: mocks.deleteCustomer } }),
}));
vi.mock("@/lib/storage/neon-storage", () => ({
  storageConfig: mocks.storageConfig,
  staleObjects: mocks.staleObjects,
  deleteObject: mocks.deleteObject,
}));

import { deleteAccount } from "@/lib/account-deletion";
import { rateLimits } from "@/db/schema";
import { assertRateLimit } from "@/lib/rate-limit";

const created: string[] = [];

afterAll(async () => {
  await deleteUsers(created);
});

beforeEach(() => {
  mocks.deleteCustomer.mockReset().mockResolvedValue({ deleted: true });
  mocks.storageConfig.mockReset().mockReturnValue(null);
  mocks.staleObjects.mockReset().mockResolvedValue([]);
  mocks.deleteObject.mockReset().mockResolvedValue(undefined);
});

/** A user with a row in every table that can hold their data. */
async function fullAccount() {
  const userId = await createUser();
  created.push(userId);
  const [user] = await db
    .update(users)
    .set({ stripeCustomerId: `cus_${randomUUID()}`, githubUsername: "octo" })
    .where(eq(users.id, userId))
    .returning({ email: users.email, customerId: users.stripeCustomerId });

  const projectId = await createProjectWithData(userId, randomUUID());
  await db.insert(accounts).values({
    userId,
    type: "oauth",
    provider: "github",
    providerAccountId: randomUUID(),
  });
  await db.insert(sessions).values({
    userId,
    sessionToken: randomUUID(),
    expires: new Date(Date.now() + 60_000),
  });
  await db.insert(verificationTokens).values({
    identifier: user.email!,
    token: randomUUID(),
    expires: new Date(Date.now() + 60_000),
  });
  await db.insert(usageEvents).values({ userId, type: "analysis" });
  await db.insert(llmCalls).values({
    userId,
    projectId,
    feature: "chat",
    model: "m",
    inputTokens: 1,
    outputTokens: 1,
    latencyMs: 1,
    ok: true,
  });
  await db.insert(reportShares).values({ projectId, tokenHash: randomUUID() });
  await db.insert(embeddingCache).values({
    projectId,
    contentHash: "h",
    embeddingModel: "m",
    embedding: axisEmbedding(2),
  });
  await db.insert(githubInstallations).values({ userId, installationId: 9_000_001, accountLogin: "octo" });
  await assertRateLimit(`chat:${userId}`, 100, 60_000, "limit");
  await assertRateLimit(`login:1.2.3.4:${user.email}`, 100, 60_000, "limit");

  return { userId, email: user.email!, customerId: user.customerId!, projectId };
}

/** Rows of every table in the public schema whose text mentions `needle`. */
async function rowsMentioning(needle: string): Promise<Record<string, number>> {
  const tables = await db.execute<{ table_name: string }>(
    sql`select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );
  const found: Record<string, number> = {};
  for (const { table_name } of tables.rows) {
    const result = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from ${sql.identifier(table_name)} as t
          where t::text ilike ${`%${needle}%`}`,
    );
    const n = result.rows[0]?.n ?? 0;
    if (n > 0) found[table_name] = n;
  }
  return found;
}

describe("deleteAccount", () => {
  it("leaves no row anywhere that mentions the user's id or email", async () => {
    const account = await fullAccount();
    // Sanity: the check sees the data before the deletion.
    expect(Object.keys(await rowsMentioning(account.userId)).length).toBeGreaterThan(3);
    expect(await rowsMentioning(account.email)).toMatchObject({ users: 1, verification_tokens: 1 });

    expect(await deleteAccount(account.userId)).toBe(true);

    expect(await rowsMentioning(account.userId)).toEqual({});
    expect(await rowsMentioning(account.email)).toEqual({});
    expect(await rowsMentioning(account.customerId)).toEqual({});
    expect(await rowsMentioning(account.projectId)).toEqual({});
  });

  it("deletes the Stripe customer first (subscriptions end at once)", async () => {
    const account = await fullAccount();
    mocks.deleteCustomer.mockImplementation(async () => {
      // The account is still there while Stripe is called.
      const [user] = await db.select().from(users).where(eq(users.id, account.userId));
      expect(user).toBeDefined();
      return { deleted: true };
    });

    await deleteAccount(account.userId);

    expect(mocks.deleteCustomer).toHaveBeenCalledWith(account.customerId);
  });

  it("deletes nothing when Stripe fails, so the user can retry", async () => {
    const account = await fullAccount();
    mocks.deleteCustomer.mockRejectedValue(new Error("stripe down"));

    await expect(deleteAccount(account.userId)).rejects.toThrow("stripe down");

    expect(await db.$count(users, eq(users.id, account.userId))).toBe(1);
    expect(await db.$count(projects, eq(projects.userId, account.userId))).toBe(1);
  });

  it("deletes the user's pending uploads, and only theirs", async () => {
    const account = await fullAccount();
    mocks.storageConfig.mockReturnValue({ bucket: "uploads" });
    mocks.staleObjects.mockResolvedValue([`uploads/${account.userId}/a.zip`]);

    await deleteAccount(account.userId);

    const [, prefix, olderThan] = mocks.staleObjects.mock.calls[0];
    expect(prefix).toBe(`uploads/${account.userId}/`);
    expect((olderThan as Date).getTime()).toBeGreaterThan(Date.now());
    expect(mocks.deleteObject).toHaveBeenCalledWith({ bucket: "uploads" }, `uploads/${account.userId}/a.zip`);
  });

  it("still deletes the account when the storage fails (the reaper removes uploads)", async () => {
    const account = await fullAccount();
    mocks.storageConfig.mockReturnValue({ bucket: "uploads" });
    mocks.staleObjects.mockRejectedValue(new Error("storage down"));

    expect(await deleteAccount(account.userId)).toBe(true);
    expect(await db.$count(users, eq(users.id, account.userId))).toBe(0);
  });

  it("keeps other users' data", async () => {
    const other = await fullAccount();
    const account = await fullAccount();

    await deleteAccount(account.userId);

    expect(await db.$count(users, eq(users.id, other.userId))).toBe(1);
    expect(await db.$count(projects, eq(projects.userId, other.userId))).toBe(1);
  });

  it("stores rate limits only as hashes (nothing to find by id or email)", async () => {
    const account = await fullAccount();

    const keys = await db.select({ key: rateLimits.key }).from(rateLimits);

    expect(keys.some(({ key }) => key.includes(account.userId) || key.includes(account.email))).toBe(false);
  });
});
