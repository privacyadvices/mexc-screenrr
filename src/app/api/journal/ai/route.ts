import { NextRequest, NextResponse } from "next/server";
import { getJournalPayload } from "@/lib/server/journalAnalytics";
import { getJournalAiInsights } from "@/lib/server/journalAi";
import type { JournalRangeKey } from "@/lib/journal";

export async function GET(req: NextRequest) {
  try {
    const search = req.nextUrl.searchParams;
    const rangeKey = (search.get("range") as JournalRangeKey) || "all";
    const journal = await getJournalPayload(rangeKey);
    const insights = await getJournalAiInsights(journal);
    return NextResponse.json(insights);
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to generate AI insights",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
