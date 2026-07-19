/**
 * Server-side Supabase client (anon key + the request's auth cookies).
 *
 * Built with @supabase/ssr's createServerClient so it reads the session that
 * the browser stored in cookies. Use it in Server Components / Route Handlers
 * to get the CURRENT logged-in session — e.g. to feed resolveOrgFromSession.
 *
 * SCOPE OF THIS CLIENT:
 *   - It is an ANON/authenticated client (carries the user's JWT from cookies).
 *     It is the right tool to ASK "who is logged in?".
 *   - It is NOT the tool for reading tenant data as trusted backend code. Those
 *     reads use the service-role client (src/db.ts), scoped by the org_id that
 *     resolveOrgFromSession returns. Do not fetch inbound_payloads / audit logs
 *     through this client expecting it to bypass RLS — it won't.
 */

import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

/**
 * Create a request-scoped server client bound to the current cookies.
 * `cookies()` is async in Next 15+/16, hence this is async.
 */
export async function supabaseServer(): Promise<SupabaseClient> {
  const cookieStore = await cookies();

  return createServerClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        // In a Server Component render, cookies are read-only and this throws.
        // That's expected/safe to ignore: session refresh happens in route
        // handlers / middleware where writing IS allowed. We only need reads
        // here.
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
