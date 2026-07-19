/**
 * Browser Supabase client — lazy so it doesn't crash at build time.
 */

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

function getBrowserClient(): SupabaseClient {
  if (!_client) {
    _client = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "https://zmntyhnmhzgtgwujhedf.supabase.co",
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InptbnR5aG5taHpndGd3dWpoZWRmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwNzMzNjEsImV4cCI6MjA5NzY0OTM2MX0.XN2_sgMwfTp-zTjgGZGukrYFajTOamg8dc5RwW66-k0"
    );
  }
  return _client;
}

export const supabaseBrowser: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_, prop, receiver) {
    return Reflect.get(getBrowserClient(), prop, receiver);
  },
});
