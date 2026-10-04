import { describe, expect, it } from "vitest";

import { EnvValidationError, validateEnv } from "@/shared/env";

type Source = Record<string, string | undefined>;

const valid: Source = {
  DATABASE_URL: "postgresql://app:secret@localhost:5432/app",
  AUTH_SECRET: "a".repeat(32),
  GROQ_API_KEY: "gsk_test",
};

function problemsOf(env: Source): string[] {
  try {
    validateEnv(env);
    return [];
  } catch (error) {
    if (error instanceof EnvValidationError) return error.problems;
    throw error;
  }
}

describe("validateEnv", () => {
  it("accepts the minimal required set and reports disabled integrations", () => {
    const { disabledFeatures } = validateEnv(valid);
    expect(disabledFeatures).toEqual([
      "GitHub login and import",
      "GitHub App (repository access)",
      "Google login",
      "billing",
      "error monitoring (Sentry)",
      "stuck project cleanup (cron)",
    ]);
  });

  it("names every missing required variable", () => {
    const problems = problemsOf({});
    for (const name of ["DATABASE_URL", "AUTH_SECRET"]) {
      expect(problems.some((p) => p.startsWith(name))).toBe(true);
    }
  });

  it("treats empty strings as not set", () => {
    expect(problemsOf({ ...valid, AUTH_SECRET: "" }).some((p) => p.startsWith("AUTH_SECRET"))).toBe(true);
  });

  it("requires GROQ_API_KEY unless the E2E fake LLM is on", () => {
    const withoutGroq = { ...valid, GROQ_API_KEY: undefined };
    expect(problemsOf(withoutGroq)).toEqual(["GROQ_API_KEY is required (unless E2E_FAKE_LLM=1)"]);
    expect(problemsOf({ ...withoutGroq, E2E_FAKE_LLM: "1" })).toEqual([]);
  });

  it("stops on malformed required values", () => {
    const problems = problemsOf({
      ...valid,
      DATABASE_URL: "mysql://x",
      AUTH_SECRET: "too-short",
    });
    for (const name of ["DATABASE_URL", "AUTH_SECRET"]) {
      expect(problems.some((p) => p.startsWith(name))).toBe(true);
    }
  });

  it("never stops on malformed optional values: warns and disables the feature", () => {
    const { warnings, disabledFeatures } = validateEnv({
      ...valid,
      STRIPE_SECRET_KEY: "pk_live_publishable",
      STRIPE_PRICE_PREMIUM: "price_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
      AUTH_URL: "not a url",
    });

    expect(warnings.some((w) => w.startsWith("STRIPE_SECRET_KEY"))).toBe(true);
    expect(warnings.some((w) => w.startsWith("AUTH_URL"))).toBe(true);
    expect(disabledFeatures).toContain("billing");
    expect(warnings.join(" ")).not.toContain("pk_live_publishable");
  });

  it("never puts values in the error message", () => {
    const secret = "postgresql-looking-but-invalid-hunter2";
    const problems = problemsOf({ ...valid, DATABASE_URL: secret, AUTH_SECRET: "short-hunter2" });
    expect(problems.join(" ")).not.toContain("hunter2");
  });

  it("enables an integration only when all its variables are present", () => {
    const { disabledFeatures } = validateEnv({
      ...valid,
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_PRICE_PREMIUM: "price_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
      GITHUB_CLIENT_ID: "id",
    });
    expect(disabledFeatures).toEqual([
      "GitHub login and import",
      "GitHub App (repository access)",
      "Google login",
      "error monitoring (Sentry)",
      "stuck project cleanup (cron)",
    ]);
  });
});
