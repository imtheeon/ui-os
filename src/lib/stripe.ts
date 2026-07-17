/**
 * Stripe client singleton + tier mapping.
 *
 * STRIPE_SECRET_KEY is env-only (see .env.example) — never hardcode it here.
 * If it's absent (e.g. local dev without billing configured), `stripe` is
 * `null` and every billing route returns 503 instead of throwing.
 */
import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.warn("[stripe] STRIPE_SECRET_KEY not set — billing routes will fail.");
}

export const stripe = key
  ? new Stripe(key, { apiVersion: "2026-06-24.dahlia" })
  : null;

/** Map Stripe price IDs to our tiers. Set in env. */
export const PRICE_TO_TIER: Record<string, "pro" | "enterprise"> = {
  [process.env.STRIPE_PRICE_PRO ?? ""]: "pro",
  [process.env.STRIPE_PRICE_ENTERPRISE ?? ""]: "enterprise",
};

export function tierFromPriceId(priceId: string): "pro" | "enterprise" | null {
  return PRICE_TO_TIER[priceId] ?? null;
}
