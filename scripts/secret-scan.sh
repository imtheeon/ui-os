#!/usr/bin/env bash
# Pre-push secret scan over STAGED content (git grep --cached). Repo is PUBLIC.
# Exits non-zero if a real secret value pattern appears in staged files.
set -euo pipefail

# Patterns require an actual value, so documentation that merely NAMES a var
# (e.g. "ANTHROPIC_API_KEY" in prose) does not match.
PATTERNS='sb_secret_[A-Za-z0-9]{8,}|service_role"?\s*:\s*"|SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*"?eyJ|sk-ant-[A-Za-z0-9_-]{20,}|ANTHROPIC_API_KEY\s*[:=]\s*"?sk-ant-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}|-----BEGIN (RSA|EC|OPENSSH|PRIVATE) KEY-----'

# Scans all code/config/env. Excludes docs/superpowers/ (design specs + plans)
# because those deliberately document the secret-pattern strings themselves as
# part of describing this very discipline — real secrets never live there.
if git grep --cached -nE "$PATTERNS" -- . ':(exclude)docs/superpowers/' ; then
  echo ">>> SECRET PATTERN FOUND in staged content — aborting." >&2
  exit 1
fi
echo ">>> secret-scan clean (no secret values in staged content)"
