/**
 * Browser Supabase client using the anon/authenticated key.
 *
 * Uses @supabase/ssr's createBrowserClient (NOT the plain supabase-js
 * createClient) so the session is persisted in COOKIES rather than
 * localStorage. Cookies are sent with every request, which is what lets the
 * server (src/lib/supabaseServer.ts) read the logged-in session and resolve
 * the user's org server-side. localStorage is invisible to the server.
 *
 * Like before: anon key only, safe to ship to the browser. Tenant isolation
 * for any direct browser reads relies on Postgres RLS. Server-trusted reads go
 * through the service-role client (src/db.ts) scoped by resolveOrgFromSession.
 */

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export const supabaseBrowser: SupabaseClient = createBrowserClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);
