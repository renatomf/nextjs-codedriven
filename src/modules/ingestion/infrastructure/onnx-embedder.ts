import { env, pipeline } from "@huggingface/transformers";

import { traced } from "@/shared/tracing";

import type { Embedder } from "../application/ports";
import { EMBEDDING_DIMENSIONS } from "../domain/knowledge";

// Run fully from the Hugging Face hub cache; no local model path required.
env.allowLocalModels = false;
// On Vercel only /tmp is writable; the default cache lives in node_modules.
if (process.env.VERCEL) {
  env.cacheDir = "/tmp/transformers-cache";
}

const BATCH_SIZE = 16;
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
// Pinned hub commit: the model cannot change under us (TD-05).
export const MODEL_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
// q8 = onnx/model_quantized.onnx, the file @xenova/transformers loaded by
// default. Changing it changes the vectors already stored in code_chunks.
const MODEL_DTYPE = "q8";

type EmbeddingOutput = {
  data: Float32Array | number[];
};

type FeatureExtractor = (
  text: string,
  options: { pooling: "mean"; normalize: boolean },
) => Promise<EmbeddingOutput>;

// The hub download can fail for a moment (network, Hugging Face outage):
// retry within the call before giving up (TD-01).
const LOAD_RETRY_DELAYS_MS = [1_000, 3_000];

let extractorPromise: Promise<FeatureExtractor> | null = null;

async function loadExtractor(): Promise<FeatureExtractor> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return (await pipeline("feature-extraction", MODEL_ID, {
        revision: MODEL_REVISION,
        dtype: MODEL_DTYPE,
      })) as unknown as FeatureExtractor;
    } catch (error) {
      const delay = LOAD_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function getExtractor(): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    // Cold start: downloads (~23MB) and loads the model once per instance;
    // calls made meanwhile share the same load.
    const loading = traced("embeddings.model_load", {}, loadExtractor);
    extractorPromise = loading;
    // A failed load is not kept: the next call loads again instead of
    // failing until the instance restarts (TD-01). Only this load is cleared,
    // never a newer one.
    loading.catch(() => {
      if (extractorPromise === loading) extractorPromise = null;
    });
  }
  return extractorPromise;
}

function toNumberArray(data: Float32Array | number[]): number[] {
  return Array.from(data);
}

/**
 * Local MiniLM embeddings — no API quota.
 * First call downloads the model (~23MB) into the transformers cache.
 */
export function embedTexts(texts: string[]): Promise<number[][]> {
  return traced("embeddings.embed", { texts: texts.length }, () => embedAll(texts));
}

async function embedAll(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const extractor = await getExtractor();
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const embedded = await Promise.all(
      batch.map(async (text) => {
        const truncated = text.length > 8000 ? text.slice(0, 8000) : text;
        const output = await extractor(truncated, {
          pooling: "mean",
          normalize: true,
        });
        const values = toNumberArray(output.data);
        if (values.length !== EMBEDDING_DIMENSIONS) {
          throw new Error(
            `Unexpected embedding size ${values.length}; expected ${EMBEDDING_DIMENSIONS}`,
          );
        }
        return values;
      }),
    );
    results.push(...embedded);
  }

  return results;
}

export const onnxEmbedder: Embedder = {
  // Stored with each vector (TD-03): a different model, revision or dtype
  // makes different vectors, so they are not reused across a change.
  model: `${MODEL_ID}@${MODEL_REVISION}:${MODEL_DTYPE}`,
  embed: embedTexts,
};

/** Embed a single query string for similarity search. */
export async function embedQuery(text: string): Promise<number[]> {
  const [embedding] = await embedTexts([text]);
  return embedding;
}
