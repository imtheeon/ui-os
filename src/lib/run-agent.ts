/**
 * src/lib/run-agent.ts — handler for the trusted 'agent/run' event. Runs one
 * agent (accountant|analyst) over a completed payload and writes an agent_run
 * row plus any proposed_actions, all status='pending'.
 *
 * TRUST MODEL: orgId rides inside the trusted event; it is a closure variable
 * here, never derived from the LLM. Every DB read/write is .eq('org_id',orgId).
 * The model returns proposal CONTENT only; validateProposal() decides legality
 * and code stamps org_id on every row. This module DOES NOT import the executor
 * — agents can only propose, never apply.
 *
 * Tier gate: the swarm is a paid feature. free-tier org → agent_run
 * status='skipped_tier', no proposals (the entitlement check + the cost control).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { validateProposal } from "./agent-actions";
import type { AgentBrain } from "./agent-brain";

const PAID_TIERS = new Set(["pro", "enterprise"]);
const DEFAULT_SAMPLE_LIMIT = 20; // bounded projection into the prompt

type RunOk = { ok: true; runId: string; proposalCount: number; skippedTier?: boolean };
type RunErr = { ok: false; code: string; message: string };

export async function runAgent(
  params: { orgId: string; payloadId: string; role: "accountant" | "analyst" },
  deps?: { db?: SupabaseClient; brain?: AgentBrain; sampleLimit?: number }
): Promise<RunOk | RunErr> {
  const { orgId, payloadId, role } = params;
  const db = deps?.db ?? (await import("../db")).supabase;
  const brain = deps?.brain ?? (await import("./agent-brain")).claudeBrain;
  const sampleLimit = deps?.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;

  // 1. Tier gate — read the org, ORG-SCOPED.
  const { data: org, error: orgErr } = await db
    .from("organizations").select("subscription_tier").eq("id", orgId).maybeSingle();
  if (orgErr) return { ok: false, code: "DB_ERROR", message: "tier lookup failed" };
  if (!org) return { ok: false, code: "NOT_FOUND", message: "org not found" };

  if (!PAID_TIERS.has(org.subscription_tier as string)) {
    const { data: run } = await db.from("agent_runs").insert({
      org_id: orgId, payload_id: payloadId, role, status: "skipped_tier", brain: null,
      finished_at: new Date().toISOString(),
    }).select("id").single();
    await db.from("system_audit_logs").insert({
      org_id: orgId, action: "agent.skipped_tier", log_meta: { payloadId, role },
    });
    return { ok: true, runId: (run?.id as string) ?? "", proposalCount: 0, skippedTier: true };
  }

  // 2. Fetch the payload, ORG-SCOPED. Only a clean, completed upload is eligible.
  const { data: payload, error: pErr } = await db
    .from("inbound_payloads")
    .select("status, scan_status, extracted_json")
    .eq("id", payloadId).eq("org_id", orgId).maybeSingle();
  if (pErr) return { ok: false, code: "DB_ERROR", message: "payload lookup failed" };
  if (!payload || payload.status !== "completed" || payload.scan_status !== "clean") {
    return { ok: false, code: "NOT_ELIGIBLE", message: "payload not completed/clean" };
  }
  const ej = (payload.extracted_json ?? {}) as { columns?: string[]; rows?: string[][]; rowCount?: number };

  // 3. Open the run.
  const { data: run, error: runErr } = await db.from("agent_runs").insert({
    org_id: orgId, payload_id: payloadId, role, status: "running",
  }).select("id").single();
  if (runErr || !run) return { ok: false, code: "DB_ERROR", message: "could not open run" };
  const runId = run.id as string;

  try {
    // 4. Bounded, org-scoped projection → brain. Model never sees org_id.
    const result = await brain.propose({
      role,
      columns: ej.columns ?? [],
      sampleRows: (ej.rows ?? []).slice(0, sampleLimit),
      rowCount: ej.rowCount ?? 0,
    });

    // 5. Validate each proposal in CODE; code stamps org_id on every row.
    let written = 0;
    for (const p of result.proposals) {
      const v = validateProposal(p.kind, p.action_payload);
      if (!v.ok) {
        await db.from("system_audit_logs").insert({
          org_id: orgId, action: "agent.proposal_rejected",
          log_meta: { payloadId, role, runId, reason: v.reason },
        });
        continue;
      }
      const { error: insErr } = await db.from("proposed_actions").insert({
        org_id: orgId, // CODE-OWNED — model's payload cannot set this
        payload_id: payloadId, agent_run_id: runId,
        kind: v.kind, action_payload: v.payload,
        rationale: typeof p.rationale === "string" ? p.rationale.slice(0, 2000) : "",
        status: "pending",
      });
      if (!insErr) written++;
    }

    await db.from("agent_runs").update({
      status: "completed", brain: result.brain,
      input_tokens: result.inputTokens, output_tokens: result.outputTokens,
      finished_at: new Date().toISOString(),
    }).eq("id", runId).eq("org_id", orgId);

    await db.from("system_audit_logs").insert({
      org_id: orgId, action: "agent.proposed",
      log_meta: { payloadId, role, runId, proposalCount: written, brain: result.brain },
    });
    return { ok: true, runId, proposalCount: written };
  } catch (e) {
    await db.from("agent_runs").update({
      status: "failed", error: (e as Error).message, finished_at: new Date().toISOString(),
    }).eq("id", runId).eq("org_id", orgId);
    return { ok: false, code: "BRAIN_ERROR", message: (e as Error).message };
  }
}
