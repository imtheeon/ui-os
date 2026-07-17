/**
 * /dashboard/payloads — 20 most recent inbound_payloads for the caller's org.
 *
 * Same trust chain as /dashboard: session → resolveOrgFromSession (verified)
 * → trusted org_id → service-role read scoped by .eq("org_id", orgId).
 */
import { redirect } from "next/navigation";
import Link from "next/link";
import { supabaseServer } from "../../../src/lib/supabaseServer";
import { resolveOrgFromSession } from "../../../src/lib/resolveOrgFromSession";
import { supabase as serviceClient } from "../../../src/db";

interface PayloadRow {
  id: string;
  source: string;
  status: string;
  created_at: string;
}

export default async function PayloadsPage() {
  const supabase = await supabaseServer();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const orgId = await resolveOrgFromSession(session);
  if (!orgId) redirect("/login");

  const { data: payloads, error } = await serviceClient
    .from("inbound_payloads")
    .select("id, source, status, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) redirect("/login");

  const rows = (payloads ?? []) as PayloadRow[];

  return (
    <main style={styles.main}>
      <h1 style={styles.heading}>Payloads</h1>

      {rows.length === 0 ? (
        <p style={styles.empty}>No payloads yet.</p>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>ID</th>
              <th style={styles.th}>Source</th>
              <th style={styles.th}>Status</th>
              <th style={styles.th}>Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const b = statusBadge(p.status);
              return (
                <tr key={p.id}>
                  <td style={styles.td}>
                    <Link href={`/dashboard/payloads/${p.id}`} style={styles.idLink}>
                      {p.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td style={styles.td}>{p.source}</td>
                  <td style={styles.td}>
                    <span style={{ ...styles.badge, color: b.color, borderColor: b.color }}>{b.label}</span>
                  </td>
                  <td style={styles.td}>{new Date(p.created_at).toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}

function statusBadge(status: string): { label: string; color: string } {
  switch (status) {
    case "pending":
      return { label: "Pending", color: "#888" };
    case "processing":
      return { label: "Processing", color: "#9a6700" };
    case "completed":
      return { label: "Completed", color: "#1a7f37" };
    case "failed":
      return { label: "Failed", color: "#b00020" };
    case "blocked_unauthorized_tier":
      return { label: "Blocked (tier)", color: "#b00020" };
    default:
      return { label: status, color: "#888" };
  }
}

const styles: Record<string, React.CSSProperties> = {
  main: { maxWidth: 960, margin: "0 auto", padding: "2.5rem 1.5rem", fontFamily: "system-ui, sans-serif" },
  heading: { fontSize: "1.3rem", margin: "0 0 1.5rem" },
  empty: { color: "#666", fontSize: "0.9rem" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" },
  th: { textAlign: "left", padding: "0.5rem 0.75rem", borderBottom: "1px solid #e2e2e2", color: "#666", fontWeight: 600 },
  td: { padding: "0.5rem 0.75rem", borderBottom: "1px solid #f0f0f0" },
  idLink: { color: "#0366d6", textDecoration: "none", fontFamily: "monospace" },
  badge: { fontSize: "0.72rem", border: "1px solid", borderRadius: 999, padding: "0.1rem 0.5rem", whiteSpace: "nowrap" },
};
