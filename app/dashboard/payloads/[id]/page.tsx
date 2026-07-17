/**
 * /dashboard/payloads/[id] — payload detail: header, agent runs, proposed
 * actions. Queries mirror /api/payloads/[id] and /api/payloads/[id]/results
 * directly (same org-scoped shape) rather than the page fetching its own API
 * over HTTP, consistent with the rest of the dashboard's server components.
 */
import { redirect, notFound } from "next/navigation";
import { supabaseServer } from "../../../../src/lib/supabaseServer";
import { resolveOrgFromSession } from "../../../../src/lib/resolveOrgFromSession";
import { supabase as serviceClient } from "../../../../src/db";
import AutoRefresh from "../AutoRefresh";
import ReportPanel from "../ReportPanel";

interface AgentRun {
  id: string;
  role: string;
  status: string;
  created_at: string;
  finished_at: string | null;
}

interface ProposedAction {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  status: string;
  agent_run_id: string;
  created_at: string;
}

export default async function PayloadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: payloadId } = await params;

  const supabase = await supabaseServer();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const orgId = await resolveOrgFromSession(session);
  if (!orgId) redirect("/login");

  const { data: payload, error: payloadErr } = await serviceClient
    .from("inbound_payloads")
    .select("id, status, scan_status, source, created_at, size_bytes, original_filename")
    .eq("id", payloadId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (payloadErr) redirect("/login");
  if (!payload) notFound();

  const [{ data: agentRuns, error: runsErr }, { data: proposedActions, error: actionsErr }] =
    await Promise.all([
      serviceClient
        .from("agent_runs")
        .select("id, role, status, created_at, finished_at")
        .eq("payload_id", payloadId)
        .eq("org_id", orgId)
        .order("created_at", { ascending: true }),
      serviceClient
        .from("proposed_actions")
        .select("id, kind, payload:action_payload, status, agent_run_id, created_at")
        .eq("payload_id", payloadId)
        .eq("org_id", orgId)
        .order("created_at", { ascending: true }),
    ]);

  if (runsErr || actionsErr) redirect("/login");

  const runs = (agentRuns ?? []) as AgentRun[];
  const actions = (proposedActions ?? []) as unknown as ProposedAction[];

  return (
    <main style={styles.main}>
      <AutoRefresh status={payload.status} />

      <h1 style={styles.heading}>{payload.original_filename ?? payload.id}</h1>
      <dl style={styles.meta}>
        <dt>ID</dt>
        <dd style={styles.mono}>{payload.id}</dd>
        <dt>Source</dt>
        <dd>{payload.source}</dd>
        <dt>Status</dt>
        <dd>{payload.status}</dd>
        <dt>Scan status</dt>
        <dd>{payload.scan_status ?? "—"}</dd>
        <dt>Size</dt>
        <dd>{payload.size_bytes != null ? `${(payload.size_bytes / 1024).toFixed(1)} KB` : "—"}</dd>
        <dt>Created</dt>
        <dd>{new Date(payload.created_at).toLocaleString()}</dd>
      </dl>

      <section style={styles.section}>
        <h2 style={styles.subheading}>Agent runs</h2>
        {runs.length === 0 ? (
          <p style={styles.empty}>No agent runs yet.</p>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Role</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Latency</th>
                <th style={styles.th}>Created</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td style={styles.td}>{r.role}</td>
                  <td style={styles.td}>{r.status}</td>
                  <td style={styles.td}>
                    {r.finished_at
                      ? `${new Date(r.finished_at).getTime() - new Date(r.created_at).getTime()}ms`
                      : "—"}
                  </td>
                  <td style={styles.td}>{new Date(r.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={styles.section}>
        <h2 style={styles.subheading}>Proposed actions</h2>
        {actions.length === 0 ? (
          <p style={styles.empty}>No proposed actions yet.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {actions.map((a) => (
              <div key={a.id} style={styles.card}>
                <div style={styles.cardHead}>
                  <span style={{ fontWeight: 600 }}>{a.kind}</span>
                  <span style={styles.statusTag}>{a.status}</span>
                </div>
                <pre style={styles.pre}>{JSON.stringify(a.payload, null, 2)}</pre>
              </div>
            ))}
          </div>
        )}
      </section>

      <ReportPanel payloadId={payload.id} payloadStatus={payload.status} />
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: { maxWidth: 800, margin: "0 auto", padding: "2.5rem 1.5rem", fontFamily: "system-ui, sans-serif" },
  heading: { fontSize: "1.3rem", margin: "0 0 1rem", wordBreak: "break-all" },
  meta: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    columnGap: "1rem",
    rowGap: "0.35rem",
    fontSize: "0.85rem",
    color: "#444",
    margin: "0 0 2rem",
  },
  mono: { fontFamily: "monospace", wordBreak: "break-all" },
  section: { marginTop: "2rem" },
  subheading: { fontSize: "1.05rem", margin: "0 0 0.75rem" },
  empty: { color: "#666", fontSize: "0.9rem" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" },
  th: { textAlign: "left", padding: "0.5rem 0.75rem", borderBottom: "1px solid #e2e2e2", color: "#666", fontWeight: 600 },
  td: { padding: "0.5rem 0.75rem", borderBottom: "1px solid #f0f0f0" },
  card: { border: "1px solid #e2e2e2", borderRadius: 8, padding: "0.75rem" },
  cardHead: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  statusTag: { fontSize: "0.75rem", color: "#666" },
  pre: { background: "#f7f7f7", padding: "0.5rem", borderRadius: 6, fontSize: "0.75rem", overflowX: "auto", margin: "0.5rem 0 0" },
};
