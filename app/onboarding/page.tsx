"use client";

/**
 * /onboarding — shown when a session has no org yet (see
 * app/api/auth/complete-signup/route.ts for why this is a fallback path,
 * not the primary org-creation flow).
 */
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export default function OnboardingPage() {
  const router = useRouter();
  const [orgName, setOrgName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = orgName.trim();
    if (!trimmed) {
      setError("Organization name is required.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/complete-signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgName: trimmed }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error ?? "Could not create organization.");
        return;
      }
      router.push("/dashboard");
    } catch {
      setError("Network error creating organization.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main style={styles.main}>
      <h1 style={styles.heading}>Welcome — let&apos;s set up your organization</h1>
      <form onSubmit={handleSubmit} style={styles.form}>
        <label style={styles.label}>
          What&apos;s your organization name?
          <input
            type="text"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            placeholder="Acme Inc."
            required
            style={styles.input}
          />
        </label>
        {error && (
          <p style={styles.error} role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={submitting} style={styles.button}>
          {submitting ? "Creating…" : "Continue"}
        </button>
      </form>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: { maxWidth: 420, margin: "4rem auto", padding: "0 1rem", fontFamily: "system-ui, sans-serif" },
  heading: { fontSize: "1.3rem" },
  form: { display: "flex", flexDirection: "column", gap: "1rem", marginTop: "1.5rem" },
  label: { display: "flex", flexDirection: "column", gap: "0.35rem", fontSize: "0.9rem" },
  input: { padding: "0.55rem 0.65rem", fontSize: "1rem", border: "1px solid #ccc", borderRadius: 6 },
  button: { padding: "0.6rem", fontSize: "1rem", borderRadius: 6, border: "none", background: "#111", color: "#fff", cursor: "pointer" },
  error: { color: "#b00020", fontSize: "0.9rem", margin: 0 },
};
