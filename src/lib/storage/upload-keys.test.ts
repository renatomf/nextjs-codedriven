import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isOwnUploadKey, newUploadKey } from "./upload-keys";
import { uploadOrigins } from "./neon-storage";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

describe("upload keys (ADR-011)", () => {
  it("makes a random key under the user's own prefix", () => {
    const key = newUploadKey(ALICE);
    expect(key).toMatch(new RegExp(`^uploads/${ALICE}/[0-9a-f-]{36}\\.zip$`));
    expect(newUploadKey(ALICE)).not.toBe(key);
    expect(isOwnUploadKey(ALICE, key)).toBe(true);
  });

  it("refuses another user's key, a path trick or a hand-written name", () => {
    expect(isOwnUploadKey(BOB, newUploadKey(ALICE))).toBe(false);
    expect(isOwnUploadKey(ALICE, `uploads/${ALICE}/../${BOB}/x.zip`)).toBe(false);
    expect(isOwnUploadKey(ALICE, `uploads/${ALICE}/report.zip`)).toBe(false);
    expect(isOwnUploadKey(ALICE, "")).toBe(false);
  });
});

describe("uploadOrigins", () => {
  it("allows only this deployment's origins", () => {
    expect(
      uploadOrigins({
        NODE_ENV: "production",
        NEXT_PUBLIC_APP_URL: "https://codedriven.example/",
        VERCEL_URL: "app-abc123.vercel.app",
        VERCEL_BRANCH_URL: "app-git-main.vercel.app",
      }),
    ).toEqual([
      "https://codedriven.example",
      "https://app-abc123.vercel.app",
      "https://app-git-main.vercel.app",
    ]);
  });

  it("adds localhost only in development", () => {
    expect(uploadOrigins({ NODE_ENV: "development" })).toEqual(["http://localhost:3000"]);
    expect(uploadOrigins({ NODE_ENV: "production" })).toEqual([]);
  });
});
