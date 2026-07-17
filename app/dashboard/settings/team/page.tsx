"use client";

/**
 * /dashboard/settings/team — team member list + invite management.
 */
import { useEffect, useState, type FormEvent } from "react";

interface Member {
  id: string;
  role: string;
  created_at: string;
}

interface Invite {
  id: string;
  email: string;
  role: string;
  created_at: string;
  expires_at: string;
}

export default function TeamPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  async function load() {
    setLoading(true);
    try {
      const [membersRes, invitesRes] = await Promise.all([
        fetch("/api/org/settings", { cache: "no-store" }),
        fetch("/api/org/invites", { cache: "no-store" }),
      ]);
      const invitesBody = await invitesRes.json();
      if (invitesRes.ok) setInvites(invitesBody.invites ?? []);
      if (membersRes.ok) {
        const settingsBody = await membersRes.json();
        setMembers(settingsBody.members ?? []);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    setInviting(true);
    setError(null);
    try {
      const res = await fetch("/api/org/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error ?? "Could not create invite.");
        return;
      }
      setInviteUrl(body.inviteUrl);
      setEmail("");
      await load();
    } catch {
      setError("Network error creating invite.");
    } finally {
      setInviting(false);
    }
  }

  async function handleRevoke(inviteId: string) {
    setBusy((b) => ({ ...b, [inviteId]: true }));
    try {
      const res = await fetch(`/api/org/invites?inviteId=${encodeURIComponent(inviteId)}`, {
        method: "DELETE",
      });
      if (res.ok) setInvites((xs) => xs.filter((i) => i.id !== inviteId));
    } finally {
      setBusy((b) => ({ ...b, [inviteId]: false }));
    }
  }

  return (
    <main style={styles.main}>
      <h1 style={styles.heading}>Team</h1>

      <section style={styles.section}>
        <h2 style={styles.subheading}>Members</h2>
        {loading ? (
          <p style={styles.empty}>Loading…</p>
        ) : members.length === 0 ? (
          <p style={styles.empty}>No members found.</p>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>User</th>
                <th style={styles.th}>Role</th>
                <th style={styles.th}>Joined</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td style={styles.td}>{m.id}</td>
                  <td style={styles.td}>{m.role}</td>
                  <td style={styles.td}>{new Date(m.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={styles.section}>
        <h2 style={styles.subheading}>Invite a teammate</h2>
        <form onSubmit={handleInvite} style={styles.form}>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@company.com"
            required
            style={styles.input}
          />
          <button type="submit" disabled={inviting} style={styles.button}>
            {inviting ? "Inviting…" : "Invite"}
          </button>
        </form>
        {inviteUrl && (
          <div style={styles.revealBox}>
            <p style={styles.revealLabel}>Invite link (share this with your teammate):</p>
            <code style={styles.revealKey}>{inviteUrl}</code>
          </div>
        )}
        {error && <p style={styles.error}>{error}</p>}
      </section>

      <section style={styles.section}>
        <h2 style={styles.subheading}>Pending invites</h2>
        {invites.length === 0 ? (
          <p style={styles.empty}>No pending invites.</p>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Email</th>
                <th style={styles.th}>Role</th>
                <th style={styles.th}>Expires</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {invites.map((i) => (
                <tr key={i.id}>
                  <td style={styles.td}>{i.email}</td>
                  <td style={styles.td}>{i.role}</td>
                  <td style={styles.td}>{new Date(i.expires_at).toLocaleString()}</td>
                  <td style={styles.td}>
                    <button
                      disabled={busy[i.id]}
                      onClick={() => handleRevoke(i.id)}
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
      </section>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: { maxWidth: 800, margin: "0 auto", padding: "2.5rem 1.5rem", fontFamily: "system-ui, sans-serif" },
  heading: { fontSize: "1.3rem", marginBottom: "1.5rem" },
  section: { marginBottom: "2rem" },
  subheading: { fontSize: "1rem", marginBottom: "0.75rem" },
  form: { display: "flex", gap: "0.5rem", marginBottom: "1rem" },
  input: { flex: 1, padding: "0.5rem 0.65rem", fontSize: "0.9rem", border: "1px solid #ccc", borderRadius: 6 },
  button: { padding: "0.5rem 0.9rem", fontSize: "0.9rem", borderRadius: 6, border: "none", background: "#111", color: "#fff", cursor: "pointer" },
  error: { color: "#b00020", fontSize: "0.85rem" },
  empty: { color: "#666", fontSize: "0.9rem" },
  revealBox: { border: "1px solid #1a7f37", background: "#f0fff4", borderRadius: 8, padding: "0.9rem", marginBottom: "1rem" },
  revealLabel: { margin: "0 0 0.5rem", fontSize: "0.85rem", color: "#1a7f37", fontWeight: 600 },
  revealKey: { display: "block", fontFamily: "monospace", fontSize: "0.85rem", wordBreak: "break-all" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" },
  th: { textAlign: "left", padding: "0.5rem 0.75rem", borderBottom: "1px solid #e2e2e2", color: "#666", fontWeight: 600 },
  td: { padding: "0.5rem 0.75rem", borderBottom: "1px solid #f0f0f0" },
  revokeButton: { padding: "0.3rem 0.6rem", fontSize: "0.8rem", borderRadius: 6, border: "1px solid #b00020", color: "#b00020", background: "#fff", cursor: "pointer" },
};
