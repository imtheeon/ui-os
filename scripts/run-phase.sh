#!/usr/bin/env bash
# =============================================================================
# U-I-OS Single Phase Runner
# Runs one phase with automatic self-correction on failure.
#
# USAGE:
#   bash scripts/run-phase.sh <phase-number>
#
# Examples:
#   bash scripts/run-phase.sh 06    ← Phase 6: Inngest
#   bash scripts/run-phase.sh 10    ← Phase 10: Live agents
#   bash scripts/run-phase.sh 03    ← Phase 3: Frontend
#
# Self-correction: if a phase fails, the error log is fed back to Claude
# automatically so it can diagnose and fix the problem. Retries up to
# MAX_RETRIES times before giving up.
# =============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PHASES="$REPO/scripts/phases"
LOGS="$REPO/scripts/phase-logs"
mkdir -p "$LOGS"

MAX_RETRIES=6
ERROR_LOG_LINES=150

# ---------------------------------------------------------------------------
# Phase registry
# ---------------------------------------------------------------------------
declare -A DONE_FILE=(
  [06]="src/lib/inngest.ts"
  [10]="src/check-live-smoke.ts"
  [03]="app/(dashboard)/upload/page.tsx"
  [04]="app/(auth)/onboarding/page.tsx"
  [05]="src/lib/stripe.ts"
  [11]="src/lib/report-generator.ts"
  [07]="src/lib/pdf-parser.ts"
  [08]="src/migrations/0208_email_dedup_index.sql"
  [09]="src/lib/virustotal-scanner.ts"
  [12]="sentry.client.config.ts"
)

declare -A PHASE_NAME=(
  [06]="Inngest durable queue"
  [10]="Live agent execution"
  [03]="Frontend dashboard"
  [04]="Auth & onboarding"
  [05]="Stripe billing"
  [11]="Client reports"
  [07]="Real PDF parsing"
  [08]="Email deduplication"
  [09]="VirusTotal scanner"
  [12]="Sentry observability"
)

# ---------------------------------------------------------------------------
# Validate input
# ---------------------------------------------------------------------------
if [[ $# -lt 1 ]]; then
  echo "Usage: bash scripts/run-phase.sh <phase-number>"
  echo ""
  echo "Available phases:"
  for k in 06 10 03 04 05 11 07 08 09 12; do
    echo "  $k  ${PHASE_NAME[$k]}"
  done
  exit 1
fi

NUM="$1"
# Zero-pad single digits
if [[ ${#NUM} -eq 1 ]]; then NUM="0${NUM}"; fi

if [[ -z "${DONE_FILE[$NUM]+x}" ]]; then
  echo "✗ Unknown phase: $NUM"
  echo "Valid phases: 06 10 03 04 05 11 07 08 09 12"
  exit 1
fi

SENTINEL="${DONE_FILE[$NUM]}"
NAME="${PHASE_NAME[$NUM]}"
PHASE_FILE=$(ls "$PHASES/phase-${NUM}-"*.txt 2>/dev/null | head -1)

if [[ -z "$PHASE_FILE" || ! -f "$PHASE_FILE" ]]; then
  echo "✗ Prompt file not found for phase $NUM in $PHASES"
  exit 1
fi

# ---------------------------------------------------------------------------
# Already done?
# ---------------------------------------------------------------------------
if [[ -e "$REPO/$SENTINEL" ]]; then
  echo "✓ Phase $NUM ($NAME) is already complete — $SENTINEL exists."
  echo "  Nothing to do."
  exit 0
fi

# ---------------------------------------------------------------------------
# Preamble
# ---------------------------------------------------------------------------
PREAMBLE=$(cat <<'PREAMBLE'
═══════════════════════════════════════════════════════════════
COORDINATOR PREAMBLE — READ BEFORE STARTING
═══════════════════════════════════════════════════════════════

── RESUME / SKIP LOGIC ──────────────────────────────────────
Check for the completion sentinel file listed in COMPLETION CRITERIA.
If it already exists, this phase is DONE — output "Phase already complete"
and exit immediately. Do not redo any work.

── AUTONOMOUS RULES (apply to every phase) ──────────────────
1. Do NOT stop to ask questions or wait for confirmation.
2. Make the best technical decision and proceed.
3. TypeScript errors: fix and retry indefinitely until npm run typecheck exits 0.
4. After every phase: npm run check:agents must still pass (no regressions).
5. Secret scan must pass before any git push.
6. Merge to main and push at the end of every phase.

── SECURITY INVARIANTS ──────────────────────────────────────
• org_id always CODE-OWNED — never from client input or LLM output.
• API keys, secrets, DSNs: env vars only, never in source files.
• Agent code NEVER imports executor.ts.
• stubBrain for all tests — zero real tokens.

═══════════════════════════════════════════════════════════════

PREAMBLE
)

# ---------------------------------------------------------------------------
# Run with self-correction loop
# ---------------------------------------------------------------------------
attempt=0
last_log=""

echo ""
echo "========================================================"
echo "  PHASE $NUM: $NAME"
echo "  Max self-correction attempts: $MAX_RETRIES"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================================"

while (( attempt < MAX_RETRIES )); do
  attempt=$(( attempt + 1 ))
  log="$LOGS/phase-${NUM}-attempt${attempt}-$(date +%Y%m%d-%H%M%S).log"

  if (( attempt > 1 )); then
    echo ""
    echo "  ↻ Self-correction attempt $attempt/$MAX_RETRIES — feeding error back to Claude..."
    echo ""
  fi

  # Build the prompt
  if (( attempt == 1 )) || [[ -z "$last_log" ]]; then
    prompt="${PREAMBLE}$(cat "$PHASE_FILE")"
  else
    error_tail=$(tail -${ERROR_LOG_LINES} "$last_log" 2>/dev/null || echo "(log unavailable)")
    prompt=$(cat <<ERRPROMPT
═══════════════════════════════════════════════════════════════
SELF-CORRECTION RUN — Phase $NUM: $NAME (attempt $attempt)
═══════════════════════════════════════════════════════════════

The previous attempt did not complete. Sentinel not found: $SENTINEL

Last $ERROR_LOG_LINES lines of the previous output:
────────────────────────────────────────────────────────────────
$error_tail
────────────────────────────────────────────────────────────────

YOUR TASK:
1. Read the output above and identify every error or incomplete step.
2. Fix each error. Common issues:
   - TypeScript error → fix the type, re-run npm run typecheck
   - Missing import → add the correct import
   - Git conflict → accept incoming, re-run typecheck
   - Migration already applied → skip it, continue with code files
   - npm install failed → retry npm install
   - File not created → create it now
   - check:agents regression → read the failing test and fix root cause
3. Complete ALL remaining steps that were not finished.
4. npm run typecheck must exit 0.
5. npm run check:agents must pass.
6. bash scripts/secret-scan.sh must be clean.
7. Commit and push to main.
8. Phase is not done until this file exists: $SENTINEL

ORIGINAL PHASE PROMPT:
═══════════════════════════════════════════════════════════════
${PREAMBLE}$(cat "$PHASE_FILE")
ERRPROMPT
)
  fi

  cd "$REPO"
  claude --dangerously-skip-permissions --print "$prompt" 2>&1 | tee "$log"
  last_log="$log"

  # Success?
  if [[ -e "$REPO/$SENTINEL" ]]; then
    echo ""
    echo "========================================================"
    echo "  ✓ PHASE $NUM COMPLETE: $NAME"
    echo "  Sentinel: $SENTINEL"
    echo "  Attempts: $attempt"
    echo "  $(date '+%Y-%m-%d %H:%M:%S')"
    echo "========================================================"
    exit 0
  fi

  # Usage limit?
  if grep -qiE "usage limit|rate limit|too many requests|quota exceeded|overloaded|529|Claude\.ai usage" "$log" 2>/dev/null; then
    echo ""
    echo "⚠  Usage limit detected. Waiting 4.5 hours for reset..."
    sleep 16200
    echo "  Retrying after usage-limit pause..."
    continue
  fi

  # Not done, no usage limit — self-correct next iteration
  if (( attempt < MAX_RETRIES )); then
    sleep 10
    continue
  fi
done

echo ""
echo "✗ Phase $NUM failed after $MAX_RETRIES attempts."
echo "  Last log: $last_log"
echo "  Re-run: bash scripts/run-phase.sh $NUM"
exit 1
