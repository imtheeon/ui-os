"use client";

/**
 * /dashboard/billing — current tier + upgrade / manage-subscription actions.
 */
import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";

interface OrgSettings {
  name: string;
  subscription_tier: string;
  created_at: string;
}

export default function BillingPage() {
  return (
    <Suspense fallback={<main style={{ maxWidth: 600, margin: "0 auto", padding: "2.5rem 1.5rem", fontFamily: "system-ui, sans-serif" }}>Loading…</main>}>
      <BillingPageInner />
    </Suspense>
  );
}

function BillingPageInner() {
  const searchParams = useSearchParams();
  const success = searchParams.get("success") === "true";

  const [settings, setSettings] = useState<OrgSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [redirecting, setRedirecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/org/settings", { cache: "no-store" });
      const body = await res.json();
      if (res.ok) setSettings(body);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function goToCheckout(tier: "pro" | "enterprise") {
    setRedirecting(tier);
    setError(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tier }),
      });
      const body = await res.json();
      if (!res.ok || !body?.url) {
        setError(body?.error ?? "Could not start checkout.");
        setRedirecting(null);
        return;
      }
      window.location.href = body.url;
    } catch {
      setError("Network error starting checkout.");
      setRedirecting(null);
    }
  }

  async function goToPortal() {
    setRedirecting("portal");
    setError(null);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const body = await res.json();
      if (!res.ok || !body?.url) {
        setError(body?.error ?? "Could not open billing portal.");
        setRedirecting(null);
        return;
      }
      window.location.href = body.url;
    } catch {
      setError("Network error opening billing portal.");
      setRedirecting(null);
    }
  }

  if (loading) return <main style={styles.main}>Loading…</main>;
  if (!settings) return <main style={styles.main}>Could not load billing information.</main>;

  const tier = settings.subscription_tier;

  return (
    <main style={styles.main}>
      <h1 style={styles.heading}>Billing</h1>

      {success && <p style={styles.success}>Subscription updated. It may take a moment to reflect below.</p>}

      <dl style={styles.dl}>
        <dt style={styles.dt}>Current plan</dt>
        <dd style={styles.dd}>{tier}</dd>
      </dl>

      {tier === "free" ? (
        <div style={styles.actions}>
          <button
            type="button"
            disabled={redirecting !== null}
            onClick={() => goToCheckout("pro")}
            style={styles.button}
          >
            {redirecting === "pro" ? "Redirecting…" : "Upgrade to Pro"}
          </button>
          <button
            type="button"
            disabled={redirecting !== null}
            onClick={() => goToCheckout("enterprise")}
            style={styles.button}
          >
            {redirecting === "enterprise" ? "Redirecting…" : "Upgrade to Enterprise"}
          </button>
        </div>
      ) : (
        <div style={styles.actions}>
          <button
            type="button"
            disabled={redirecting !== null}
            onClick={goToPortal}
            style={styles.button}
          >
            {redirecting === "portal" ? "Redirecting…" : "Manage Subscription"}
          </button>
        </div>
      )}

      {error && <p style={styles.error}>{error}</p>}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: { maxWidth: 600, margin: "0 auto", padding: "2.5rem 1.5rem", fontFamily: "system-ui, sans-serif" },
  heading: { fontSize: "1.3rem", marginBottom: "1.5rem" },
  dl: { display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.4rem 1rem", marginBottom: "2rem", fontSize: "0.9rem" },
  dt: { color: "#666" },
  dd: { margin: 0, textTransform: "capitalize" },
  actions: { display: "flex", gap: "0.75rem" },
  button: { padding: "0.6rem 1rem", fontSize: "0.9rem", borderRadius: 6, border: "none", background: "#111", color: "#fff", cursor: "pointer" },
  success: { color: "#1a7f37", fontSize: "0.9rem", marginBottom: "1rem" },
  error: { color: "#b00020", fontSize: "0.9rem", marginTop: "1rem" },
};
