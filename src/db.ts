/**
 * src/db.ts
 *
 * Typed Supabase service-role client for U-I-OS.
 *
 * This client uses the SERVICE_ROLE key, which bypasses Row-Level Security.
 * It must only be used in trusted backend contexts (server-side handlers,
 * background workers, cron jobs) — never exposed to a browser or shipped
 * in client-side code. Any code path that handles untrusted tenant input
 * is responsible for setting `app.current_org_id` via
 * `set_config('app.current_org_id', orgId, true)` before issuing queries
 * if it wants RLS-equivalent scoping enforced at the application layer.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import "dotenv/config";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    "[ui-os/db] Missing required environment variable(s): " +
      [
        !SUPABASE_URL ? "SUPABASE_URL" : null,
        !SUPABASE_SERVICE_ROLE_KEY ? "SUPABASE_SERVICE_ROLE_KEY" : null,
      ]
        .filter(Boolean)
        .join(", ") +
      ". Copy .env.example to .env and populate these values before " +
      "starting the service. Refusing to continue with an unconfigured " +
      "database client."
  );
}

export const supabase: SupabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);
