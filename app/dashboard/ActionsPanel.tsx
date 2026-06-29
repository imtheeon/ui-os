"use client";
/**
 * ActionsPanel — poll-based approval UI for the Ruflo swarm's pending proposals.
 * Lists each proposal (kind, rationale, bounded action_payload) with Approve /
 * Reject. org_id is never sent — the API resolves it from the session.
 * Polling now; Realtime deferred (per Phase 5 precedent).
 */
import { useCallback, useEffect, useRef, useState } from "react";

const POLL_MS = 4000;

interface PendingAction {
  id: string;
  kind: string;
  rationale: string;
  action_payload: Record<string, unknown>;
  created_at: string;
}

export default function ActionsPanel() {
  const [items, setItems] = useState<PendingAction[]>([]);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/actions?status=pending", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { items: PendingAction[] };
      if (mounted.current) setItems(json.items ?? []);
    } catch { /* transient — next poll retries */ }
  }, []);

  useEffect(() => {
    mounted.current = true;
    load();
    const t = setInterval(load, POLL_MS);
    return () => { mounted.current = false; clearInterval(t); };
  }, [load]);

  async function decide(id: string, verb: "approve" | "reject") {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const res = await fetch(`/api/actions/${id}/${verb}`, { method: "POST" });
      if (res.ok && mounted.current) setItems((xs) => xs.filter((x) => x.id !== id));
    } finally {
      if (mounted.current) setBusy((b) => ({ ...b, [id]: false }));
    }
  }

  if (items.length === 0) {
    return <p style={{ color: "#666", fontSize: "0.9rem" }}>No proposals awaiting approval.</p>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      {items.map((a) => (
        <div key={a.id} style={card}>
          <div style={{ fontWeight: 600 }}>{a.kind}</div>
          <div style={{ color: "#444", fontSize: "0.85rem", margin: "0.25rem 0" }}>{a.rationale}</div>
          <pre style={pre}>{JSON.stringify(a.action_payload, null, 2)}</pre>
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
            <button disabled={busy[a.id]} onClick={() => decide(a.id, "approve")} style={approveBtn}>Approve</button>
            <button disabled={busy[a.id]} onClick={() => decide(a.id, "reject")} style={rejectBtn}>Reject</button>
          </div>
        </div>
      ))}
    </div>
  );
}

const card: React.CSSProperties = { border: "1px solid #ddd", borderRadius: 8, padding: "0.75rem" };
const pre: React.CSSProperties = { background: "#f7f7f7", padding: "0.5rem", borderRadius: 6, fontSize: "0.75rem", overflowX: "auto", margin: 0 };
const approveBtn: React.CSSProperties = { background: "#137333", color: "#fff", border: 0, borderRadius: 6, padding: "0.4rem 0.9rem", cursor: "pointer" };
const rejectBtn: React.CSSProperties = { background: "#b3261e", color: "#fff", border: 0, borderRadius: 6, padding: "0.4rem 0.9rem", cursor: "pointer" };
