"use client";

/**
 * UploadPanel — drag-drop CSV/PDF upload for the dashboard.
 *
 * Per-file flow (the proven console flow):
 *   POST /api/uploads/slot → PUT bytes to the signed URL → POST /finalize
 *   → POST /process (MVP runner) → poll GET /status until terminal.
 *
 * SECURITY: org_id is NEVER sent from here — every endpoint resolves it from the
 * session server-side. The client-side type/size checks below are ADVISORY fast
 * feedback only; the server stays the enforcement boundary.
 *
 * STATUS: polling for now (watchPayload). The loop is isolated so swapping to
 * Supabase Realtime later is a one-function change. A hard attempt cap means a
 * stuck CSV resolves to "still processing — refresh later" instead of spinning
 * forever; a held PDF renders its honest message immediately (no spinner).
 */

import { useEffect, useRef, useState, type DragEvent, type ChangeEvent } from "react";

// Mirrors server limits (src/lib/uploads.ts). NOT imported, to keep server code
// out of the browser bundle — the SERVER enforces these for real.
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
const ALLOWED_EXT = ["csv", "pdf"] as const;
const POLL_INTERVAL_MS = 1500;
const MAX_POLL_ATTEMPTS = 20; // ~30s before "still processing"

interface Summary {
  columns: string[];
  rowCount: number;
  truncated: boolean;
  preview: string[][];
}

type Phase =
  | { kind: "queued" }
  | { kind: "uploading" }
  | { kind: "finalizing" }
  | { kind: "processing" }
  | { kind: "completed"; summary: Summary }
  | { kind: "held" }
  | { kind: "failed"; message: string }
  | { kind: "timeout" };

interface UploadItem {
  localId: string;
  name: string;
  size: number;
  payloadId?: string;
  phase: Phase;
}

const extOf = (name: string) => {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
};
const contentTypeFor = (name: string) => (extOf(name) === "pdf" ? "application/pdf" : "text/csv");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

export default function UploadPanel() {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const patch = (localId: string, phase: Phase) => {
    if (!mounted.current) return;
    setItems((prev) => prev.map((it) => (it.localId === localId ? { ...it, phase } : it)));
  };

  // POLL LOOP — the ONE spot to swap for Supabase Realtime later (subscribe to
  // inbound_payloads after the auth.uid() RLS decision).
  async function watchPayload(payloadId: string): Promise<Phase> {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      await sleep(POLL_INTERVAL_MS);
      if (!mounted.current) return { kind: "processing" };
      try {
        const res = await fetch(`/api/uploads/status?ids=${encodeURIComponent(payloadId)}`);
        if (!res.ok) continue;
        const body = (await res.json()) as {
          items: { payloadId: string; state: string; summary?: Summary }[];
        };
        const item = body.items?.find((i) => i.payloadId === payloadId);
        if (!item) continue;
        if (item.state === "completed" && item.summary) return { kind: "completed", summary: item.summary };
        if (item.state === "failed") return { kind: "failed", message: "Processing failed." };
        if (item.state === "held") return { kind: "held" };
        // "processing" → keep polling
      } catch {
        // transient network hiccup → keep polling
      }
    }
    return { kind: "timeout" };
  }

  async function handleFile(localId: string, file: File) {
    const ext = extOf(file.name);
    if (!ALLOWED_EXT.includes(ext as (typeof ALLOWED_EXT)[number])) {
      patch(localId, { kind: "failed", message: `Unsupported type ".${ext}" — csv or pdf only.` });
      return;
    }
    if (file.size <= 0 || file.size > MAX_FILE_BYTES) {
      patch(localId, { kind: "failed", message: "File too large (25 MB max)." });
      return;
    }
    const contentType = contentTypeFor(file.name);

    // 1. slot
    patch(localId, { kind: "uploading" });
    let slot: { payloadId: string; uploadUrl: string };
    try {
      const res = await fetch("/api/uploads/slot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: file.name, contentType, size: file.size }),
      });
      const body = await res.json();
      if (!res.ok) {
        patch(localId, { kind: "failed", message: body?.message ?? "Could not start upload." });
        return;
      }
      slot = body;
    } catch {
      patch(localId, { kind: "failed", message: "Network error starting upload." });
      return;
    }
    setItems((prev) =>
      prev.map((it) => (it.localId === localId ? { ...it, payloadId: slot.payloadId } : it))
    );

    // 2. direct PUT to storage
    try {
      const put = await fetch(slot.uploadUrl, {
        method: "PUT",
        headers: { "content-type": contentType, "x-upsert": "true" },
        body: file,
      });
      if (put.status !== 200) {
        patch(localId, { kind: "failed", message: `Storage upload failed (${put.status}).` });
        return;
      }
    } catch {
      patch(localId, { kind: "failed", message: "Network error during upload." });
      return;
    }

    // 3. finalize
    patch(localId, { kind: "finalizing" });
    try {
      const res = await fetch("/api/uploads/finalize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payloadId: slot.payloadId }),
      });
      const body = await res.json();
      if (!res.ok) {
        patch(localId, { kind: "failed", message: body?.message ?? "Finalize failed." });
        return;
      }
    } catch {
      patch(localId, { kind: "failed", message: "Network error finalizing." });
      return;
    }

    // 4. trigger the MVP runner (best-effort), then poll for the outcome
    patch(localId, { kind: "processing" });
    try {
      await fetch("/api/uploads/process", { method: "POST" });
    } catch {
      // ignore — the poll reflects the real DB state regardless
    }
    patch(localId, await watchPayload(slot.payloadId));
  }

  function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const fresh = Array.from(files).map((file) => ({ file, localId: crypto.randomUUID() }));
    setItems((prev) => [
      ...fresh.map(
        (f) =>
          ({
            localId: f.localId,
            name: f.file.name,
            size: f.file.size,
            phase: { kind: "queued" } as Phase,
          }) satisfies UploadItem
      ),
      ...prev,
    ]);
    fresh.forEach((f) => void handleFile(f.localId, f.file));
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    onFiles(e.dataTransfer.files);
  };

  return (
    <div>
      <div
        onDrop={onDrop}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setDragging(false);
        }}
        onClick={() => inputRef.current?.click()}
        style={{ ...styles.dropzone, ...(dragging ? styles.dropzoneActive : null) }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.pdf"
          multiple
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            onFiles(e.target.files);
            e.target.value = "";
          }}
          style={{ display: "none" }}
        />
        <p style={{ margin: 0 }}>Drag &amp; drop CSV or PDF here, or click to choose</p>
        <p style={styles.hint}>CSV is parsed now; PDF is accepted but held for the sandboxed parser.</p>
      </div>

      <ul style={styles.list}>
        {items.map((it) => {
          const b = badge(it.phase);
          return (
            <li key={it.localId} style={styles.card}>
              <div style={styles.cardHead}>
                <span style={styles.fname}>{it.name}</span>
                <span style={styles.fsize}>{fmtBytes(it.size)}</span>
                <span style={{ ...styles.badge, color: b.color, borderColor: b.color }}>{b.label}</span>
              </div>

              {it.phase.kind === "completed" && <ResultTable summary={it.phase.summary} />}
              {it.phase.kind === "held" && (
                <p style={styles.note}>
                  Held — PDF parsing awaits the sandboxed parser (deferred). The file was uploaded and
                  scanned; structured extraction isn’t available yet.
                </p>
              )}
              {it.phase.kind === "failed" && <p style={styles.errnote}>{it.phase.message}</p>}
              {it.phase.kind === "timeout" && (
                <p style={styles.note}>Still processing — refresh later to see the result.</p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ResultTable({ summary }: { summary: Summary }) {
  return (
    <div style={styles.result}>
      <p style={styles.resultMeta}>
        {summary.columns.length} columns · {summary.rowCount} rows
        {summary.truncated ? " (truncated at parse limit)" : ""} · showing first {summary.preview.length}
      </p>
      <div style={{ overflowX: "auto" }}>
        <table style={styles.table}>
          <thead>
            <tr>
              {summary.columns.map((c, i) => (
                <th key={i} style={styles.th}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {summary.preview.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td key={ci} style={styles.td}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function badge(phase: Phase): { label: string; color: string } {
  switch (phase.kind) {
    case "queued":
      return { label: "Queued", color: "#888" };
    case "uploading":
      return { label: "Uploading…", color: "#0366d6" };
    case "finalizing":
      return { label: "Finalizing…", color: "#0366d6" };
    case "processing":
      return { label: "Processing…", color: "#0366d6" };
    case "completed":
      return { label: "Completed", color: "#1a7f37" };
    case "held":
      return { label: "Held (PDF)", color: "#9a6700" };
    case "failed":
      return { label: "Failed", color: "#b00020" };
    case "timeout":
      return { label: "Still processing", color: "#9a6700" };
  }
}

const styles: Record<string, React.CSSProperties> = {
  dropzone: { border: "2px dashed #bbb", borderRadius: 8, padding: "1.5rem", textAlign: "center", cursor: "pointer", color: "#444", background: "#fafafa" },
  dropzoneActive: { borderColor: "#0366d6", background: "#f0f6ff" },
  hint: { margin: "0.4rem 0 0", fontSize: "0.78rem", color: "#888" },
  list: { listStyle: "none", padding: 0, margin: "1rem 0 0", display: "flex", flexDirection: "column", gap: "0.75rem" },
  card: { border: "1px solid #e2e2e2", borderRadius: 8, padding: "0.75rem" },
  cardHead: { display: "flex", alignItems: "center", gap: "0.6rem" },
  fname: { fontWeight: 600, fontSize: "0.9rem", wordBreak: "break-all" },
  fsize: { fontSize: "0.75rem", color: "#999" },
  badge: { marginLeft: "auto", fontSize: "0.72rem", border: "1px solid", borderRadius: 999, padding: "0.1rem 0.5rem", whiteSpace: "nowrap" },
  note: { margin: "0.6rem 0 0", fontSize: "0.82rem", color: "#9a6700" },
  errnote: { margin: "0.6rem 0 0", fontSize: "0.82rem", color: "#b00020" },
  result: { marginTop: "0.7rem" },
  resultMeta: { margin: "0 0 0.4rem", fontSize: "0.78rem", color: "#666" },
  table: { borderCollapse: "collapse", fontSize: "0.78rem" },
  th: { border: "1px solid #e2e2e2", padding: "0.3rem 0.5rem", background: "#f6f6f6", textAlign: "left", whiteSpace: "nowrap" },
  td: { border: "1px solid #eee", padding: "0.3rem 0.5rem", whiteSpace: "nowrap" },
};
