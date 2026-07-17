"use client";
/**
 * ReportPanel — "Generate Report" + "Email to client" UI for a completed
 * payload. Mirrors AutoRefresh/ActionsPanel's poll-based pattern: POST kicks
 * off generation, then a short interval GETs /api/payloads/[id]/report until
 * the report reaches a terminal status. org_id is never sent — the API
 * resolves it from the session.
 */
import { useCallback, useEffect, useRef, useState } from "react";

const POLL_MS = 3000;

interface ReportState {
  id: string;
  status: "generating" | "ready" | "failed";
  downloadUrl?: string;
}

export default function ReportPanel({ payloadId, payloadStatus }: { payloadId: string; payloadStatus: string }) {
  const [report, setReport] = useState<ReportState | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/payloads/${payloadId}/report`, { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { id: string; status: ReportState["status"]; downloadUrl?: string };
      if (mounted.current) setReport({ id: json.id, status: json.status, downloadUrl: json.downloadUrl });
    } catch {
      /* transient — next poll retries */
    }
  }, [payloadId]);

  useEffect(() => {
    if (!report || report.status !== "generating") return;
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  }, [report, poll]);

  // Pick up an in-flight or already-generated report on first render.
  useEffect(() => {
    poll();
  }, [poll]);

  async function generate() {
    setBusy(true);
    try {
      const res = await fetch(`/api/payloads/${payloadId}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(email.trim() ? { recipientEmail: email.trim() } : {}),
      });
      const json = (await res.json()) as { reportId: string; ok: boolean };
      if (mounted.current) setReport({ id: json.reportId, status: "generating" });
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  if (payloadStatus !== "completed") return null;

  return (
    <section style={{ marginTop: "2rem" }}>
      <h2 style={{ fontSize: "1.05rem", margin: "0 0 0.75rem" }}>Client report</h2>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="email"
          placeholder="Email to client (optional)"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ padding: "0.45rem 0.6rem", borderRadius: 6, border: "1px solid #ccc", fontSize: "0.85rem", minWidth: 220 }}
        />
        <button
          disabled={busy || report?.status === "generating"}
          onClick={generate}
          style={{ background: "#0f172a", color: "#fff", border: 0, borderRadius: 6, padding: "0.5rem 1rem", cursor: "pointer", fontSize: "0.85rem" }}
        >
          {report?.status === "generating" ? "Generating…" : "Generate Report"}
        </button>
        {report?.status === "ready" && report.downloadUrl && (
          <a
            href={report.downloadUrl}
            style={{ color: "#0366d6", fontSize: "0.85rem", fontWeight: 600 }}
          >
            Download PDF
          </a>
        )}
        {report?.status === "failed" && <span style={{ color: "#b00020", fontSize: "0.85rem" }}>Report generation failed.</span>}
      </div>
    </section>
  );
}
