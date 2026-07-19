#!/bin/bash -l
# Login shell (-l) ensures WSL nvm/node PATH loads, not Windows interop PATH
set -euo pipefail

OUTFILE="$HOME/ui-os/tc_output.txt"
echo "=== typecheck $(date) ===" > "$OUTFILE"
echo "npm: $(which npm)" >> "$OUTFILE"
echo "node: $(which node)" >> "$OUTFILE"

cd ~/ui-os
npm run typecheck >> "$OUTFILE" 2>&1
TC=$?
echo "TC_EXIT:$TC" >> "$OUTFILE"

if [ $TC -eq 0 ]; then
  echo "=== typecheck PASSED — running git ===" >> "$OUTFILE"
  git add -A >> "$OUTFILE" 2>&1
  git commit -m "fix: resolveOrgFromSession uses profiles table; middleware hardcoded fallbacks" >> "$OUTFILE" 2>&1
  git push origin main >> "$OUTFILE" 2>&1
  echo "GIT_EXIT:$?" >> "$OUTFILE"
else
  echo "=== typecheck FAILED ===" >> "$OUTFILE"
fi
echo "=== DONE ===" >> "$OUTFILE"
