"use client";

/**
 * /dashboard/settings/org — org name, tier, created date + rename form.
 */
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";

interface OrgSettings {
  name: string;
  subscription_tier: string;
  created_at: string;
  members: { id: string; role: string; created_at: string }[];
}

export default function OrgSettingsPage() {
  const [settings, setSettings] = useState<OrgSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/org/settings", { cache: "no-store" });
      const body = await res.json();
      if (res.ok) {
        setSettings(body);
        setName(body.name);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleRename(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/org/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error ?? "Could not rename organization.");
        return;
      }
      setSaved(true);
      await load();
    } catch {
      setError("Network error renaming organization.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <main style={styles.main}>Loading…</main>;
  if (!settings) return <main style={styles.main}>Could not load organization settings.</main>;

  return (
    <main style={styles.main}>
      <h1 style={styles.heading}>Organization settings</h1>

      <dl style={styles.dl}>
        <dt style={styles.dt}>Subscription tier</dt>
        <dd style={styles.dd}>{settings.subscription_tier}</dd>
        <dt style={styles.dt}>Created</dt>
        <dd style={styles.dd}>{new Date(settings.created_at).toLocaleString()}</dd>
      </dl>

      <form onSubmit={handleRename} style={styles.form}>
        <label style={styles.label}>
          Organization name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            style={styles.input}
          />
        </label>
        <button type="submit" disabled={saving} style={styles.button}>
          {saving ? "Saving…" : "Rename"}
        </button>
        {saved && <span style={styles.saved}>Saved.</span>}
      </form>
      {error && <p style={styles.error}>{error}</p>}

      <p style={styles.teamLink}>
        <Link href="/dashboard/settings/team">Manage team members →</Link>
      </p>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: { maxWidth: 600, margin: "0 auto", padding: "2.5rem 1.5rem", fontFamily: "system-ui, sans-serif" },
  heading: { fontSize: "1.3rem", marginBottom: "1.5rem" },
  dl: { display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.4rem 1rem", marginBottom: "2rem", fontSize: "0.9rem" },
  dt: { color: "#666" },
  dd: { margin: 0 },
  form: { display: "flex", alignItems: "flex-end", gap: "0.75rem" },
  label: { display: "flex", flexDirection: "column", gap: "0.35rem", fontSize: "0.9rem" },
  input: { padding: "0.55rem 0.65rem", fontSize: "1rem", border: "1px solid #ccc", borderRadius: 6, minWidth: 260 },
  button: { padding: "0.6rem 1rem", fontSize: "0.9rem", borderRadius: 6, border: "none", background: "#111", color: "#fff", cursor: "pointer" },
  saved: { color: "#1a7f37", fontSize: "0.85rem" },
  error: { color: "#b00020", fontSize: "0.9rem" },
  teamLink: { marginTop: "2rem", fontSize: "0.9rem" },
};
