import "server-only";

import { randomUUID } from "node:crypto";

import { db } from "@/lib/db";
import { logger } from "@/shared/logger";

import { createQuota, getBillingSnapshot as snapshotFor } from "./application/quota";
import { estimateCostMicroUsd, type LlmFeature } from "./domain/llm-cost";
import { LlmUnavailableError } from "./domain/llm-switch";
import { assertLlmTokenBudget, quotaDayStart } from "./domain/quota";
import {
  createBillingRepository,
  type Executor,
} from "./infrastructure/drizzle-billing-repository";
import {
  insertLlmCall,
  isLlmFeatureEnabled,
  sumLlmTokensSince,
} from "./infrastructure/drizzle-llm-calls";
import { getPlanCatalog, limitsFor, type PlanCatalog, type PlanLimits } from "./index";

/**
 * Public API of the billing module — server part (ADR-001): use cases bound
 * to the database and to Stripe. Import from server code only. Every
 * `userId` must come from the server session, never from the client.
 */

function depsFor(executor: Executor) {
  return {
    repo: createBillingRepository(executor),
    catalog: getPlanCatalog,
    now: () => new Date(),
  };
}

/**
 * Quota checks bound to `executor`. Pass the caller's transaction so the
 * user-row lock holds until it commits. Prefer `withQuota`, which cannot be
 * called without the transaction.
 */
export function billingFor(executor: Executor = db) {
  return createQuota(depsFor(executor));
}

/**
 * The limits of the user's plan (free when the user is gone), read without
 * a lock: for rate limits outside the quota transaction.
 */
export async function getPlanLimitsFor(userId: string): Promise<PlanLimits> {
  const user = await createBillingRepository(db).findUserBilling(userId);
  return limitsFor(getPlanCatalog(), user?.plan, user?.planStatus);
}

/** `userId` must come from the server session. */
export function getBillingSnapshot(userId: string) {
  return snapshotFor(depsFor(db), userId);
}

export type QuotaKind = "project" | "analysis";
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Runs `work` in one transaction that locks the user row, checks the plan
 * limit, and records the analysis usage only when `work` reports the quota
 * as consumed — or rolls everything back if anything throws.
 *
 * `work` must only do quick database writes: the user row stays locked
 * until it returns (downloads and extraction belong outside).
 *
 * `usage.id` is the id the usage record will get: keep it to refund this
 * analysis if a later step fails on our side (`refundAnalysisUsage`).
 */
export function withQuota<T>(
  userId: string,
  kind: QuotaKind,
  work: (tx: Tx, usage: { id: string }) => Promise<{ consumed: boolean; value: T }>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const quota = createQuota(depsFor(tx));
    if (kind === "project") await quota.assertCanCreateProject(userId);
    else await quota.assertCanRunAnalysis(userId);

    const usage = { id: randomUUID() };
    const { consumed, value } = await work(tx, usage);
    if (consumed) await quota.recordAnalysisUsage(userId, usage.id);
    return value;
  });
}

/**
 * Gives back one analysis recorded by `withQuota` (ADR-003): only when the
 * work failed on our side, never for user errors such as an invalid ZIP.
 */
export function refundAnalysisUsage(userId: string, usageId: string): Promise<void> {
  return createQuota(depsFor(db)).refundAnalysisUsage(userId, usageId);
}

/**
 * Records one LLM call: tokens, latency, outcome and the estimated cost
 * (roadmap Phase 4). Counts only, never the prompt or the answer. Never
 * throws: a failure to record is logged and must not break the user's
 * request. `userId` comes from the server session and `projectId` from a
 * project already checked to be that user's.
 */
export async function recordLlmCall(call: {
  userId: string;
  projectId: string | null;
  feature: LlmFeature;
  model: string;
  usage: { inputTokens?: number; outputTokens?: number } | null;
  latencyMs: number;
  ok: boolean;
}): Promise<void> {
  const usage = {
    inputTokens: call.usage?.inputTokens ?? 0,
    outputTokens: call.usage?.outputTokens ?? 0,
  };
  try {
    await insertLlmCall({
      userId: call.userId,
      projectId: call.projectId,
      feature: call.feature,
      model: call.model,
      ...usage,
      latencyMs: Math.round(call.latencyMs),
      ok: call.ok,
      costMicroUsd: estimateCostMicroUsd(call.model, usage),
    });
  } catch (err) {
    logger.error("llm_usage.record_failed", {
      err,
      userId: call.userId,
      projectId: call.projectId ?? undefined,
      feature: call.feature,
    });
  }
}

/**
 * Throws `BillingLimitError` ("llm_tokens") once the user has spent the
 * daily LLM token budget of their plan. Call it right before each LLM call.
 * `userId` must come from the server session.
 */
export async function assertLlmBudget(userId: string): Promise<void> {
  const limits = await getPlanLimitsFor(userId);
  const used = await sumLlmTokensSince(userId, quotaDayStart(new Date()));
  assertLlmTokenBudget(getPlanCatalog(), limits, used);
}

/**
 * Throws `LlmUnavailableError` when the feature's kill switch is off. Read on
 * every call (no cache), so flipping it takes effect on the next request.
 */
export async function assertLlmEnabled(feature: LlmFeature): Promise<void> {
  if (!(await isLlmFeatureEnabled(feature))) throw new LlmUnavailableError(feature);
}

// Stripe: loaded on first use, so quota callers (analysis, chat) do not pay
// for the SDK at cold start.
const stripeClient = () => import("./infrastructure/stripe/client");
const stripeCheckout = () => import("./infrastructure/stripe/checkout");
const stripeSync = () => import("./infrastructure/stripe/sync-checkout");
const stripeWebhook = () => import("./infrastructure/stripe/webhook");
const stripeCloseAccount = () => import("./infrastructure/stripe/close-account");

/**
 * Same as getPlanCatalog(), but premium.priceLabel comes from Stripe
 * (STRIPE_PRICE_PREMIUM) unless NEXT_PUBLIC_PLAN_PREMIUM_PRICE_LABEL is set.
 */
export async function getPlanCatalogWithPricing(): Promise<PlanCatalog> {
  const plans = getPlanCatalog();
  if (process.env.NEXT_PUBLIC_PLAN_PREMIUM_PRICE_LABEL?.trim()) {
    return plans;
  }

  const fromStripe = await (await stripeClient()).fetchPremiumPriceLabel();
  if (fromStripe) {
    plans.premium.priceLabel = fromStripe;
  }
  return plans;
}

/** Checkout URL, or `alreadySubscribed` so a paid user is never billed twice. */
export async function createPremiumCheckout(userId: string) {
  return (await stripeCheckout()).createPremiumCheckout(userId);
}

export async function createBillingPortalSession(userId: string) {
  return (await stripeCheckout()).createBillingPortalSession(userId);
}

/** After the Checkout redirect: sync the session even if the webhook was missed. */
export async function syncCheckoutSessionForUser(userId: string, checkoutSessionId: string) {
  return (await stripeSync()).syncCheckoutSessionForUser(userId, checkoutSessionId);
}

/** Recover the plan from Stripe by listing the customer's subscriptions. */
export async function syncCustomerSubscriptionsForUser(userId: string) {
  return (await stripeSync()).syncCustomerSubscriptionsForUser(userId);
}

/**
 * Account deletion: deletes the Stripe customer (subscriptions end at once).
 * Throws when Stripe fails, so nothing else is deleted.
 */
export async function closeBillingAccount(userId: string) {
  return (await stripeCloseAccount()).closeBillingAccount(userId);
}

/** The event, or null when the signature does not match the raw payload. */
export async function verifyStripeWebhook(payload: string, signature: string, secret: string) {
  return (await stripeWebhook()).verifyStripeWebhook(payload, signature, secret);
}

export type StripeWebhookEvent = NonNullable<Awaited<ReturnType<typeof verifyStripeWebhook>>>;

export async function handleStripeEvent(event: StripeWebhookEvent) {
  return (await stripeWebhook()).handleStripeEvent(event);
}
