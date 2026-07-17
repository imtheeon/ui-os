/**
 * POST /api/webhooks/stripe
 * Stripe → us. Updates organizations.subscription_tier when a subscription
 * is created/updated/canceled. Verified via Stripe-Signature — this is the
 * only trust boundary here, there is no session/org_id resolution.
 *
 * Must read the RAW body for signature verification (req.text(), not .json()).
 */
import { type NextRequest, NextResponse } from "next/server";
import { stripe, tierFromPriceId } from "@/src/lib/stripe";

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

export async function POST(req: NextRequest) {
  if (!stripe || !WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }

  const rawBody = await req.text();
  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    return NextResponse.json({ error: "No signature" }, { status: 400 });
  }

  let event: import("stripe").Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, WEBHOOK_SECRET);
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const { supabase: db } = await import("@/src/db");

  if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated"
  ) {
    const sub = event.data.object as import("stripe").Stripe.Subscription;
    const priceId = sub.items.data[0]?.price.id ?? "";
    const tier = tierFromPriceId(priceId);
    const customerId = sub.customer as string;

    if (tier && sub.status === "active") {
      const { data: updated } = await db
        .from("organizations")
        .update({ subscription_tier: tier })
        .eq("stripe_customer_id", customerId)
        .select("id")
        .maybeSingle();

      if (updated?.id) {
        await db.from("system_audit_logs").insert({
          org_id: updated.id,
          action: "billing.tier_changed",
          log_meta: { tier, stripe_event: event.type },
        });
      }
    }
  }

  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object as import("stripe").Stripe.Subscription;
    const customerId = sub.customer as string;

    const { data: updated } = await db
      .from("organizations")
      .update({ subscription_tier: "free" })
      .eq("stripe_customer_id", customerId)
      .select("id")
      .maybeSingle();

    if (updated?.id) {
      await db.from("system_audit_logs").insert({
        org_id: updated.id,
        action: "billing.tier_changed",
        log_meta: { tier: "free", stripe_event: event.type },
      });
    }
  }

  return NextResponse.json({ received: true });
}
