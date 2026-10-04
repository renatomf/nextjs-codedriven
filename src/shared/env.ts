import { z } from "zod";

/**
 * Environment contract, validated once when the server starts
 * (`src/instrumentation.ts`).
 *
 * - Required variables stop the server when missing or malformed: nothing
 *   works without them, so failing at boot beats failing inside a request.
 * - Optional integrations (OAuth, Stripe, public URLs) never stop the server:
 *   a malformed value is reported as a warning and treated as missing, so a
 *   bad billing key cannot take the whole site down.
 *
 * Messages carry variable names, never values.
 */

type EnvSource = Record<string, string | undefined>;

const requiredSchema = z
  .object({
    DATABASE_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\//, { message: "must be a postgres:// URL" }),
    AUTH_SECRET: z.string().min(32, { message: "must be at least 32 characters" }),
    ENCRYPTION_KEY: z
      .string()
      .refine((value) => Buffer.from(value, "base64").length === 32, {
        message: "must be 32 bytes encoded in base64",
      }),
    GROQ_API_KEY: z.string().optional(),
    E2E_FAKE_LLM: z.enum(["1"]).optional(),
  })
  .refine((env) => env.E2E_FAKE_LLM === "1" || Boolean(env.GROQ_API_KEY), {
    path: ["GROQ_API_KEY"],
    message: "is required (unless E2E_FAKE_LLM=1)",
  });

const nonEmpty = z.string().min(1);

const optionalSchemas = {
  AUTH_URL: z.url(),
  NEXT_PUBLIC_APP_URL: z.url(),
  GITHUB_CLIENT_ID: nonEmpty,
  GITHUB_CLIENT_SECRET: nonEmpty,
  GOOGLE_CLIENT_ID: nonEmpty,
  GOOGLE_CLIENT_SECRET: nonEmpty,
  STRIPE_SECRET_KEY: z
    .string()
    .regex(/^(sk|rk)_(test|live)_/, { message: "must be a Stripe secret key" }),
  STRIPE_PRICE_PREMIUM: z
    .string()
    .regex(/^price_/, { message: "must be a Stripe price id" }),
  STRIPE_WEBHOOK_SECRET: z
    .string()
    .regex(/^whsec_/, { message: "must be a Stripe webhook secret" }),
  NEXT_PUBLIC_SENTRY_DSN: z.url(),
  // GitHub App for repository access (ADR-007): one App per environment.
  GITHUB_APP_ID: z.string().regex(/^\d+$/, { message: "must be the numeric App ID" }),
  GITHUB_APP_CLIENT_ID: nonEmpty,
  GITHUB_APP_CLIENT_SECRET: nonEmpty,
  GITHUB_APP_PRIVATE_KEY: z
    .string()
    .refine((value) => value.includes("PRIVATE KEY"), { message: "must be the App's PEM private key" }),
  GITHUB_APP_SLUG: z.string().regex(/^[a-z0-9-]+$/, { message: "must be the App's URL slug" }),
  // Vercel sends it as a Bearer token to the cron routes (TD-11 reaper).
  CRON_SECRET: z.string().min(32, { message: "must be at least 32 characters" }),
} satisfies Record<string, z.ZodType<string>>;

type OptionalKey = keyof typeof optionalSchemas;

/** Features that are disabled when any of their variables is unusable. */
const OPTIONAL_FEATURES: Record<string, OptionalKey[]> = {
  "GitHub login and import": ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
  "GitHub App (repository access)": [
    "GITHUB_APP_ID",
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_CLIENT_SECRET",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_SLUG",
  ],
  "Google login": ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  billing: ["STRIPE_SECRET_KEY", "STRIPE_PRICE_PREMIUM", "STRIPE_WEBHOOK_SECRET"],
  "error monitoring (Sentry)": ["NEXT_PUBLIC_SENTRY_DSN"],
  "stuck project cleanup (cron)": ["CRON_SECRET"],
};

export class EnvValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid environment: ${problems.join("; ")}`);
    this.name = "EnvValidationError";
  }
}

const describe = (issue: z.core.$ZodIssue, name?: string) =>
  `${name ?? (issue.path.join(".") || "env")} ${issue.message}`;

/**
 * Throws EnvValidationError when a required variable is missing or
 * malformed. Otherwise returns the optional features that are disabled and
 * warnings for malformed optional values.
 */
export function validateEnv(source: EnvSource = process.env): {
  disabledFeatures: string[];
  warnings: string[];
} {
  // Empty strings count as "not set" (Vercel and .env files often leave them).
  const env: EnvSource = Object.fromEntries(
    Object.entries(source).map(([key, value]) => [key, value === "" ? undefined : value]),
  );

  const required = requiredSchema.safeParse(env);
  if (!required.success) {
    throw new EnvValidationError(required.error.issues.map((issue) => describe(issue)));
  }

  const usable = new Set<OptionalKey>();
  const warnings: string[] = [];
  for (const [name, schema] of Object.entries(optionalSchemas) as Array<
    [OptionalKey, z.ZodType<string>]
  >) {
    const value = env[name];
    if (value === undefined) continue;
    const parsed = schema.safeParse(value);
    if (parsed.success) usable.add(name);
    else warnings.push(...parsed.error.issues.map((issue) => describe(issue, name)));
  }

  const disabledFeatures = Object.entries(OPTIONAL_FEATURES)
    .filter(([, keys]) => keys.some((key) => !usable.has(key)))
    .map(([feature]) => feature);

  return { disabledFeatures, warnings };
}
