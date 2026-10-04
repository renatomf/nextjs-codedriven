import type { Session } from "next-auth";
import type { JWT } from "next-auth/jwt";
import { describe, expect, it } from "vitest";

import { authConfig, isProtectedPath, profileImage } from "./auth.config";

const { authorized, jwt, session } = authConfig.callbacks;

function request(pathname: string) {
  return { nextUrl: new URL(`https://app.test${pathname}`) } as Parameters<typeof authorized>[0]["request"];
}

describe("isProtectedPath", () => {
  it.each(["/dashboard", "/projects", "/projects/abc", "/settings", "/settings/billing"])(
    "protects %s",
    (pathname) => expect(isProtectedPath(pathname)).toBe(true),
  );

  it.each(["/", "/login", "/register", "/projectsx", "/dashboard-old", "/share/abc"])(
    "leaves %s public",
    (pathname) => expect(isProtectedPath(pathname)).toBe(false),
  );
});

describe("authorized", () => {
  it("lets only a signed-in user into a protected page", () => {
    expect(authorized({ auth: null, request: request("/projects/1") })).toBe(false);
    expect(
      authorized({ auth: { user: { id: "u1" }, expires: "" }, request: request("/projects/1") }),
    ).toBe(true);
  });

  it("lets anyone into a public page", () => {
    expect(authorized({ auth: null, request: request("/login") })).toBe(true);
  });
});

describe("profileImage", () => {
  it("reads the avatar each provider sends", () => {
    expect(profileImage("github", { avatar_url: "https://github.test/a.png" })).toBe(
      "https://github.test/a.png",
    );
    expect(profileImage("google", { picture: "https://google.test/a.png" })).toBe(
      "https://google.test/a.png",
    );
  });

  it("refuses anything but an https URL", () => {
    expect(profileImage("github", { avatar_url: "http://github.test/a.png" })).toBeUndefined();
    expect(profileImage("github", { avatar_url: "javascript:alert(1)" })).toBeUndefined();
    expect(profileImage("google", { picture: 42 })).toBeUndefined();
    expect(profileImage("github", undefined)).toBeUndefined();
  });

  it("does not mix up the providers' fields", () => {
    expect(profileImage("google", { avatar_url: "https://github.test/a.png" })).toBeUndefined();
  });
});

describe("jwt and session", () => {
  it("carry the user id and the provider from sign-in to the session", async () => {
    const token = await jwt({
      token: { picture: "https://old.test/a.png" },
      user: { id: "u1" },
      account: { provider: "github", type: "oauth", providerAccountId: "1" },
      profile: { avatar_url: "https://github.test/new.png" },
    } as unknown as Parameters<typeof jwt>[0]);

    expect(token).toMatchObject({
      sub: "u1",
      authProvider: "github",
      picture: "https://github.test/new.png",
    });

    const result = (await session({
      session: { user: { name: "Ana" }, expires: "" },
      token,
    } as unknown as Parameters<typeof session>[0])) as Session;

    expect(result.user).toMatchObject({ id: "u1", authProvider: "github" });
  });

  it("keeps the stored picture when the profile has no valid one", async () => {
    const token = await jwt({
      token: { sub: "u1", picture: "https://old.test/a.png" },
      account: { provider: "github", type: "oauth", providerAccountId: "1" },
      profile: { avatar_url: "http://insecure.test/a.png" },
    } as unknown as Parameters<typeof jwt>[0]);

    expect(token.picture).toBe("https://old.test/a.png");
  });

  it("leaves a later request's token as it is", async () => {
    const before: JWT = { sub: "u1", authProvider: "google" };
    const token = await jwt({ token: { ...before } } as unknown as Parameters<typeof jwt>[0]);

    expect(token).toEqual(before);
  });

  it("gives the session no id without a token subject", async () => {
    const result = (await session({
      session: { user: { name: "Ana" }, expires: "" },
      token: {},
    } as unknown as Parameters<typeof session>[0])) as Session;

    expect(result.user).not.toHaveProperty("id");
  });
});
