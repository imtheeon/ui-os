#!/usr/bin/env bash
# =============================================================================
# U-I-OS Autonomous Build Coordinator
# Feeds batch prompts to Claude Code sequentially, verifies each one, moves on.
#
# USAGE (run inside tmux so it survives screen lock):
#   tmux new -s uios
#   cd ~/ui-os
#   bash scripts/build-coordinator.sh
#
# Features:
#   - Skips batches already complete (safe to re-run at any time)
#   - Detects Claude usage-limit errors and auto-sleeps until reset
#   - Retries each batch up to MAX_RETRIES times after a usage-limit pause
#   - Prepends a "skip already-built agents" instruction on every retry
#   - Logs everything to scripts/build-logs/ with timestamps
# =============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BATCHES="$REPO/scripts/batches"
LOGS="$REPO/scripts/build-logs"
mkdir -p "$LOGS"

# ---------------------------------------------------------------------------
# Tuning knobs
# ---------------------------------------------------------------------------
# How long to sleep when a usage limit is detected (seconds).
# Claude's rolling window resets after ~5 hours; 4.5h gives a safety buffer.
USAGE_LIMIT_SLEEP=16200   # 4.5 hours = 16200s

# Maximum number of times to retry a single batch on usage-limit errors.
MAX_RETRIES=4

# Cooldown between successful batches (seconds).
BATCH_COOLDOWN=60

# ---------------------------------------------------------------------------
# First migration number each batch creates — used to detect completion.
# ---------------------------------------------------------------------------
declare -A FIRST_MIG=(
  [09]="0057" [10]="0063" [11]="0069" [12]="0074"
  [13]="0080" [14]="0086" [15]="0092" [16]="0098"
  [17]="0104" [18]="0110" [19]="0117"
  [20]="0126" [21]="0132" [22]="0138"
  [23]="0144" [24]="0150" [25]="0156" [26]="0162"
  [27]="0168" [28]="0174" [29]="0180" [30]="0186"
  [31]="0192" [32]="0194"
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
already_done() {
  local first="$1"
  ls "$REPO/src/migrations/${first}_"*.sql 2>/dev/null | grep -q . && return 0 || return 1
}

# Returns 0 (true) if the log file contains any usage-limit signal from Claude.
is_usage_limit() {
  local log="$1"
  grep -qiE \
    "usage limit|rate limit|too many requests|quota exceeded|overloaded|529|Claude\.ai usage" \
    "$log" 2>/dev/null
}

# Pretty countdown so the terminal stays useful while waiting.
sleep_with_countdown() {
  local seconds="$1"
  local label="$2"
  local end=$(( $(date +%s) + seconds ))
  while (( $(date +%s) < end )); do
    local remaining=$(( end - $(date +%s) ))
    local hh=$(( remaining / 3600 ))
    local mm=$(( (remaining % 3600) / 60 ))
    local ss=$(( remaining % 60 ))
    printf "\r  ⏳ %s — resuming in %02d:%02d:%02d   " "$label" "$hh" "$mm" "$ss"
    sleep 5
  done
  printf "\r  ✓ Wait complete — resuming now.                    \n"
}

# ---------------------------------------------------------------------------
# Core: run one batch, with usage-limit retry logic
# ---------------------------------------------------------------------------
run_batch() {
  local num="$1"
  local file="$BATCHES/batch-${num}.txt"
  local first="${FIRST_MIG[$num]}"
  local attempt=0

  if [[ ! -f "$file" ]]; then
    echo "✗ Batch $num: prompt file not found at $file — stopping."
    exit 1
  fi

  # Preamble prepended on every call.
  # 1. Tells Claude Code to skip agents already built (safe retries).
  # 2. Enforces the full quality bar — no shortcuts on any agent.
  local SKIP_PREAMBLE
  SKIP_PREAMBLE=$(cat <<'PREAMBLE'
═══════════════════════════════════════════════════════════════
COORDINATOR PREAMBLE — READ AND FOLLOW BEFORE STARTING
═══════════════════════════════════════════════════════════════

── RESUME / SKIP LOGIC ──────────────────────────────────────
Before touching each agent, run:
  ls src/migrations/NNNN_*.sql   (where NNNN is that agent's migration number)
If the file exists → the agent is ALREADY COMPLETE. Skip it. Move to the next.
Do NOT re-apply, re-test, or re-merge agents that are already done.
Only build agents whose migration files are absent.

── NO-SHORTCUTS QUALITY BAR (enforced on EVERY agent) ───────
Do not proceed to the next agent until ALL of the following are true
for the agent you just built:

1. MIGRATION applied via Supabase MCP (project zmntyhnmhzgtgwujhedf).
   The migration SQL must include:
   • The agent's result table (all columns as specified).
   • RLS enabled + tenant_isolation policy on the table.
   • Indexes on org_id and payload_id.
   • agent_runs.role CHECK updated to include the new role key.
   • proposed_actions.kind CHECK updated to include the new action kind.
   • agent_accuracy.agent_role CHECK updated to include the new role key.
   All three CHECK updates must be in the SAME migration — never split them.

2. src/lib/agent-brain.ts updated:
   • New role key added to the role union type.
   • Model tier wired correctly (Haiku / Sonnet / Opus as specified).
   • System prompt added verbatim as specified.
   • stubBrain case added returning the exact stub shape specified.

3. src/lib/agent-actions.ts updated:
   • New action kind added to the ActionKind union.
   • Full validateProposal logic implemented as specified.
   • Array item fields: invalid items filtered silently.
   • Top-level singular fields: invalid value rejects the whole proposal.

4. src/lib/executor.ts updated:
   • Insert handler added for the new action kind.
   • org_id is CODE-OWNED (taken from the verified org context, NEVER from
     LLM output or the proposal payload).
   • Agent files NEVER import executor.ts — one-way dependency only.

5. src/lib/manager.ts updated:
   • Agent wired into the correct route(s) at the position specified.
   • If BOTH routes: added to financial route AND non-financial route.
   • If FINANCIAL only: added to financial route only.
   • If NON-FINANCIAL only: added to non-financial route only.

6. src/check-agents.ts updated with a MINIMUM OF 8 TESTS for this agent:
   At minimum include ALL of the following:
   a. validateProposal — valid proposal passes validation.
   b. validateProposal — rejects proposal with invalid top-level singular field.
   c. validateProposal — invalid array item field is silently filtered
      (proposal still passes, bad item removed).
   d. validateProposal — at least one more edge case specific to this agent's
      schema (e.g. out-of-range number, empty required string, wrong enum).
   e. stubBrain — calling the agent with stubBrain returns the expected action kind.
   f. stubBrain — the stub proposal passes validateProposal.
   g. runAgent — integration test: runAgent with a valid payload succeeds
      and returns a proposal with the correct action kind.
   h. routing — the agent appears on the correct route(s) in manager.ts
      (test that looksFinancial routing sends it where expected).
   8 tests is the MINIMUM. Add more if the schema has additional edge cases.

7. npm run typecheck exits 0 — zero TypeScript errors.

8. npm run check:agents passes — all tests green, count incremented.

9. Secret scan clean before any git push.

10. Merge branch to main and push.

Only after all 10 steps are confirmed complete should you move to the next agent.

── SECURITY INVARIANTS (non-negotiable on every agent) ──────
• org_id: always CODE-OWNED in executor, never from LLM output.
• Agent brain/actions code: NEVER imports executor.ts.
• stubBrain: used for ALL tests — zero real tokens spent.
• Migrations: all three CHECK constraints updated in the same migration.

═══════════════════════════════════════════════════════════════

PREAMBLE
)

  while (( attempt < MAX_RETRIES )); do
    attempt=$(( attempt + 1 ))
    local log="$LOGS/batch-${num}-attempt${attempt}-$(date +%Y%m%d-%H%M%S).log"

    echo ""
    echo "========================================================"
    echo "  BATCH $num  |  attempt $attempt/$MAX_RETRIES  |  $(date '+%Y-%m-%d %H:%M:%S')"
    echo "========================================================"

    cd "$REPO"
    # Combine the skip-preamble with the batch prompt on every run.
    claude --dangerously-skip-permissions --print \
      "${SKIP_PREAMBLE}$(cat "$file")" \
      2>&1 | tee "$log"

    # --- Success check ---
    if already_done "$first"; then
      echo "✓ Batch $num complete — migration $first found."
      echo "  Cooling down ${BATCH_COOLDOWN}s before next batch..."
      sleep "$BATCH_COOLDOWN"
      return 0
    fi

    # --- Usage limit check ---
    if is_usage_limit "$log"; then
      if (( attempt < MAX_RETRIES )); then
        echo ""
        echo "⚠  Usage limit detected in batch $num (attempt $attempt)."
        echo "   Sleeping ${USAGE_LIMIT_SLEEP}s (~4.5 h) for quota reset, then retrying."
        echo "   Log saved: $log"
        sleep_with_countdown "$USAGE_LIMIT_SLEEP" "Batch $num usage-limit pause"
        echo "   Retrying batch $num..."
        continue
      else
        echo ""
        echo "✗ Batch $num hit usage limit on final attempt ($MAX_RETRIES)."
        echo "  Re-run this script after the quota resets — completed agents will be skipped."
        echo "  Log: $log"
        exit 1
      fi
    fi

    # --- Other failure ---
    echo ""
    echo "✗ Batch $num failed (migration $first not found, no usage-limit signal)."
    echo "  Log: $log"
    echo "  Stopping coordinator. Inspect the log, fix the issue, then re-run."
    exit 1
  done
}

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
echo "U-I-OS Build Coordinator starting at $(date)"
echo "Repo: $REPO"
echo "Usage-limit sleep: ${USAGE_LIMIT_SLEEP}s  |  Max retries per batch: $MAX_RETRIES"
echo ""

for num in 09 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32; do
  first="${FIRST_MIG[$num]}"
  if already_done "$first"; then
    echo "→ Batch $num already complete (migration $first exists) — skipping."
    continue
  fi
  run_batch "$num"
done

echo ""
echo "========================================================"
echo "  ALL BATCHES COMPLETE — 201 agents + BigQuery connector + BigQuery query agent"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "  Run: npm run typecheck && npm run check:agents"
echo "========================================================"
