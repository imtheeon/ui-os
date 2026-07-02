import type { SupabaseClient } from "@supabase/supabase-js";

const MAX_CONTEXT_CHARS = 2_000;
const MAX_MEMORY_ENTRIES = 20;
const MAX_VALUE_CHARS = 200;

export async function getOrgContext(
  orgId: string,
  deps?: { db?: SupabaseClient }
): Promise<{ contextBlock: string | undefined }> {
  try {
    const db = deps?.db ?? (await import("../db")).supabase;

    const [memRes, accRes, payRes] = await Promise.all([
      db.from("org_memory")
        .select("memory_type, memory_key, memory_value, confidence_score, times_confirmed")
        .eq("org_id", orgId)
        .gt("confidence_score", 0)
        .order("confidence_score", { ascending: false })
        .limit(MAX_MEMORY_ENTRIES),
      db.from("agent_accuracy")
        .select("agent_role, approval_rate, total_proposals")
        .eq("org_id", orgId),
      db.from("inbound_payloads")
        .select("created_at, extracted_json")
        .eq("org_id", orgId)
        .eq("status", "completed")
        .order("created_at", { ascending: false })
        .limit(3),
    ]);

    const memory = memRes.data ?? [];
    const accuracy = accRes.data ?? [];
    const payloads = payRes.data ?? [];

    if (memory.length === 0 && accuracy.length === 0 && payloads.length === 0) {
      return { contextBlock: undefined };
    }

    return { contextBlock: formatBlock(memory, accuracy, payloads) };
  } catch {
    return { contextBlock: undefined };
  }
}

function formatBlock(
  memory: { memory_type: string; memory_key: string; memory_value: unknown; confidence_score: number; times_confirmed: number }[],
  accuracy: { agent_role: string; approval_rate: number | null; total_proposals: number }[],
  payloads: { created_at: string; extracted_json: unknown }[]
): string {
  const lines: string[] = ["## Organizational Context"];

  if (memory.length > 0) {
    lines.push("### Learned Patterns");
    for (const m of memory) {
      const val = JSON.stringify(m.memory_value).slice(0, MAX_VALUE_CHARS);
      lines.push(
        `- ${m.memory_type} | ${m.memory_key} | ${val} | confidence=${m.confidence_score.toFixed(2)} | confirmed=${m.times_confirmed}x`
      );
    }
  }

  if (accuracy.length > 0) {
    lines.push("### Agent Accuracy");
    for (const a of accuracy) {
      const rate = a.approval_rate != null ? `${Math.round(a.approval_rate * 100)}%` : "n/a";
      lines.push(`- ${a.agent_role}: ${rate} approval (${a.total_proposals} proposals)`);
    }
  }

  if (payloads.length > 0) {
    lines.push("### Recent Uploads");
    for (const p of payloads) {
      const ej = (p.extracted_json ?? {}) as { columns?: string[]; rowCount?: number };
      const cols = (ej.columns ?? []).join(",");
      lines.push(`- ${p.created_at.slice(0, 10)}: columns=[${cols}] rows=${ej.rowCount ?? "?"}`);
    }
  }

  // Enforce hard character cap: drop lowest-confidence memory lines first.
  let block = lines.join("\n");
  if (block.length <= MAX_CONTEXT_CHARS) return block;

  const memStart = lines.findIndex((l) => l.startsWith("### Learned Patterns")) + 1;
  const memEnd = lines.findIndex((l, i) => i > memStart && l.startsWith("###"));
  const memLines = lines.slice(memStart, memEnd === -1 ? undefined : memEnd);

  while (block.length > MAX_CONTEXT_CHARS && memLines.length > 0) {
    memLines.pop();
    const trimmed = [
      ...lines.slice(0, memStart),
      ...memLines,
      ...(memEnd === -1 ? [] : lines.slice(memEnd)),
    ];
    block = trimmed.join("\n");
  }
  return block;
}
