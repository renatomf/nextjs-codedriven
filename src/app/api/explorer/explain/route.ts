import { logger, requestIdFrom } from "@/shared/logger";
import { dataBlock, newDataBoundary } from "@/shared/prompt-data";
import { generateText } from "ai";
import { z } from "zod";

import { getLanguageModel, languageModelId } from "@/lib/ai/llm";
import { auth } from "@/lib/auth";
import { readProjectFile } from "@/lib/files/explorer";
import { EXPLAIN_MAX_CHARS } from "@/lib/limits";
import { assertChatRateLimit, RateLimitError } from "@/lib/rate-limit";
import { BillingLimitError, LlmUnavailableError } from "@/modules/billing";
import { assertLlmBudget, assertLlmEnabled, recordLlmCall } from "@/modules/billing/server";
import { explainInstructions } from "@/modules/chat";
import { findOwnedProject } from "@/modules/projects/server";

export const runtime = "nodejs";
export const maxDuration = 60;

// Same question limit as the chat route (bounds the LLM cost per request).
const bodySchema = z.object({
  projectId: z.uuid(),
  filePath: z.string().trim().min(1).max(1024),
  question: z.string().trim().min(1).max(4000),
});

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json(
        { error: "projectId, filePath, and question are required." },
        { status: 400 },
      );
    }
    const { projectId, filePath, question } = parsed.data;

    const project = await findOwnedProject(session.user.id, projectId);
    if (!project) {
      return Response.json({ error: "Project not found" }, { status: 404 });
    }

    // Kill switch first: a feature that is off uses up no rate limit.
    await assertLlmEnabled("explain");
    await assertChatRateLimit(session.user.id);
    await assertLlmBudget(session.user.id);

    const file = await readProjectFile(session.user.id, project.id, filePath);
    if (!file) {
      return Response.json({ error: "File not found" }, { status: 404 });
    }

    const truncated =
      file.content.length > EXPLAIN_MAX_CHARS
        ? `${file.content.slice(0, EXPLAIN_MAX_CHARS)}\n\n/* truncated for analysis */`
        : file.content;

    // The file is untrusted (TD-28): it goes in a data block, the rules in
    // the instructions.
    const boundary = newDataBoundary();
    // Usage recorded on success and failure (Phase 4); recording never throws.
    const llmCall = {
      userId: session.user.id,
      projectId: project.id,
      feature: "explain" as const,
      model: languageModelId(),
    };
    const llmStarted = performance.now();
    const { text, usage } = await generateText({
      model: getLanguageModel(),
      // Same output cap as the chat route.
      maxOutputTokens: 4_000,
      instructions: explainInstructions(boundary),
      prompt: [
        `Project: ${project.name}`,
        `Question: ${question}`,
        "",
        dataBlock(boundary, `File: ${file.relativePath}`, truncated),
      ].join("\n"),
    }).catch(async (error: unknown) => {
      await recordLlmCall({ ...llmCall, usage: null, latencyMs: performance.now() - llmStarted, ok: false });
      throw error;
    });
    await recordLlmCall({ ...llmCall, usage, latencyMs: performance.now() - llmStarted, ok: true });

    return Response.json(
      {
        answer: text,
        filePath: file.relativePath,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof LlmUnavailableError) {
      return Response.json({ error: error.message }, { status: 503 });
    }
    if (error instanceof RateLimitError || error instanceof BillingLimitError) {
      return Response.json({ error: error.message }, { status: 429 });
    }
    // Details stay in the server log, never in the response.
    logger.error("explorer.explain_failed", { err: error, requestId: requestIdFrom(request.headers) });
    return Response.json(
      { error: "Failed to explain the selected file." },
      { status: 500 },
    );
  }
}
