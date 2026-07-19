/**
 * src/db.ts
 *
 * Typed Supabase service-role client for U-I-OS.
 * Lazy-initialized so the build doesn't fail when env vars aren't present
 * at build time (Vercel injects them at runtime).
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

function getDbClient(): SupabaseClient {
  if (!_client) {
    const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
    _client = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }
  return _client;
}

export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_, prop, receiver) {
    return Reflect.get(getDbClient(), prop, receiver);
  },
});
