import "server-only";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";

/**
 * Neon Object Storage (ADR-011): S3-compatible and branch-scoped, so the
 * preview and production buckets and credentials are separate. Read from
 * our own NEON_STORAGE_* names, never the AWS_* ones Vercel may inject into
 * a function. Without them (local dev, CI) the app keeps the in-request
 * ZIP upload, limited to 4 MB.
 */
export type StorageConfig = {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

export function storageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig | null {
  const config = {
    endpoint: env.NEON_STORAGE_ENDPOINT,
    region: env.NEON_STORAGE_REGION,
    accessKeyId: env.NEON_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.NEON_STORAGE_SECRET_ACCESS_KEY,
    bucket: env.NEON_STORAGE_BUCKET,
  };
  return Object.values(config).every(Boolean) ? (config as StorageConfig) : null;
}

function client(config: StorageConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    forcePathStyle: true, // Neon only supports path-style addressing
  });
}

/** Where the browser may upload from: this deployment's own origins. */
export function uploadOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const origins = new Set<string>();
  for (const url of [env.NEXT_PUBLIC_APP_URL, env.AUTH_URL]) {
    if (url) origins.add(new URL(url).origin);
  }
  for (const host of [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL]) {
    if (host) origins.add(`https://${host}`);
  }
  if (env.NODE_ENV === "development") origins.add("http://localhost:3000");
  return [...origins];
}

let corsApplied = false;

/**
 * Lets this deployment's origins POST to the bucket from the browser
 * (uploads only, nothing else). Once per instance: idempotent, and the
 * bucket of a Neon branch serves one environment.
 */
async function ensureUploadCors(config: StorageConfig): Promise<void> {
  if (corsApplied) return;
  await client(config).send(
    new PutBucketCorsCommand({
      Bucket: config.bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: uploadOrigins(),
            AllowedMethods: ["POST"],
            AllowedHeaders: ["*"],
            MaxAgeSeconds: 600,
          },
        ],
      },
    }),
  );
  corsApplied = true;
}

/**
 * A short-lived POST the browser sends the file with. The size range and the
 * content type are part of the signed policy: the bucket refuses anything
 * else, whatever the browser claims.
 */
export async function presignedUpload(config: StorageConfig, key: string, maxBytes: number) {
  await ensureUploadCors(config);
  return createPresignedPost(client(config), {
    Bucket: config.bucket,
    Key: key,
    Conditions: [
      ["content-length-range", 1, maxBytes],
      ["eq", "$Content-Type", "application/zip"],
    ],
    Fields: { "Content-Type": "application/zip" },
    Expires: 300,
  });
}

/** Size of an uploaded object, or null when it does not exist. */
export async function objectSize(config: StorageConfig, key: string): Promise<number | null> {
  try {
    const head = await client(config).send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
    return head.ContentLength ?? null;
  } catch (error) {
    if (error instanceof Error && (error.name === "NotFound" || error.name === "NoSuchKey")) {
      return null;
    }
    throw error;
  }
}

export async function readObject(config: StorageConfig, key: string): Promise<Buffer> {
  const response = await client(config).send(
    new GetObjectCommand({ Bucket: config.bucket, Key: key }),
  );
  return Buffer.from((await response.Body?.transformToByteArray()) ?? new Uint8Array());
}

export async function deleteObject(config: StorageConfig, key: string): Promise<void> {
  await client(config).send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
}

/**
 * Keys under `prefix` last written before `olderThan` (at most `limit`).
 * Neon does not run lifecycle rules: the daily reaper deletes abandoned
 * uploads with this.
 */
export async function staleObjects(
  config: StorageConfig,
  prefix: string,
  olderThan: Date,
  limit: number,
): Promise<string[]> {
  const stale: string[] = [];
  let token: string | undefined;
  do {
    const page = await client(config).send(
      new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const object of page.Contents ?? []) {
      if (object.Key && object.LastModified && object.LastModified < olderThan) stale.push(object.Key);
      if (stale.length >= limit) return stale;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return stale;
}
