/**
 * POST /api/billing/checkout
 * Auth: session → orgId (resolveOrgFromSession — the only authorized chokepoint).
 * Body: { tier: "pro" | "enterprise" }
 * Creates a Stripe Checkout session for the org's subscription and returns { url }.
 */
import { type NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { supabaseServer } from "@/src/lib/supabaseServer";
import { resolveOrgFromSession } from "@/src/lib/resolveOrgFromSession";
import { stripe } from "@/src/lib/stripe";

const PRICE_IDS: Record<string, string> = {
  pro: process.env.STRIPE_PRICE_PRO ?? "",
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE ?? "",
};

export async function POST(req: NextRequest) {
  if (!stripe) {
    return NextResponse.json({ error: "Billing not configured" }, { status: 503 });
  }

  const sbClient = await supabaseServer();
  const {
    data: { session },
  } = await sbClient.auth.getSession();
  const orgId = await resolveOrgFromSession(session);
  if (!orgId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { tier?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const tier = body.tier;
  if (tier !== "pro" && tier !== "enterprise") {
    return NextResponse.json({ error: "tier must be pro or enterprise" }, { status: 400 });
  }

  const priceId = PRICE_IDS[tier];
  if (!priceId) {
    return NextResponse.json({ error: "Price not configured" }, { status: 503 });
  }

  const { supabase: db } = await import("@/src/db");
  const { data: org, error: orgErr } = await db
    .from("organizations")
    .select("stripe_customer_id, name")
    .eq("id", orgId)
    .maybeSingle();

  if (orgErr) {
    Sentry.captureException(orgErr);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  try {
    let customerId = org?.stripe_customer_id as string | null | undefined;
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: (org?.name as string) ?? orgId,
        metadata: { org_id: orgId },
      });
      customerId = customer.id;
      await db.from("organizations").update({ stripe_customer_id: customerId }).eq("id", orgId);
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/billing?success=true`,
      cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/billing`,
      metadata: { org_id: orgId },
    });

    return NextResponse.json({ url: checkoutSession.url });
  } catch (err) {
    Sentry.captureException(err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
