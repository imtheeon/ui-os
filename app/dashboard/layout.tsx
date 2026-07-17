/**
 * /dashboard/* — shared chrome (sidebar) for every dashboard route.
 *
 * Auth check here is a fast bounce for the common "no session at all" case.
 * It intentionally does NOT resolve org_id (that's each page's job via
 * resolveOrgFromSession, the one authorized chokepoint — see
 * src/lib/resolveOrgFromSession.ts). Redirecting here on missing session is
 * defense in depth, not a replacement for the per-page trust boundary.
 */
import { redirect } from "next/navigation";
import Link from "next/link";
import { supabaseServer } from "../../src/lib/supabaseServer";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await supabaseServer();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  return (
    <div>
      <nav style={styles.sidebar}>
        <div style={styles.brand}>U-I-OS</div>
        <Link href="/dashboard" style={styles.link}>
          Overview
        </Link>
        <Link href="/dashboard/upload" style={styles.link}>
          Upload
        </Link>
        <Link href="/dashboard/payloads" style={styles.link}>
          Payloads
        </Link>
        <Link href="/dashboard/api-keys" style={styles.link}>
          API Keys
        </Link>
      </nav>
      <div style={styles.content}>{children}</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  sidebar: {
    position: "fixed",
    top: 0,
    left: 0,
    bottom: 0,
    width: 240,
    background: "#0f172a",
    color: "#fff",
    padding: "1.5rem 1rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
    fontFamily: "system-ui, sans-serif",
  },
  brand: {
    fontWeight: 700,
    fontSize: "1.05rem",
    marginBottom: "1.5rem",
    letterSpacing: "0.02em",
  },
  link: {
    color: "#cbd5e1",
    textDecoration: "none",
    padding: "0.55rem 0.6rem",
    borderRadius: 6,
    fontSize: "0.9rem",
  },
  content: {
    marginLeft: 240,
    minHeight: "100vh",
  },
};
