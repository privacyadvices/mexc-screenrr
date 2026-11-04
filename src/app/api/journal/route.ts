import { NextRequest, NextResponse } from "next/server";
import { getJournalPayload, RANGE_MS } from "@/lib/server/journalAnalytics";
import type { JournalRangeKey } from "@/lib/journal";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const search = req.nextUrl.searchParams;
    const rangeKey = (search.get("range") as JournalRangeKey) || "all";
    const validRange = rangeKey in RANGE_MS ? rangeKey : "all";
    const payload = await getJournalPayload(validRange);
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to build journal payload",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
