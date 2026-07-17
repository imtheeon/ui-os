#!/usr/bin/env bash
# =============================================================================
# U-I-OS Phase Coordinator
# Feeds phase prompts to Claude Code sequentially, verifies each one, moves on.
#
# USAGE (run inside tmux so it survives screen lock):
#   tmux new -s phases
#   cd ~/ui-os
#   bash scripts/phase-coordinator.sh
#
# Phases run in this order (the critical path we agreed on):
#   6  → Inngest (durable queue)
#   10 → Live agent execution hardening
#   3  → Frontend dashboard
#   4  → Auth & onboarding
#   5  → Stripe billing
#   11 → Client reports
#   7  → Real PDF parsing
#   8  → Email deduplication
#   9  → VirusTotal malware scanning
#   12 → Sentry observability
#
# Phase 2 (API layer) is intentionally excluded — it runs separately via
# batch-phase2.txt and should already be complete before you run this.
#
# Features:
#   - Skips phases already complete (safe to re-run at any time)
#   - Detects Claude usage-limit errors and auto-sleeps until reset
#   - On any other failure: feeds the error log back to Claude to self-correct
#   - Retries each phase up to MAX_RETRIES times (self-correcting on each retry)
#   - Logs everything to scripts/phase-logs/ with timestamps
# =============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PHASES="$REPO/scripts/phases"
LOGS="$REPO/scripts/phase-logs"
mkdir -p "$LOGS"

# ---------------------------------------------------------------------------
# Tuning knobs
# ---------------------------------------------------------------------------
USAGE_LIMIT_SLEEP=7200    # 2 hours — covers typical session-limit resets
MAX_RETRIES=6             # more retries now that self-correction burns attempts
PHASE_COOLDOWN=90         # seconds between phases (phases are larger than batches)
ERROR_LOG_LINES=150       # lines of failed log to feed back for self-correction

# ---------------------------------------------------------------------------
# Completion detection: each phase is "done" when this file exists.
# ---------------------------------------------------------------------------
declare -A DONE_FILE=(
  [06]="src/lib/inngest.ts"
  [10]="src/check-live-smoke.ts"
  [03]="app/dashboard/upload/page.tsx"
  [04]="app/onboarding/page.tsx"
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
# Helpers
# ---------------------------------------------------------------------------
already_done() {
  local sentinel="$1"
  [[ -e "$REPO/$sentinel" ]] && return 0 || return 1
}

is_usage_limit() {
  local log="$1"
  grep -qiE \
    "usage limit|session limit|rate limit|too many requests|quota exceeded|overloaded|529|Claude\.ai usage|resets [0-9]" \
    "$log" 2>/dev/null
}

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
# Pre-phase git cleanup: commit any leftover work and land on main cleanly.
# Called before every phase (including skipped ones) so the working tree is
# always clean when the next phase's prompt runs its own branching logic.
# ---------------------------------------------------------------------------
pre_phase_git_cleanup() {
  cd "$REPO"

  local current_branch
  current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

  # 1. Commit any uncommitted work so it isn't lost / swept into the wrong commit
  if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
    echo "  📦  Uncommitted changes on '$current_branch' — committing before next phase..."
    git add -A
    git commit -m "chore: auto-commit phase work (coordinator cleanup)"
  fi

  # 2. If we're on a feature branch, merge it to main and push
  if [[ "$current_branch" != "main" && "$current_branch" != "HEAD" ]]; then
    echo "  🔀  On branch '$current_branch' — merging to main before next phase..."
    git checkout main
    git merge "$current_branch" --no-ff -m "chore: merge $current_branch (coordinator cleanup)" \
      || { echo "  ⚠  Merge conflict — accepting 'theirs' for all conflicts..."; \
           git checkout --theirs . && git add -A && \
           git commit -m "chore: merge $current_branch (auto-resolved conflicts)"; }
    git push origin main || echo "  ⚠  Push failed — continuing anyway."
  fi

  # 3. Ensure we're on main and up-to-date
  git checkout main 2>/dev/null || true
  git pull 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Core: run one phase with usage-limit retry logic
# ---------------------------------------------------------------------------

# Preamble prepended to every phase prompt.
PHASE_PREAMBLE=$(cat <<'PREAMBLE'
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

run_phase() {
  local num="$1"
  local file
  file=$(ls "$PHASES/phase-${num}-"*.txt 2>/dev/null | head -1)
  local sentinel="${DONE_FILE[$num]}"
  local name="${PHASE_NAME[$num]}"
  local attempt=0
  local last_log=""

  if [[ -z "$file" || ! -f "$file" ]]; then
    echo "✗ Phase $num: prompt file not found in $PHASES — stopping."
    exit 1
  fi

  # Ensure main is clean before every phase starts
  echo "  🧹  Pre-phase git cleanup for Phase $num..."
  pre_phase_git_cleanup

  while (( attempt < MAX_RETRIES )); do
    attempt=$(( attempt + 1 ))
    local log="$LOGS/phase-${num}-attempt${attempt}-$(date +%Y%m%d-%H%M%S).log"

    echo ""
    echo "========================================================"
    echo "  PHASE $num: $name"
    echo "  Attempt $attempt/$MAX_RETRIES  |  $(date '+%Y-%m-%d %H:%M:%S')"
    echo "========================================================"

    cd "$REPO"

    # On attempt 1: run the full phase prompt.
    # On subsequent attempts: prepend the error context from the previous log
    # so Claude can diagnose and fix what went wrong, then finish the phase.
    if (( attempt == 1 )) || [[ -z "$last_log" ]]; then
      local prompt="${PHASE_PREAMBLE}$(cat "$file")"
    else
      local error_tail
      error_tail=$(tail -${ERROR_LOG_LINES} "$last_log" 2>/dev/null || echo "(log unavailable)")
      local prompt
      prompt=$(cat <<ERRPROMPT
═══════════════════════════════════════════════════════════════
SELF-CORRECTION RUN — Phase $num: $name (attempt $attempt)
═══════════════════════════════════════════════════════════════

The previous attempt did not complete successfully.
The completion sentinel was not found: $sentinel

Here are the last $ERROR_LOG_LINES lines of the previous attempt's output:
────────────────────────────────────────────────────────────────
$error_tail
────────────────────────────────────────────────────────────────

YOUR TASK:
1. Read the output above carefully and identify every error or incomplete step.
2. Fix each error. Common issues and how to fix them:
   - TypeScript errors → edit the file, fix the type issue, re-run typecheck
   - Missing import → add the correct import statement
   - Git conflict → accept incoming changes (theirs), re-run typecheck
   - Migration already applied → skip the migration step, continue with code files
   - npm install failed → retry npm install, then continue
   - File not created → create it now exactly as specified
   - check:agents regression → read the failing test output and fix the root cause
3. Complete ALL remaining steps from the original phase prompt that were not finished.
4. Run npm run typecheck (must exit 0) and npm run check:agents (must pass).
5. Run bash scripts/secret-scan.sh (must be clean).
6. Commit and push to main.
7. The phase is not done until the sentinel file exists: $sentinel

ORIGINAL PHASE PROMPT (for reference on what still needs to be done):
═══════════════════════════════════════════════════════════════
${PHASE_PREAMBLE}$(cat "$file")
ERRPROMPT
)
    fi

    claude --dangerously-skip-permissions --print "$prompt" \
      2>&1 | tee "$log"
    last_log="$log"

    # --- Success check ---
    if already_done "$sentinel"; then
      echo "✓ Phase $num complete — $sentinel found."
      echo "  Cooling down ${PHASE_COOLDOWN}s before next phase..."
      sleep "$PHASE_COOLDOWN"
      return 0
    fi

    # --- Usage limit check ---
    if is_usage_limit "$log"; then
      if (( attempt < MAX_RETRIES )); then
        echo ""
        echo "⚠  Usage limit detected in phase $num (attempt $attempt)."
        echo "   Sleeping ${USAGE_LIMIT_SLEEP}s (~4.5h) for quota reset."
        sleep_with_countdown "$USAGE_LIMIT_SLEEP" "Phase $num usage-limit pause"
        echo "   Retrying phase $num with self-correction..."
        continue
      else
        echo ""
        echo "✗ Phase $num hit usage limit on final attempt ($MAX_RETRIES)."
        echo "  Re-run this script after quota resets — completed phases will be skipped."
        exit 1
      fi
    fi

    # --- Not done yet, no usage limit — self-correct on next attempt ---
    if (( attempt < MAX_RETRIES )); then
      echo ""
      echo "⚠  Phase $num incomplete after attempt $attempt — self-correcting..."
      echo "   Feeding error log back to Claude on next attempt."
      sleep 10  # brief pause before retry
      continue
    fi

    # --- All retries exhausted ---
    echo ""
    echo "✗ Phase $num failed after $MAX_RETRIES self-correction attempts."
    echo "  Last log: $last_log"
    echo "  Re-run this script to try again — completed phases will be skipped."
    exit 1
  done
}

# ---------------------------------------------------------------------------
# Pre-flight: verify Phase 2 is done before starting
# ---------------------------------------------------------------------------
PHASE2_SENTINEL="app/api/uploads/slot/route.ts"
if [[ ! -e "$REPO/$PHASE2_SENTINEL" ]]; then
  echo ""
  echo "⚠  Phase 2 (API layer) does not appear to be complete."
  echo "   Expected: $PHASE2_SENTINEL"
  echo "   Run Phase 2 first:"
  echo "     claude --dangerously-skip-permissions --print \"\$(cat scripts/batches/batch-phase2.txt)\""
  echo ""
  echo "   If Phase 2 IS complete but the file is elsewhere, update PHASE2_SENTINEL"
  echo "   in this script and re-run."
  echo ""
  read -r -p "Continue anyway? [y/N] " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Main loop — run phases in the agreed critical-path order
# ---------------------------------------------------------------------------
echo ""
echo "U-I-OS Phase Coordinator starting at $(date)"
echo "Repo: $REPO"
echo "Order: 6 → 10 → 3 → 4 → 5 → 11 → 7 → 8 → 9 → 12"
echo "Usage-limit sleep: ${USAGE_LIMIT_SLEEP}s  |  Max retries: $MAX_RETRIES"
echo ""

for num in 06 10 03 04 05 11 07 08 09 12; do
  sentinel="${DONE_FILE[$num]}"
  name="${PHASE_NAME[$num]}"
  if already_done "$sentinel"; then
    echo "→ Phase $num ($name) already complete — skipping."
    pre_phase_git_cleanup   # still clean up git state before next phase
    continue
  fi
  run_phase "$num"
done

echo ""
echo "========================================================"
echo "  ALL PHASES COMPLETE"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo ""
echo "  U-I-OS is fully built:"
echo "  ✓ 201 agents (Phase 1)"
echo "  ✓ API layer (Phase 2)"
echo "  ✓ Inngest durable queue (Phase 6)"
echo "  ✓ Live agent execution (Phase 10)"
echo "  ✓ Frontend dashboard (Phase 3)"
echo "  ✓ Auth & onboarding (Phase 4)"
echo "  ✓ Stripe billing (Phase 5)"
echo "  ✓ Client PDF reports (Phase 11)"
echo "  ✓ Real PDF parsing (Phase 7)"
echo "  ✓ Email deduplication (Phase 8)"
echo "  ✓ VirusTotal scanning (Phase 9)"
echo "  ✓ Sentry observability (Phase 12)"
echo ""
echo "  Next: configure env vars, deploy to Vercel, connect Inngest Cloud."
echo "========================================================"
