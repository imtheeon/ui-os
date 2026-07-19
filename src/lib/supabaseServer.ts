/**
 * Server-side Supabase client (anon key + the request's auth cookies).
 * URL/key are read inside the function so this module can be imported
 * during build without throwing.
 */

import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

export async function supabaseServer(): Promise<SupabaseClient> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://zmntyhnmhzgtgwujhedf.supabase.co";
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InptbnR5aG5taHpndGd3dWpoZWRmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwNzMzNjEsImV4cCI6MjA5NzY0OTM2MX0.XN2_sgMwfTp-zTjgGZGukrYFajTOamg8dc5RwW66-k0";
  const cookieStore = await cookies();

  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          /* read-only context — ignore */
        }
      },
    },
  });
}
