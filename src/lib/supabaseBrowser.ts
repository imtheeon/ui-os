/**
 * Browser Supabase client — lazy so it doesn't crash at build time.
 */

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

function getBrowserClient(): SupabaseClient {
  if (!_client) {
    _client = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ""
    );
  }
  return _client;
}

export const supabaseBrowser: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_, prop, receiver) {
    return Reflect.get(getBrowserClient(), prop, receiver);
  },
});
