import { randomUUID } from "node:crypto";

/**
 * Keys of browser uploads (ADR-011). The user id comes from the session and
 * the rest is random: a client never names an object, and a key proves
 * whose upload it is.
 */
export const UPLOADS_PREFIX = "uploads/";

const KEY_PATTERN =
  /^uploads\/[0-9a-f-]{36}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.zip$/;

export function newUploadKey(userId: string): string {
  return `${UPLOADS_PREFIX}${userId}/${randomUUID()}.zip`;
}

/** True only for a well-formed key under this user's own prefix. */
export function isOwnUploadKey(userId: string, key: string): boolean {
  return KEY_PATTERN.test(key) && key.startsWith(`${UPLOADS_PREFIX}${userId}/`);
}
