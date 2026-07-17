/**
 * src/lib/pdf-parser.ts — Phase 7: real PDF text extraction via pdfjs-dist.
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  ⚠️  BOUNDED IN-PROCESS PARSING — NOT TRUE SANDBOX ISOLATION.  ⚠️       ║
 * ║                                                                        ║
 * ║  Same honest tradeoff as the CSV parser in parse-upload.ts: this runs  ║
 * ║  pdfjs-dist (a large, complex binary-format parser) INSIDE the main    ║
 * ║  Node process, not inside a worker_thread. True process isolation      ║
 * ║  (worker_thread with resource limits, or E2B) is still DEFERRED — it   ║
 * ║  needs a way to ship a worker entry file through the Next.js server    ║
 * ║  bundle without breaking production, which is a separate piece of     ║
 * ║  work. It is made acceptable for now only by being strictly bounded:   ║
 * ║  hard caps on pages and total extracted characters, no rendering (text ║
 * ║  extraction only — never touches getOperatorList/render), no eval.     ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

export interface PdfParseResult {
  kind: "pdf";
  pageCount: number;
  text: string;
  truncated: boolean;
  parser: "pdfjs";
}

const MAX_PAGES = 500;
const MAX_CHARS = 100_000;

export async function parsePdfBuffer(buffer: Buffer): Promise<PdfParseResult> {
  const uint8 = new Uint8Array(buffer);
  const loadingTask = pdfjs.getDocument({ data: uint8 });
  const doc = await loadingTask.promise;
  try {
    const pageCount = doc.numPages;
    const pagesToProcess = Math.min(pageCount, MAX_PAGES);

    let text = "";
    let truncated = false;

    for (let i = 1; i <= pagesToProcess; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item ? item.str ?? "" : ""))
        .join(" ");

      if (text.length + pageText.length > MAX_CHARS) {
        text += pageText.slice(0, MAX_CHARS - text.length);
        truncated = true;
        break;
      }
      text += pageText + "\n";
    }

    if (pagesToProcess < pageCount) truncated = true;

    return { kind: "pdf", pageCount, text, truncated, parser: "pdfjs" };
  } finally {
    await loadingTask.destroy();
  }
}
