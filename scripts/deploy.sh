#!/usr/bin/env bash
# =============================================================================
# U-I-OS Vercel Deployment Script
#
# USAGE:
#   bash scripts/deploy.sh
#
# What it does:
#   1. Checks prerequisites (Vercel CLI, logged in)
#   2. Prompts for every required env var and adds to Vercel project
#   3. Deploys to production
#   4. Prints post-deploy checklist (Stripe webhook, Inngest endpoint)
# =============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

banner() { echo -e "\n${BOLD}═══ $1 ═══${NC}"; }
ok()     { echo -e "  ${GREEN}✓${NC}  $1"; }
warn()   { echo -e "  ${YELLOW}⚠${NC}   $1"; }
ask()    { # ask <VAR_NAME> <prompt> [secret]
  local var="$1" prompt="$2" secret="${3:-}"
  local val=""
  if [[ -n "$secret" ]]; then
    read -rsp "  ${prompt}: " val; echo
  else
    read -rp  "  ${prompt}: " val
  fi
  eval "$var='$val'"
}

# ---------------------------------------------------------------------------
banner "STEP 1 — Prerequisites"
# ---------------------------------------------------------------------------

if ! command -v vercel &>/dev/null; then
  echo -e "  ${RED}✗${NC}  Vercel CLI not found. Installing..."
  npm install -g vercel
fi
ok "Vercel CLI: $(vercel --version 2>/dev/null | head -1)"

# Check login
if ! vercel whoami &>/dev/null; then
  warn "Not logged in to Vercel. Running 'vercel login'..."
  vercel login
fi
ok "Logged in as: $(vercel whoami)"

# ---------------------------------------------------------------------------
banner "STEP 2 — Link project (first run only)"
# ---------------------------------------------------------------------------

if [[ ! -f .vercel/project.json ]]; then
  echo "  Linking to Vercel project..."
  vercel link
else
  ok "Already linked: $(cat .vercel/project.json | grep -o '"projectId":"[^"]*"' | cut -d'"' -f4)"
fi

# ---------------------------------------------------------------------------
banner "STEP 3 — Set environment variables"
# ---------------------------------------------------------------------------

echo "  You'll be prompted for each secret. Press Enter to skip any you'll set later."
echo "  All values are added to Production + Preview + Development."
echo ""

add_env() {
  local key="$1" val="$2"
  if [[ -z "$val" ]]; then
    warn "Skipping $key (empty)"
    return
  fi
  echo "$val" | vercel env add "$key" production 2>/dev/null || true
  echo "$val" | vercel env add "$key" preview    2>/dev/null || true
  echo "$val" | vercel env add "$key" development 2>/dev/null || true
  ok "Set $key"
}

# Supabase
echo -e "\n  ${BOLD}— Supabase —${NC}"
echo "  (Settings > API in your Supabase project dashboard)"
ask SUPABASE_URL          "NEXT_PUBLIC_SUPABASE_URL (https://xxx.supabase.co)"
ask SUPABASE_ANON         "NEXT_PUBLIC_SUPABASE_ANON_KEY" secret
ask SUPABASE_SERVICE_ROLE "SUPABASE_SERVICE_ROLE_KEY" secret

add_env "NEXT_PUBLIC_SUPABASE_URL"   "$SUPABASE_URL"
add_env "NEXT_PUBLIC_SUPABASE_ANON_KEY" "$SUPABASE_ANON"
add_env "SUPABASE_URL"               "$SUPABASE_URL"
add_env "SUPABASE_SERVICE_ROLE_KEY"  "$SUPABASE_SERVICE_ROLE"

# Anthropic
echo -e "\n  ${BOLD}— Anthropic —${NC}"
echo "  (console.anthropic.com → API Keys)"
ask ANTHROPIC_API_KEY "ANTHROPIC_API_KEY" secret
add_env "ANTHROPIC_API_KEY" "$ANTHROPIC_API_KEY"

# Inngest
echo -e "\n  ${BOLD}— Inngest —${NC}"
echo "  (app.inngest.com → your app → Manage → Keys)"
ask INNGEST_EVENT_KEY   "INNGEST_EVENT_KEY" secret
ask INNGEST_SIGNING_KEY "INNGEST_SIGNING_KEY" secret
add_env "INNGEST_EVENT_KEY"   "$INNGEST_EVENT_KEY"
add_env "INNGEST_SIGNING_KEY" "$INNGEST_SIGNING_KEY"

# Stripe
echo -e "\n  ${BOLD}— Stripe —${NC}"
echo "  (dashboard.stripe.com → Developers → API Keys + Products)"
ask STRIPE_SECRET_KEY       "STRIPE_SECRET_KEY (sk_live_...)" secret
ask STRIPE_WEBHOOK_SECRET   "STRIPE_WEBHOOK_SECRET (whsec_... — set after deploy)" secret
ask STRIPE_PRICE_PRO        "STRIPE_PRICE_PRO (price_... for Pro plan)"
ask STRIPE_PRICE_ENTERPRISE "STRIPE_PRICE_ENTERPRISE (price_... for Enterprise plan)"
add_env "STRIPE_SECRET_KEY"       "$STRIPE_SECRET_KEY"
add_env "STRIPE_WEBHOOK_SECRET"   "$STRIPE_WEBHOOK_SECRET"
add_env "STRIPE_PRICE_PRO"        "$STRIPE_PRICE_PRO"
add_env "STRIPE_PRICE_ENTERPRISE" "$STRIPE_PRICE_ENTERPRISE"

# Resend
echo -e "\n  ${BOLD}— Resend —${NC}"
echo "  (resend.com → API Keys)"
ask RESEND_API_KEY    "RESEND_API_KEY" secret
ask RESEND_FROM_EMAIL "RESEND_FROM_EMAIL (e.g. reports@yourdomain.com)"
add_env "RESEND_API_KEY"    "$RESEND_API_KEY"
add_env "RESEND_FROM_EMAIL" "${RESEND_FROM_EMAIL:-reports@uios.app}"

# Sentry
echo -e "\n  ${BOLD}— Sentry —${NC}"
echo "  (sentry.io → Settings → Projects → your project → Client Keys)"
ask SENTRY_DSN        "NEXT_PUBLIC_SENTRY_DSN"
ask SENTRY_AUTH_TOKEN "SENTRY_AUTH_TOKEN (for source maps upload)" secret
ask SENTRY_ORG        "SENTRY_ORG (your Sentry org slug)"
ask SENTRY_PROJECT    "SENTRY_PROJECT (your Sentry project slug)"
add_env "NEXT_PUBLIC_SENTRY_DSN" "$SENTRY_DSN"
add_env "SENTRY_AUTH_TOKEN"      "$SENTRY_AUTH_TOKEN"
add_env "SENTRY_ORG"             "$SENTRY_ORG"
add_env "SENTRY_PROJECT"         "$SENTRY_PROJECT"

# VirusTotal
echo -e "\n  ${BOLD}— VirusTotal (optional) —${NC}"
echo "  (virustotal.com/gui/join-us — free tier works)"
ask VIRUSTOTAL_API_KEY "VIRUSTOTAL_API_KEY (Enter to skip)"
add_env "VIRUSTOTAL_API_KEY" "$VIRUSTOTAL_API_KEY"

# BigQuery encryption key
echo -e "\n  ${BOLD}— BigQuery encryption key —${NC}"
BQKEY=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p)
echo "  Auto-generated: $BQKEY"
echo "  (Save this somewhere safe — you'll need it to decrypt stored BigQuery keys)"
add_env "BIGQUERY_ENCRYPTION_KEY" "$BQKEY"

# ---------------------------------------------------------------------------
banner "STEP 4 — Deploy to production"
# ---------------------------------------------------------------------------

echo "  Running: vercel --prod"
vercel --prod

# Capture the deployment URL
DEPLOY_URL=$(vercel ls --prod 2>/dev/null | grep "https://" | head -1 | awk '{print $2}' || echo "https://your-project.vercel.app")

# Set NEXT_PUBLIC_APP_URL now that we have the real URL
echo ""
read -rp "  Enter your production URL (e.g. https://ui-os.vercel.app): " PROD_URL
PROD_URL="${PROD_URL:-$DEPLOY_URL}"
add_env "NEXT_PUBLIC_APP_URL" "$PROD_URL"

# Redeploy with the app URL set
echo "  Redeploying with NEXT_PUBLIC_APP_URL set..."
vercel --prod

# ---------------------------------------------------------------------------
banner "STEP 5 — Post-deploy checklist"
# ---------------------------------------------------------------------------

echo ""
echo -e "  ${BOLD}Complete these steps in external dashboards:${NC}"
echo ""
echo -e "  ${YELLOW}1. Stripe webhook${NC}"
echo "     → dashboard.stripe.com → Webhooks → Add endpoint"
echo "     URL: ${PROD_URL}/api/webhooks/stripe"
echo "     Events: customer.subscription.created"
echo "              customer.subscription.updated"
echo "              customer.subscription.deleted"
echo "     → Copy 'Signing secret' → paste as STRIPE_WEBHOOK_SECRET in Vercel"
echo "     → Vercel → Settings → Env Vars → redeploy"
echo ""
echo -e "  ${YELLOW}2. Inngest sync${NC}"
echo "     → app.inngest.com → your app → Manage → Sync new URL"
echo "     URL: ${PROD_URL}/api/inngest"
echo ""
echo -e "  ${YELLOW}3. Supabase Storage bucket${NC}"
echo "     → supabase.com → Storage → New bucket"
echo "     Name: 'reports'   (private)"
echo "     Name: 'uploads'   (private)"
echo ""
echo -e "  ${YELLOW}4. Supabase Auth redirect URLs${NC}"
echo "     → Authentication → URL Configuration"
echo "     Site URL: ${PROD_URL}"
echo "     Redirect URLs: ${PROD_URL}/api/auth/callback"
echo ""
echo -e "  ${GREEN}${BOLD}Deployment complete!${NC}"
echo "  Dashboard: ${PROD_URL}/dashboard"
echo "  Login:     ${PROD_URL}/login"
echo ""
