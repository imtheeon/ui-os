export interface AutoApproveCandidate {
  kind: string;
}

export interface MemoryEntry {
  confidence_score: number;
  times_confirmed: number;
}

/**
 * Pure threshold function — no DB calls, no side effects.
 * Both run-agent.ts and actions-service.ts import this as the single source
 * of auto-approval policy. To change the threshold, change it here only.
 *
 * _proposal is available for future kind-specific policy rules
 * (e.g. never auto-approve flag_anomaly severity=high).
 */
export function shouldAutoApprove(
  _proposal: AutoApproveCandidate,
  entry: MemoryEntry
): boolean {
  return entry.confidence_score >= 0.9 && entry.times_confirmed >= 10;
}
