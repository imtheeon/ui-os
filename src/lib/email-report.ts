/**
 * src/lib/email-report.ts
 * Send a generated report PDF via Resend.
 */
export async function emailReport(params: {
  to: string;
  orgName: string;
  reportTitle: string;
  pdfBuffer: Buffer;
}): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: "RESEND_API_KEY not set" };

  const { Resend } = await import("resend");
  const resend = new Resend(apiKey);

  const { error } = await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL ?? "reports@uios.app",
    to: params.to,
    subject: `${params.reportTitle} — ${params.orgName}`,
    html: `<p>Please find your CFO analysis report attached.</p>`,
    attachments: [
      {
        filename: "report.pdf",
        content: params.pdfBuffer.toString("base64"),
      },
    ],
  });

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
