export interface MemoryUpsert {
  memory_type: string;
  memory_key: string;
  memory_value: Record<string, unknown>;
  source_agent: string;
  proposed_action_id: string;
}

export function extractMemory(
  action: { id: string; kind: string; action_payload: Record<string, unknown> },
  sourceAgent: string
): MemoryUpsert[] {
  const p = action.action_payload;

  if (action.kind === "record_ledger_entry") {
    const direction = typeof p.direction === "string" ? p.direction : "unknown";
    return [{
      memory_type: "spend_baseline",
      memory_key: `ledger:${direction}`.slice(0, 500),
      memory_value: {
        description: typeof p.description === "string" ? p.description.slice(0, 200) : "",
        amount_cents: typeof p.amount_cents === "number" ? p.amount_cents : 0,
        direction,
      },
      source_agent: sourceAgent,
      proposed_action_id: action.id,
    }];
  }

  if (action.kind === "flag_anomaly") {
    const severity = typeof p.severity === "string" ? p.severity : "unknown";
    return [{
      memory_type: "anomaly_pattern",
      memory_key: `anomaly:${severity}`.slice(0, 500),
      memory_value: {
        description: typeof p.description === "string" ? p.description.slice(0, 200) : "",
        severity,
      },
      source_agent: sourceAgent,
      proposed_action_id: action.id,
    }];
  }

  if (action.kind === "categorize_items") {
    const scheme = typeof p.scheme === "string" ? p.scheme : null;
    if (!scheme) return [];
    const assignments = Array.isArray(p.assignments) ? p.assignments : [];
    const topCategories = [...new Set(
      assignments
        .filter((a): a is { row_reference: string; category: string } =>
          typeof (a as Record<string, unknown>).category === "string")
        .map((a) => a.category)
    )].slice(0, 10);
    return [{
      memory_type: "vendor_category",
      memory_key: `scheme:${scheme}`.slice(0, 500),
      memory_value: { scheme, top_categories: topCategories },
      source_agent: sourceAgent,
      proposed_action_id: action.id,
    }];
  }

  // store_report: no memory extraction
  return [];
}
