/**
 * /api/org/api-keys
 *
 * Manage API keys for webhook authentication.
 *
 * GET  → list all keys for the org (prefix, name, created_at, last_used_at)
 * POST → create a new key (body: { name: string })
 *         Returns rawKey ONCE — not stored, cannot be retrieved again.
 * DELETE ?keyId=<uuid> → revoke a key
 */
import { type NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/src/lib/supabaseServer";
import { resolveOrgFromSession } from "@/src/lib/resolveOrgFromSession";
import { generateApiKey } from "@/src/lib/api-key";

async function getAuth(
  req: NextRequest
): Promise<{ orgId: string } | NextResponse> {
  const sbClient = await supabaseServer();
  const {
    data: { session },
  } = await sbClient.auth.getSession();
  const orgId = await resolveOrgFromSession(session);
  if (!orgId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return { orgId };
}

export async function GET(req: NextRequest) {
  const auth = await getAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { orgId } = auth;

  const { supabase: db } = await import("@/src/db");
  const { data, error } = await db
    .from("org_api_keys")
    .select("id, key_prefix, name, created_at, last_used_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  return NextResponse.json({ keys: data ?? [] }, { status: 200 });
}

export async function POST(req: NextRequest) {
  const auth = await getAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { orgId } = auth;

  let body: { name?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.name !== "string" || body.name.trim().length === 0) {
    return NextResponse.json(
      { error: "Body must include name (non-empty string)" },
      { status: 400 }
    );
  }

  const name = body.name.trim().slice(0, 100);
  const { rawKey, keyHash, keyPrefix } = generateApiKey();

  const { supabase: db } = await import("@/src/db");
  const { data, error } = await db
    .from("org_api_keys")
    .insert({ org_id: orgId, key_hash: keyHash, key_prefix: keyPrefix, name })
    .select("id, key_prefix, name, created_at")
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  await db.from("system_audit_logs").insert({
    org_id: orgId,
    action: "api_key.created",
    log_meta: { keyId: data.id, name },
  });

  // Return rawKey ONCE. It is not stored and cannot be retrieved again.
  return NextResponse.json(
    {
      id: data.id,
      key_prefix: data.key_prefix,
      name: data.name,
      created_at: data.created_at,
      rawKey, // ← only time the raw key is visible
    },
    { status: 201 }
  );
}

export async function DELETE(req: NextRequest) {
  const auth = await getAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { orgId } = auth;

  const keyId = req.nextUrl.searchParams.get("keyId");
  if (!keyId) {
    return NextResponse.json(
      { error: "keyId query parameter required" },
      { status: 400 }
    );
  }

  const { supabase: db } = await import("@/src/db");
  const { error } = await db
    .from("org_api_keys")
    .delete()
    .eq("id", keyId)
    .eq("org_id", orgId); // ORG-SCOPED — cannot delete another org's key

  if (error) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  await db.from("system_audit_logs").insert({
    org_id: orgId,
    action: "api_key.revoked",
    log_meta: { keyId },
  });

  return NextResponse.json({ revoked: true }, { status: 200 });
}
