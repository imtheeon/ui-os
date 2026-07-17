"use client";
/**
 * DownloadLink — generates a fresh signed download URL on click rather than
 * embedding one at server-render time (signed URLs are short-lived). Reuses
 * GET /api/payloads/[id]/report, which returns the most recent report + a
 * freshly-minted signed URL for that payload.
 */
import { useState } from "react";

export default function DownloadLink({ payloadId }: { reportId: string; payloadId: string }) {
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    try {
      const res = await fetch(`/api/payloads/${payloadId}/report`, { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { downloadUrl?: string };
      if (json.downloadUrl) window.open(json.downloadUrl, "_blank", "noopener,noreferrer");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      disabled={busy}
      onClick={download}
      style={{ background: "none", border: 0, color: "#0366d6", cursor: "pointer", fontSize: "0.85rem", padding: 0 }}
    >
      Download
    </button>
  );
}
