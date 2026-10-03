import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EMBEDDING_DIMENSIONS } from "../domain/knowledge";

// TD-01: loading the model must recover from a failed download. The real
// model is covered by onnx-embedder.model.test.ts (opt-in); here the hub is
// replaced by a fake `pipeline`.

const pipeline = vi.hoisted(() => vi.fn());

vi.mock("@huggingface/transformers", () => ({ env: {}, pipeline }));
// Not under test, and heavy (Sentry): each test reloads the module, which was
// slow enough under the full parallel suite to time out.
vi.mock("@/shared/tracing", () => ({
  traced: (_name: string, _attributes: unknown, run: () => unknown) => run(),
}));

const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.1);
const extractor = async () => ({ data: vector });

// The loaded model is cached per module instance: a fresh one per test.
async function freshEmbedder() {
  vi.resetModules();
  return import("./onnx-embedder");
}

beforeEach(() => {
  vi.useFakeTimers();
  pipeline.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("onnx embedder model load (TD-01)", () => {
  it("retries a failed download and then embeds", async () => {
    pipeline.mockRejectedValueOnce(new Error("hub 503")).mockResolvedValue(extractor);
    const { embedTexts } = await freshEmbedder();

    const embedded = embedTexts(["a"]);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await embedded).toEqual([vector]);
    expect(pipeline).toHaveBeenCalledTimes(2);
  });

  it("does not keep a failed load: the next call loads again", async () => {
    pipeline.mockRejectedValue(new Error("hub down"));
    const { embedTexts } = await freshEmbedder();

    const first = embedTexts(["a"]);
    const settled = expect(first).rejects.toThrow("hub down");
    await vi.advanceTimersByTimeAsync(4_000);
    await settled;
    expect(pipeline).toHaveBeenCalledTimes(3);

    pipeline.mockResolvedValue(extractor);
    expect(await embedTexts(["b"])).toEqual([vector]);
    expect(pipeline).toHaveBeenCalledTimes(4);
  });

  it("loads the model once for calls made at the same time", async () => {
    pipeline.mockResolvedValue(extractor);
    const { embedTexts } = await freshEmbedder();

    await Promise.all([embedTexts(["a"]), embedTexts(["b"]), embedTexts(["c"])]);

    expect(pipeline).toHaveBeenCalledOnce();
  });
});
