import { compare, hash } from "bcryptjs";
import { and, eq, isNull } from "drizzle-orm";

import { users } from "@/db/schema";
import { db } from "@/lib/db";

/**
 * Accounts: email sign-up, credential checks and what each sign-in records.
 * Security rules live here, next to the data they protect.
 */

const BCRYPT_COST = 12;

// Compared against when the user does not exist, so response time does not
// reveal which emails are registered.
let dummyHash: Promise<string> | undefined;
function getDummyHash() {
  dummyHash ??= hash("dummy-password-for-timing", BCRYPT_COST);
  return dummyHash;
}

/**
 * Creates an email/password account. Atomic insert: the unique constraint
 * decides, so two concurrent requests can never create duplicate accounts
 * (no check-then-insert race). False when the email is taken.
 */
export async function createEmailAccount(account: {
  name: string;
  email: string;
  password: string;
}): Promise<boolean> {
  const passwordHash = await hash(account.password, BCRYPT_COST);

  const [created] = await db
    .insert(users)
    .values({
      name: account.name,
      email: account.email,
      passwordHash,
      authProvider: "email",
    })
    .onConflictDoNothing({ target: users.email })
    .returning({ id: users.id });

  return Boolean(created);
}

/**
 * The user for these credentials, or null. Always runs one bcrypt compare
 * (against a dummy hash for unknown emails) so timing does not reveal which
 * emails exist. Accounts without a password (OAuth only) never match.
 */
export async function verifyCredentials(email: string, password: string) {
  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
    columns: { id: true, name: true, email: true, image: true, passwordHash: true },
  });

  const valid = await compare(password, user?.passwordHash ?? (await getDummyHash()));
  if (!user?.passwordHash || !valid) return null;

  return { id: user.id, name: user.name, email: user.email, image: user.image };
}

/**
 * An OAuth provider just proved ownership of this email. If the account had
 * an unverified password (possibly registered by someone else), drop it.
 */
export async function dropUnverifiedPassword(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ passwordHash: null, emailVerified: new Date() })
    .where(and(eq(users.id, userId), isNull(users.emailVerified)));
}

/**
 * What a sign-in records on the user: the provider, the avatar and, for
 * GitHub, the username. No OAuth token is stored (ADR-007).
 */
export async function recordSignIn(
  userId: string,
  signIn: {
    provider: string;
    image?: string;
    githubUsername?: string;
  },
): Promise<void> {
  const data: {
    authProvider: string;
    image?: string;
    githubUsername?: string;
  } = {
    authProvider: signIn.provider === "credentials" ? "email" : signIn.provider,
    image: signIn.image,
  };

  // No token is stored at sign-in (ADR-007): only the GitHub username.
  if (signIn.githubUsername) data.githubUsername = signIn.githubUsername;

  await db.update(users).set(data).where(eq(users.id, userId));
}
