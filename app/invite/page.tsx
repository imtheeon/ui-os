"use client";

/**
 * /invite?token=... — accept a teammate invite.
 * If the visitor isn't logged in, prompts them to log in / sign up first
 * (the invite is re-checked by /api/auth/accept-invite once they return).
 */
import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser } from "../../src/lib/supabaseBrowser";

type Status =
  | { kind: "checking" }
  | { kind: "needs-login" }
  | { kind: "accepting" }
  | { kind: "accepted"; orgName: string | null }
  | { kind: "error"; message: string };

export default function InvitePage() {
  return (
    <Suspense fallback={<main style={{ maxWidth: 420, margin: "4rem auto", padding: "0 1rem", fontFamily: "system-ui, sans-serif" }}><p>Loading…</p></main>}>
      <InvitePageInner />
    </Suspense>
  );
}

function InvitePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const [status, setStatus] = useState<Status>({ kind: "checking" });

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!token) {
        setStatus({ kind: "error", message: "Missing invite token." });
        return;
      }

      const {
        data: { session },
      } = await supabaseBrowser.auth.getSession();
      if (cancelled) return;
      if (!session) {
        setStatus({ kind: "needs-login" });
        return;
      }

      setStatus({ kind: "accepting" });
      try {
        const res = await fetch("/api/auth/accept-invite", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setStatus({ kind: "error", message: body?.error ?? "Could not accept invite." });
          return;
        }
        setStatus({ kind: "accepted", orgName: body.orgName ?? null });
        setTimeout(() => router.push("/dashboard"), 1500);
      } catch {
        if (!cancelled) {
          setStatus({ kind: "error", message: "Network error accepting invite." });
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [token, router]);

  return (
    <main style={styles.main}>
      {status.kind === "checking" && <p>Checking invite…</p>}
      {status.kind === "accepting" && <p>Joining team…</p>}
      {status.kind === "needs-login" && (
        <>
          <p>Log in or sign up to accept this invite.</p>
          <div style={styles.actions}>
            <a href={`/login?next=${encodeURIComponent(`/invite?token=${token ?? ""}`)}`} style={styles.link}>
              Log in
            </a>
            <a href={`/signup?next=${encodeURIComponent(`/invite?token=${token ?? ""}`)}`} style={styles.link}>
              Sign up
            </a>
          </div>
        </>
      )}
      {status.kind === "accepted" && (
        <p>
          You&apos;ve been added to {status.orgName ?? "the team"}. Redirecting…
        </p>
      )}
      {status.kind === "error" && (
        <p style={styles.error} role="alert">
          {status.message}
        </p>
      )}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: { maxWidth: 420, margin: "4rem auto", padding: "0 1rem", fontFamily: "system-ui, sans-serif" },
  actions: { display: "flex", gap: "1rem", marginTop: "1rem" },
  link: { color: "#2563eb" },
  error: { color: "#b00020" },
};
