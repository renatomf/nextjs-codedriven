import { logger } from "@/shared/logger";
import "server-only";

import NextAuth from "next-auth";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import type { Adapter } from "next-auth/adapters";
import Credentials from "next-auth/providers/credentials";

import { accounts, sessions, users, verificationTokens } from "@/db/schema";
import { authConfig, profileImage } from "@/lib/auth.config";
import { db } from "@/lib/db";
import { loginSchema } from "@/lib/validations/auth";
import {
  dropUnverifiedPassword,
  recordSignIn,
  verifyCredentials,
} from "@/modules/identity/server";
import { GITHUB_API, githubHeaders } from "@/lib/github-api";

// Sign-in checks are short: a slow GitHub must not hold the login.
const GITHUB_TIMEOUT_MS = 5000;

type AdapterSchema = NonNullable<Parameters<typeof DrizzleAdapter<typeof db>>[1]>;

// The cast is type-only: `.enableRLS()` drops a method the adapter's types
// expect, and they want `sessionToken` as the primary key (ours is unique, and
// the sessions table is unused with the JWT strategy). Column names match.
const drizzleAdapter = DrizzleAdapter(db, {
  usersTable: users,
  accountsTable: accounts,
  sessionsTable: sessions,
  verificationTokensTable: verificationTokens,
} as unknown as AdapterSchema);

// OAuth tokens are never stored: the sign-in token is used in memory only
// (events.signIn) and repository access is the GitHub App's (ADR-007).
const adapter: Adapter = {
  ...drizzleAdapter,
  linkAccount: (account) =>
    drizzleAdapter.linkAccount!({
      ...account,
      access_token: undefined,
      refresh_token: undefined,
      id_token: undefined,
    }),
};

async function isGithubEmailVerified(accessToken: string, email: string) {
  const res = await fetch(`${GITHUB_API}/user/emails`, {
    headers: githubHeaders(accessToken),
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  if (!res.ok) return false;

  const emails = (await res.json()) as { email: string; verified: boolean }[];
  return emails.some(
    (entry) => entry.verified && entry.email.toLowerCase() === email.toLowerCase(),
  );
}

async function fetchGithubUsername(accessToken: string) {
  try {
    const res = await fetch(`${GITHUB_API}/user`, {
      headers: githubHeaders(accessToken),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;

    const profile = (await res.json()) as { login?: string };
    return profile.login;
  } catch (error) {
    logger.error("auth.github_profile_failed", { err: error });
    return undefined;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter,
  session: { strategy: "jwt" },
  providers: [
    ...authConfig.providers,
    Credentials({
      name: "Email",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) return null;

        return verifyCredentials(parsed.data.email, parsed.data.password);
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    // Email-based account linking is only safe when the provider has verified
    // that the user owns the email address.
    async signIn({ user, account, profile }) {
      if (!account || account.provider === "credentials") return true;
      if (!user.email) return false;

      if (account.provider === "google") {
        return profile?.email_verified === true;
      }

      if (account.provider === "github") {
        if (!account.access_token) return false;
        try {
          return await isGithubEmailVerified(account.access_token, user.email);
        } catch (error) {
          logger.error("auth.github_email_check_failed", { err: error });
          return false;
        }
      }

      return false;
    },
  },
  events: {
    // An OAuth provider just proved ownership of this email. If the account had
    // an unverified password (possibly registered by someone else), drop it.
    async linkAccount({ user }) {
      if (!user.id) return;

      await dropUnverifiedPassword(user.id);
    },
    async signIn({ user, account, profile }) {
      if (!user.id || !account) return;

      // The sign-in token is used here, in memory, and never stored: it only
      // reads the profile (ADR-007). Repository access is the GitHub App's.
      const github =
        account.provider === "github" && account.access_token
          ? { githubUsername: await fetchGithubUsername(account.access_token) }
          : {};

      await recordSignIn(user.id, {
        provider: account.provider,
        image: profileImage(account.provider, profile),
        ...github,
      });
    },
  },
});
