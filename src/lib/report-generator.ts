/**
 * src/lib/report-generator.ts
 *
 * Generates a PDF report from a completed payload's agent results.
 * Uses @react-pdf/renderer for PDF generation.
 * Stores the PDF in Supabase Storage (reports bucket).
 */
import { renderToBuffer } from "@react-pdf/renderer";
import { createElement } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

export const REPORTS_BUCKET = "reports";

export interface ReportInput {
  orgId: string;
  payloadId: string;
  reportId: string;
  title: string;
  agentRuns: Array<{ role: string; status: string; created_at: string }>;
  proposedActions: Array<{ kind: string; payload: unknown; created_at: string }>;
}

/** Build a minimal but professional PDF using @react-pdf/renderer */
async function buildPdf(input: ReportInput): Promise<Buffer> {
  // Import React PDF components
  const { Document, Page, Text, View, StyleSheet } = await import("@react-pdf/renderer");

  const styles = StyleSheet.create({
    page: { padding: 48, fontSize: 11, fontFamily: "Helvetica" },
    title: { fontSize: 20, fontWeight: "bold", marginBottom: 8 },
    subtitle: { fontSize: 12, color: "#64748b", marginBottom: 24 },
    sectionHeader: { fontSize: 14, fontWeight: "bold", marginTop: 20, marginBottom: 8, borderBottomWidth: 1, borderBottomColor: "#e2e8f0", paddingBottom: 4 },
    row: { flexDirection: "row", marginBottom: 4 },
    label: { width: 160, color: "#64748b" },
    value: { flex: 1 },
    actionBlock: { marginBottom: 12, padding: 8, backgroundColor: "#f8fafc" },
    actionKind: { fontWeight: "bold", marginBottom: 4 },
  });

  const doc = createElement(Document, null,
    createElement(Page, { size: "A4", style: styles.page },
      createElement(View, null,
        createElement(Text, { style: styles.title }, input.title),
        createElement(Text, { style: styles.subtitle },
          `Generated ${new Date().toLocaleDateString()} · Payload ${input.payloadId.slice(0, 8)}`
        ),
        createElement(Text, { style: styles.sectionHeader }, "Agent Analysis Summary"),
        ...input.agentRuns.map(run =>
          createElement(View, { style: styles.row, key: run.role },
            createElement(Text, { style: styles.label }, run.role),
            createElement(Text, { style: styles.value }, run.status)
          )
        ),
        createElement(Text, { style: styles.sectionHeader }, "Findings & Recommendations"),
        ...input.proposedActions.map((action, i) =>
          createElement(View, { style: styles.actionBlock, key: i },
            createElement(Text, { style: styles.actionKind }, action.kind),
            createElement(Text, {}, JSON.stringify(action.payload, null, 2).slice(0, 500))
          )
        )
      )
    )
  );

  return Buffer.from(await renderToBuffer(doc));
}

export interface GenerateReportResult {
  ok: boolean;
  storagePath?: string;
  error?: string;
}

export async function generateReport(
  input: ReportInput,
  deps?: { db?: SupabaseClient }
): Promise<GenerateReportResult> {
  const db: SupabaseClient = deps?.db ?? (await import("../db")).supabase;

  try {
    const pdfBuffer = await buildPdf(input);
    const storagePath = `${input.orgId}/${input.reportId}/report.pdf`;

    const { error: uploadErr } = await db.storage
      .from(REPORTS_BUCKET)
      .upload(storagePath, pdfBuffer, { contentType: "application/pdf", upsert: true });

    if (uploadErr) return { ok: false, error: uploadErr.message };

    await db.from("reports")
      .update({ status: "ready", storage_path: storagePath })
      .eq("id", input.reportId)
      .eq("org_id", input.orgId);

    return { ok: true, storagePath };
  } catch (err) {
    await db.from("reports")
      .update({ status: "failed" })
      .eq("id", input.reportId)
      .eq("org_id", input.orgId);
    return { ok: false, error: (err as Error).message };
  }
}
