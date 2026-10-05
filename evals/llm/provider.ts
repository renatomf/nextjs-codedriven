/** Shared by the evals that call the LLM (review and chat). */

/** Provider errors name the Groq organization: never write it to results. */
export function describeError(error: unknown) {
  const mask = (text: string) => text.replace(/org_[A-Za-z0-9]+/g, "org_***");
  // After the SDK's retries the provider's answer is on the last error.
  const cause = (error as { lastError?: unknown }).lastError ?? error;
  const body = (cause as { responseBody?: string }).responseBody;
  return { error: mask(String(error)), responseBody: body ? mask(body).slice(0, 4000) : undefined };
}

/**
 * The eval account hit a provider rate limit (tokens per minute or per day):
 * the case was not measured, which says nothing about the review's quality
 * (TD-44). "Request too large" is not one: one request above the per-minute
 * limit always fails, and that is the review's token budget.
 */
export function isRateLimited(failure: { error: string; responseBody?: string }) {
  const text = `${failure.error} ${failure.responseBody ?? ""}`;
  return /Rate limit reached/i.test(text) && !/Request too large/i.test(text);
}

/** The daily quota is spent: every further call fails too, so stop calling. */
export const isDailyQuotaSpent = (failure: { error: string; responseBody?: string }) =>
  isRateLimited(failure) && /tokens per day|\(TPD\)/i.test(`${failure.error} ${failure.responseBody ?? ""}`);

/** vitest.eval.config.mts fills GROQ_API_KEY from GROQ_EVAL_API_KEY only. */
export function assertEvalKey() {
  if (!process.env.GROQ_API_KEY) {
    throw new Error(
      "RUN_LLM_EVAL needs GROQ_EVAL_API_KEY (a key from a separate Groq account, in .env.local or a CI secret); the production key is never used for evals.",
    );
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
