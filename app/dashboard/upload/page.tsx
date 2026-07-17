/**
 * /dashboard/upload — dedicated full-page upload flow.
 *
 * Reuses the existing UploadPanel (app/dashboard/UploadPanel.tsx) rather than
 * re-implementing the slot → PUT → finalize → process → poll flow. That panel
 * already owns the org_id-never-sent-from-client security model; this route
 * is just a page-level wrapper around it.
 */
import UploadPanel from "../UploadPanel";

export default function UploadPage() {
  return (
    <main style={styles.main}>
      <h1 style={styles.heading}>Upload data</h1>
      <p style={styles.hint}>CSV or PDF, up to 25MB.</p>
      <UploadPanel />
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: { maxWidth: 720, margin: "0 auto", padding: "2.5rem 1.5rem", fontFamily: "system-ui, sans-serif" },
  heading: { fontSize: "1.3rem", margin: 0 },
  hint: { color: "#666", fontSize: "0.85rem", margin: "0.35rem 0 1.5rem" },
};
