/**
 * /dashboard — server component proving the full identity chain:
 *   cookies → supabaseServer session → resolveOrgFromSession (verifies token)
 *           → trusted org_id → service-role read SCOPED to that org.
 *
 * No "use client": this renders on the server only, so importing the
 * service-role client here is safe (never shipped to the browser).
 */

import { redirect } from "next/navigation";
import { supabaseServer } from "../../src/lib/supabaseServer";
import { resolveOrgFromSession } from "../../src/lib/resolveOrgFromSession";
import { supabase as serviceClient } from "../../src/db";
import UploadPanel from "./UploadPanel";
import ActionsPanel from "./ActionsPanel";

export default async function DashboardPage() {
  // Read the session the browser stored in cookies.
  const supabase = await supabaseServer();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  // THE chokepoint. It re-verifies the access token internally (getUser), so
  // we deliberately do NOT trust getSession()'s contents here — the resolver
  // is the trust boundary, not getSession.
  const orgId = await resolveOrgFromSession(session);
  if (!orgId) redirect("/login"); // not signed in / no trusted org → bounce

  // Service-role read, SCOPED to the resolved org. `organizations` is keyed by
  // `id` (the row IS the tenant), so we scope with .eq("id", orgId). Tenant
  // child tables (inbound_payloads, system_audit_logs) would use
  // .eq("org_id", orgId) — the load-bearing scoping invariant.
  const { data: org, error } = await serviceClient
    .from("organizations")
    .select("name, subscription_tier")
    .eq("id", orgId)
    .maybeSingle();

  if (error || !org) redirect("/login"); // resolved but unreadable → fail closed

  return (
    <main style={styles.main}>
      <h1>Hello, {org.name}</h1>
      <p>
        Subscription tier: <strong>{org.subscription_tier}</strong>
      </p>
      <p style={styles.meta}>org_id (resolved server-side): {orgId}</p>

      <section style={{ marginTop: "2.5rem" }}>
        <h2 style={{ fontSize: "1.1rem" }}>Upload data</h2>
        <UploadPanel />
      </section>

      <section style={{ marginTop: "2.5rem" }}>
        <h2 style={{ fontSize: "1.1rem" }}>Proposals awaiting approval</h2>
        <ActionsPanel />
      </section>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: { maxWidth: 560, margin: "4rem auto", padding: "0 1rem", fontFamily: "system-ui, sans-serif" },
  meta: { color: "#666", fontSize: "0.8rem", marginTop: "2rem", wordBreak: "break-all" },
};
