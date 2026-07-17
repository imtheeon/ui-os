"use client";

/**
 * AutoRefresh — re-runs the parent server component on an interval while the
 * payload is still in flight. Server-rendered pages can't poll themselves, so
 * this tiny client island calls router.refresh() every few seconds; the
 * effect re-registers with the freshly-rendered `status` prop each time and
 * stops scheduling once the payload reaches a terminal state.
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";

const POLL_MS = 3000;
const IN_FLIGHT = new Set(["pending", "processing"]);

export default function AutoRefresh({ status }: { status: string }) {
  const router = useRouter();

  useEffect(() => {
    if (!IN_FLIGHT.has(status)) return;
    const t = setTimeout(() => router.refresh(), POLL_MS);
    return () => clearTimeout(t);
  }, [status, router]);

  return null;
}
