/**
 * src/lib/resolveOrgFromSession.ts
 *
 * ════════════════════════════════════════════════════════════════════════
 * THE org_id CHOKEPOINT.
 *
 * This is the ONLY authorized way to translate auth identity → org_id in
 * server-trusted code. The bouncer (tier-gate), agent handlers, and any RLS
 * context-setters all call THIS — never auth or the profiles table directly.
 * One function = one place to audit, reason about, and harden the identity→
 * tenant mapping.
 *
 * ⚠️ LOAD-BEARING SECURITY INVARIANT — READ BEFORE USING THE RETURN VALUE:
 * After calling this, every subsequent query MUST be scoped with
 * `.eq('org_id', returnedOrgId)`. The resolver does NOT magically scope
 * queries; it produces a trusted org_id. Forgetting to scope = tenant data
 * leak.
 * ════════════════════════════════════════════════════════════════════════
 *
 * Trust model:
 *   - We NEVER trust `session.user.id` from the passed-in object — a Session
 *     is just data and could be forged. We re-verify the access token with
 *     `auth.getUser(access_token)`, which validates the JWT against Supabase
 *     Auth, and use the user id IT returns.
 *   - Fails closed on EVERY error path (no session, no token, expired/invalid
 *     token, no profile row, DB error) → returns `null`. A `null` return means
 *     "no trusted org" — callers must treat it as unauthenticated and refuse
 *     to proceed.
 *
 * Returns ONLY the org_id string (or null). No name, no tier, no extras —
 * callers do their own service-role lookups scoped by the returned org_id.
 */

import type { Session, SupabaseClient } from "@supabase/supabase-js";

export interface ResolveOrgDeps {
  /**
   * Service-role Supabase client. Used to (a) verify the access token via
   * auth.getUser and (b) read profiles.org_id (bypassing RLS). Defaults to the
   * shared client in src/db.ts, resolved lazily so this module doesn't trip
   * db.ts's import-time env guard in standalone scripts.
   */
  db: SupabaseClient;
}

export async function resolveOrgFromSession(
  session: Session | null | undefined,
  deps?: Partial<ResolveOrgDeps>
): Promise<string | null> {
  // Fail closed: no session / no token to verify.
  if (!session?.access_token) return null;

  const db: SupabaseClient = deps?.db ?? (await import("../db")).supabase;

  // ── Verify the token. Do NOT trust session.user.id. ─────────────────────
  let verifiedUserId: string;
  try {
    const { data, error } = await db.auth.getUser(session.access_token);
    if (error || !data?.user) return null; // invalid / expired → fail closed
    verifiedUserId = data.user.id;
  } catch {
    return null; // auth server hiccup → fail closed
  }

  // ── Look up the profile's org_id (service-role; scoped to THIS user). ────
  try {
    const { data, error } = await db
      .from("profiles")
      .select("org_id")
      .eq("id", verifiedUserId)
      .maybeSingle();
    if (error || !data?.org_id) return null; // no profile / DB error → null
    return data.org_id as string;
  } catch {
    return null; // DB hiccup → fail closed
  }
}
