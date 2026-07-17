/**
 * /dashboard/reports — report generation history for the caller's org.
 *
 * Same trust chain as the rest of the dashboard: session -> resolveOrgFromSession
 * (verified) -> trusted org_id -> service-role read scoped by .eq("org_id", orgId).
 * Download links are generated client-side on demand (DownloadLink) rather
 * than server-rendered, since signed URLs are short-lived.
 */
import { redirect } from "next/navigation";
import Link from "next/link";
import { supabaseServer } from "../../../src/lib/supabaseServer";
import { resolveOrgFromSession } from "../../../src/lib/resolveOrgFromSession";
import { supabase as serviceClient } from "../../../src/db";
import DownloadLink from "./DownloadLink";

interface ReportRow {
  id: string;
  title: string;
  payload_id: string;
  status: string;
  created_at: string;
  emailed_at: string | null;
}

export default async function ReportsPage() {
  const supabase = await supabaseServer();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const orgId = await resolveOrgFromSession(session);
  if (!orgId) redirect("/login");

  const { data: reports, error } = await serviceClient
    .from("reports")
    .select("id, title, payload_id, status, created_at, emailed_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) redirect("/login");

  const rows = (reports ?? []) as ReportRow[];

  return (
    <main style={styles.main}>
      <h1 style={styles.heading}>Reports</h1>

      {rows.length === 0 ? (
        <p style={styles.empty}>No reports generated yet.</p>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Title</th>
              <th style={styles.th}>Payload</th>
              <th style={styles.th}>Status</th>
              <th style={styles.th}>Created</th>
              <th style={styles.th}>Emailed</th>
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={styles.td}>{r.title}</td>
                <td style={styles.td}>
                  <Link href={`/dashboard/payloads/${r.payload_id}`} style={styles.idLink}>
                    {r.payload_id.slice(0, 8)}
                  </Link>
                </td>
                <td style={styles.td}>{r.status}</td>
                <td style={styles.td}>{new Date(r.created_at).toLocaleString()}</td>
                <td style={styles.td}>{r.emailed_at ? new Date(r.emailed_at).toLocaleString() : "—"}</td>
                <td style={styles.td}>{r.status === "ready" ? <DownloadLink reportId={r.id} payloadId={r.payload_id} /> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: { maxWidth: 960, margin: "0 auto", padding: "2.5rem 1.5rem", fontFamily: "system-ui, sans-serif" },
  heading: { fontSize: "1.3rem", margin: "0 0 1.5rem" },
  empty: { color: "#666", fontSize: "0.9rem" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" },
  th: { textAlign: "left", padding: "0.5rem 0.75rem", borderBottom: "1px solid #e2e2e2", color: "#666", fontWeight: 600 },
  td: { padding: "0.5rem 0.75rem", borderBottom: "1px solid #f0f0f0" },
  idLink: { color: "#0366d6", textDecoration: "none", fontFamily: "monospace" },
};
