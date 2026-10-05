import { describe, expect, it } from "vitest";

import { isDailyQuotaSpent, isRateLimited } from "./provider";

// Messages as Groq returned them in CI (organization masked).
const perDay = {
  error:
    "AI_RetryError: Failed after 3 attempts. Last error: AI_APICallError: Rate limit reached for model `openai/gpt-oss-120b` in organization `org_***` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 199835, Requested 1368.",
};
const perMinute = {
  error:
    "AI_APICallError: Rate limit reached for model `openai/gpt-oss-120b` in organization `org_***` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 6500, Requested 2100.",
};
const tooLarge = {
  error:
    "AI_APICallError: Request too large for model `openai/gpt-oss-120b` in organization `org_***` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 8374, please reduce your message size and try again.",
};

// TD-44: a case the rate limit kept from running is "not measured", not "worse".
describe("provider rate limits", () => {
  it("treats per-day and per-minute rate limits as not measured", () => {
    expect(isRateLimited(perDay)).toBe(true);
    expect(isRateLimited(perMinute)).toBe(true);
  });

  it("does not excuse a single request above the per-minute limit (the review's token budget)", () => {
    expect(isRateLimited(tooLarge)).toBe(false);
    expect(isRateLimited({ error: "AI_APICallError: Bad Request" })).toBe(false);
  });

  it("stops calling only when the daily quota is spent", () => {
    expect(isDailyQuotaSpent(perDay)).toBe(true);
    expect(isDailyQuotaSpent(perMinute)).toBe(false);
  });
});
