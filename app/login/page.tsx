"use client";

/**
 * /login — sign in with email + password.
 *
 * Uses the browser anon client (cookie-backed via @supabase/ssr), so a
 * successful sign-in writes the session to cookies the server can read.
 * On success, redirects to /dashboard, which resolves the org server-side.
 */

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "../../src/lib/supabaseBrowser";

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; message: string };

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus({ kind: "submitting" });

    const { error } = await supabaseBrowser.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (error) {
      // Generic message — do not reveal whether the email exists.
      setStatus({ kind: "error", message: "Invalid email or password." });
      return;
    }

    // Session is now in cookies; the dashboard resolves org server-side.
    router.push("/dashboard");
    router.refresh();
  }

  const submitting = status.kind === "submitting";

  return (
    <main style={styles.main}>
      <h1>Sign in to U-I-OS</h1>
      <form onSubmit={handleSubmit} style={styles.form}>
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
            autoComplete="current-password"
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
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
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
};
