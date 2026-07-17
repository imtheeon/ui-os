"use client";

/**
 * /dashboard/api-keys — manage webhook API keys against /api/org/api-keys.
 * The raw key is only ever visible in the response to the create POST; it is
 * never stored or retrievable again, so the UI must surface it once and make
 * that permanence obvious to the user.
 */
import { useEffect, useState, type FormEvent } from "react";

interface ApiKey {
  id: string;
  key_prefix: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/org/api-keys", { cache: "no-store" });
      const body = await res.json();
      if (res.ok) setKeys(body.keys ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/org/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error ?? "Could not create key.");
        return;
      }
      setRevealedKey(body.rawKey);
      setName("");
      setShowCreate(false);
      await load();
    } catch {
      setError("Network error creating key.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(keyId: string) {
    setBusy((b) => ({ ...b, [keyId]: true }));
    try {
      const res = await fetch(`/api/org/api-keys?keyId=${encodeURIComponent(keyId)}`, {
        method: "DELETE",
      });
      if (res.ok) setKeys((xs) => xs.filter((k) => k.id !== keyId));
    } finally {
      setBusy((b) => ({ ...b, [keyId]: false }));
    }
  }

  return (
    <main style={styles.main}>
      <div style={styles.headerRow}>
        <h1 style={styles.heading}>API Keys</h1>
        <button style={styles.button} onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? "Cancel" : "Create key"}
        </button>
      </div>

      {revealedKey && (
        <div style={styles.revealBox}>
          <p style={styles.revealLabel}>
            New key — copy it now, it will not be shown again:
          </p>
          <code style={styles.revealKey}>{revealedKey}</code>
          <button style={styles.dismissButton} onClick={() => setRevealedKey(null)}>
            Dismiss
          </button>
        </div>
      )}

      {showCreate && (
        <form onSubmit={handleCreate} style={styles.form}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Key name (e.g. Zapier webhook)"
            required
            style={styles.input}
          />
          <button type="submit" disabled={creating} style={styles.button}>
            {creating ? "Creating…" : "Create"}
          </button>
        </form>
      )}
      {error && <p style={styles.error}>{error}</p>}

      {loading ? (
        <p style={styles.empty}>Loading…</p>
      ) : keys.length === 0 ? (
        <p style={styles.empty}>No API keys yet.</p>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Name</th>
              <th style={styles.th}>Prefix</th>
              <th style={styles.th}>Created</th>
              <th style={styles.th}>Last used</th>
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td style={styles.td}>{k.name}</td>
                <td style={{ ...styles.td, fontFamily: "monospace" }}>{k.key_prefix}…</td>
                <td style={styles.td}>{new Date(k.created_at).toLocaleString()}</td>
                <td style={styles.td}>
                  {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "Never"}
                </td>
                <td style={styles.td}>
                  <button
                    disabled={busy[k.id]}
                    onClick={() => handleRevoke(k.id)}
                    style={styles.revokeButton}
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: { maxWidth: 800, margin: "0 auto", padding: "2.5rem 1.5rem", fontFamily: "system-ui, sans-serif" },
  headerRow: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" },
  heading: { fontSize: "1.3rem", margin: 0 },
  button: { padding: "0.5rem 0.9rem", fontSize: "0.9rem", borderRadius: 6, border: "none", background: "#111", color: "#fff", cursor: "pointer" },
  form: { display: "flex", gap: "0.5rem", marginBottom: "1rem" },
  input: { flex: 1, padding: "0.5rem 0.65rem", fontSize: "0.9rem", border: "1px solid #ccc", borderRadius: 6 },
  error: { color: "#b00020", fontSize: "0.85rem" },
  empty: { color: "#666", fontSize: "0.9rem" },
  revealBox: { border: "1px solid #1a7f37", background: "#f0fff4", borderRadius: 8, padding: "0.9rem", marginBottom: "1.5rem" },
  revealLabel: { margin: "0 0 0.5rem", fontSize: "0.85rem", color: "#1a7f37", fontWeight: 600 },
  revealKey: { display: "block", fontFamily: "monospace", fontSize: "0.85rem", wordBreak: "break-all", marginBottom: "0.6rem" },
  dismissButton: { padding: "0.35rem 0.7rem", fontSize: "0.8rem", borderRadius: 6, border: "1px solid #ccc", background: "#fff", cursor: "pointer" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" },
  th: { textAlign: "left", padding: "0.5rem 0.75rem", borderBottom: "1px solid #e2e2e2", color: "#666", fontWeight: 600 },
  td: { padding: "0.5rem 0.75rem", borderBottom: "1px solid #f0f0f0" },
  revokeButton: { padding: "0.3rem 0.6rem", fontSize: "0.8rem", borderRadius: 6, border: "1px solid #b00020", color: "#b00020", background: "#fff", cursor: "pointer" },
};
