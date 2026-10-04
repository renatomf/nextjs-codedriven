import type { NextAuthConfig } from "next-auth";
import Github from "next-auth/providers/github";
import Google from "next-auth/providers/google";

// The adapter only saves the avatar when it creates the user, so accounts
// linked later (or avatars changed on the provider) are read from the profile.
export function profileImage(provider: string, profile: unknown) {
  const p = profile as { avatar_url?: unknown; picture?: unknown } | undefined;
  const url = provider === "github" ? p?.avatar_url : p?.picture;
  return typeof url === "string" && url.startsWith("https://") ? url : undefined;
}

/** Pages that need a session (the pages check it again on the server). */
export function isProtectedPath(pathname: string): boolean {
  return ["/dashboard", "/projects", "/settings"].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export const authConfig = {
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
      allowDangerousEmailAccountLinking: true,
    }),
    Github({
      clientId: process.env.GITHUB_CLIENT_ID as string,
      clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
      allowDangerousEmailAccountLinking: true,
      // Sign-in only identifies the user: repository access goes through the
      // read-only GitHub App (ADR-007), never through this token.
      authorization: {
        params: {
          scope: "read:user user:email",
        },
      },
    }),
  ],
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
  },
  callbacks: {
    authorized({ auth, request }) {
      if (isProtectedPath(request.nextUrl.pathname)) return !!auth;
      return true;
    },
    async jwt({ token, user, account, profile }) {
      if (user) {
        token.sub = user.id;
      }
      if (account) {
        token.authProvider = account.provider;
        token.picture = profileImage(account.provider, profile) ?? token.picture;
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
      }
      if (session.user && typeof token.authProvider === "string") {
        session.user.authProvider = token.authProvider;
      }

      return session;
    },
  },
} satisfies NextAuthConfig;