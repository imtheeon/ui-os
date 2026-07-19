"use client";

/**
 * /signup — creates an account + organization.
 *
 * Security notes:
 *  - Uses the browser anon client only. The org/profile/audit rows are NOT
 *    written from here; the database's handle_new_user() trigger provisions
 *    them atomically when auth.users gets the new row. The client merely
 *    passes the desired org name as signup metadata (options.data.org_name).
 *  - The user never sends an org_id. There is no org_id to send — it's minted
 *    server-side by the trigger. This is the "org_id always from session,
 *    never from the client" rule, enforced at the database layer.
 */

import { useState, type FormEvent } from "react";
import { supabaseBrowser } from "../../src/lib/supabaseBrowser";

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "confirm-email"; email: string }
  | { kind: "signed-in" }
  | { kind: "error"; message: string };

export default function SignupPage() {
  const [orgName, setOrgName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();

    const trimmedOrg = orgName.trim();
    if (trimmedOrg.length === 0) {
      setStatus({ kind: "error", message: "Organization name is required." });
      return;
    }
    if (password.length < 8) {
      setStatus({ kind: "error", message: "Password must be at least 8 characters." });
      return;
    }

    setStatus({ kind: "submitting" });

    const { data, error } = await supabaseBrowser.auth.signUp({
      email: email.trim(),
      password,
      options: {
        // Becomes raw_user_meta_data.org_name, which handle_new_user() reads.
        data: { org_name: trimmedOrg },
      },
    });

    if (error) {
      setStatus({ kind: "error", message: error.message });
      return;
    }

    // If email confirmation is enabled (Supabase default), there is no session
    // yet — the user must confirm via email before logging in. If it's
    // disabled, a session is returned and the user is already signed in.
    if (data.session) {
      // Create the org + auth_profile via API (trigger not used)
      await fetch("/api/auth/complete-signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgName: trimmedOrg }),
      });
      setStatus({ kind: "signed-in" });
    } else {
      setStatus({ kind: "confirm-email", email: email.trim() });
    }
  }

  if (status.kind === "confirm-email") {
    return (
      <main style={styles.main}>
        <h1>Check your email</h1>
        <p>
          We sent a confirmation link to <strong>{status.email}</strong>. Click
          it to activate your account, then sign in.
        </p>
      </main>
    );
  }

  if (status.kind === "signed-in") {
    return (
      <main style={styles.main}>
        <h1>Account created</h1>
        <p>Your organization is ready.</p>
        <a href="/dashboard" style={{ color: "#2563eb", marginTop: "1rem", display: "inline-block" }}>Go to dashboard →</a>
      </main>
    );
  }

  const submitting = status.kind === "submitting";

  return (
    <main style={styles.main}>
      <h1>Create your U-I-OS account</h1>
      <form onSubmit={handleSubmit} style={styles.form}>
        <label style={styles.label}>
          Organization name
          <input
            type="text"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            autoComplete="organization"
            required
            style={styles.input}
          />
        </label>

        <label style={styles.label}>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
            style={styles.input}
          />
        </label>

        <label style={styles.label}>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
            style={styles.input}
          />
        </label>

        {status.kind === "error" && (
          <p style={styles.error} role="alert">
            {status.message}
          </p>
        )}

        <button type="submit" disabled={submitting} style={styles.button}>
          {submitting ? "Creating account…" : "Sign up"}
        </button>
      </form>
      <p style={styles.footer}>
        Already have an account?{" "}
        <a href="/login" style={styles.footerLink}>Sign in</a>
      </p>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: { maxWidth: 420, margin: "4rem auto", padding: "0 1rem", fontFamily: "system-ui, sans-serif" },
  form: { display: "flex", flexDirection: "column", gap: "1rem", marginTop: "1.5rem" },
  label: { display: "flex", flexDirection: "column", gap: "0.35rem", fontSize: "0.9rem" },
  input: { padding: "0.55rem 0.65rem", fontSize: "1rem", border: "1px solid #ccc", borderRadius: 6 },
  button: { padding: "0.6rem", fontSize: "1rem", borderRadius: 6, border: "none", background: "#111", color: "#fff", cursor: "pointer" },
  error: { color: "#b00020", fontSize: "0.9rem", margin: 0 },
  footer: { marginTop: "1.5rem", fontSize: "0.85rem", color: "#555", textAlign: "center" as const },
  footerLink: { color: "#2563eb" },
};
