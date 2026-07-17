/**
 * src/lib/api-key.ts
 *
 * API key utilities for webhook authentication.
 *
 * Key format: uios_wh_<43 base64url chars>  (32 random bytes → ~43 chars)
 * Storage:    SHA-256 hex of the raw key is stored; raw key is never persisted.
 * Display:    The first 8 chars of the raw key (the "prefix") are stored for UI.
 *
 * verifyApiKey: given a raw key from the Authorization header, hash it,
 * look up the hash in org_api_keys, bump last_used_at, return orgId or null.
 */

import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

const KEY_PREFIX = "uios_wh_";

/** Generate a fresh API key. Returns { rawKey, keyHash, keyPrefix }. */
export function generateApiKey(): {
  rawKey: string;
  keyHash: string;
  keyPrefix: string;
} {
  const raw = KEY_PREFIX + randomBytes(32).toString("base64url");
  const hash = sha256hex(raw);
  const prefix = raw.slice(0, 8 + KEY_PREFIX.length); // "uios_wh_" + 8 chars
  return { rawKey: raw, keyHash: hash, keyPrefix: prefix };
}

export function sha256hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export interface VerifyApiKeyResult {
  orgId: string;
  keyId: string;
}

/**
 * Verify a raw key from the Authorization: Bearer header.
 * Returns the org_id and key id if valid, null if invalid.
 * Bumps last_used_at on success (best-effort — does not fail the request).
 *
 * Uses the SERVICE-ROLE client (src/db.ts) — looks up across all orgs by hash.
 * This is correct: the hash lookup MUST be cross-tenant to find the org.
 */
export async function verifyApiKey(
  rawKey: string,
  deps?: { db?: SupabaseClient }
): Promise<VerifyApiKeyResult | null> {
  if (!rawKey || !rawKey.startsWith(KEY_PREFIX)) return null;

  const db: SupabaseClient = deps?.db ?? (await import("../db")).supabase;
  const hash = sha256hex(rawKey);

  const { data, error } = await db
    .from("org_api_keys")
    .select("id, org_id")
    .eq("key_hash", hash)
    .maybeSingle();

  if (error || !data) return null;

  // Bump last_used_at best-effort (ignore failure — don't block the request).
  db.from("org_api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id)
    .then(
      () => {/* fire-and-forget */},
      () => {/* ignore */}
    );

  return { orgId: data.org_id as string, keyId: data.id as string };
}

/**
 * Extract the raw key from an Authorization: Bearer <key> header.
 * Returns null if the header is absent or malformed.
 */
export function extractBearerKey(
  authHeader: string | null | undefined
): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}
