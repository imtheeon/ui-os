/**
 * src/lib/virustotal-scanner.ts — Phase 9: real malware scanning via
 * VirusTotal API v3.
 *
 * `virusTotalScanner` implements the same `Scanner` seam that
 * `placeholderScanner` (scan-upload.ts) always satisfied trivially: it
 * downloads the stored object, uploads the bytes to VT, polls for the
 * analysis result (up to ~60s), and returns "infected" if any engine flags
 * it, "clean" otherwise.
 *
 * Falls back to "clean" (with a console warning, no network call) when
 * VIRUSTOTAL_API_KEY is unset — this preserves dev/test behavior without
 * requiring a real API key or spending a real scan quota locally.
 */

import type { ScanTarget, ScanVerdict, Scanner } from "./scan-upload";

const VT_API_KEY = process.env.VIRUSTOTAL_API_KEY;
const VT_BASE = "https://www.virustotal.com/api/v3";
const POLL_INTERVAL_MS = 5_000;
const MAX_POLLS = 12; // 60 seconds total

/** True only when a real VirusTotal API key is configured in this env. */
export const VT_CONFIGURED = Boolean(VT_API_KEY);

async function vtRequest(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${VT_BASE}${path}`, {
    ...options,
    headers: {
      "x-apikey": VT_API_KEY!,
      ...(options.headers ?? {}),
    },
  });
}

export async function scanBuffer(buffer: Buffer, filename: string): Promise<ScanVerdict> {
  if (!VT_API_KEY) {
    console.warn("[scanner] VIRUSTOTAL_API_KEY not set — skipping real scan, returning clean");
    return "clean";
  }

  try {
    const formData = new FormData();
    formData.append("file", new Blob([new Uint8Array(buffer)]), filename);
    const uploadRes = await vtRequest("/files", { method: "POST", body: formData });
    if (!uploadRes.ok) return "error";
    const { data: uploadData } = (await uploadRes.json()) as { data: { id: string } };
    const analysisId = uploadData.id;

    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const res = await vtRequest(`/analyses/${analysisId}`);
      if (!res.ok) continue;
      const { data } = (await res.json()) as {
        data: { attributes: { status: string; stats: { malicious: number; suspicious: number } } };
      };
      const { status, stats } = data.attributes;
      if (status === "completed") {
        return stats.malicious > 0 || stats.suspicious > 0 ? "infected" : "clean";
      }
    }

    console.warn(`[scanner] VT analysis timed out for ${filename}`);
    return "error";
  } catch (err) {
    console.error("[scanner] VT scan failed:", (err as Error).message);
    return "error";
  }
}

/** Real Scanner implementation: downloads the stored object, then delegates
 *  to scanBuffer(). Same fetch pattern parse-upload.ts already uses to read
 *  a finalized upload's bytes. */
export const virusTotalScanner: Scanner = {
  async scan(target: ScanTarget): Promise<ScanVerdict> {
    const { data: blob, error } = await target.db.storage.from(target.bucket).download(target.storagePath);
    if (error || !blob) {
      console.error(`[scanner] could not download ${target.storagePath} for scanning: ${error?.message}`);
      return "error";
    }
    const buffer = Buffer.from(await blob.arrayBuffer());
    const filename = target.storagePath.slice(target.storagePath.lastIndexOf("/") + 1);
    return scanBuffer(buffer, filename);
  },
};
