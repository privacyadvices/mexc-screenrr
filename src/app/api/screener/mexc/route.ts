import { type NextRequest, NextResponse } from "next/server";
import { getScreenerPayload, getCachedScreener } from "@/lib/server/marketData";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    const extraRaw = req.nextUrl.searchParams.get("symbols") || "";
    const extraSymbols = extraRaw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 25);

    const partialOnly = req.nextUrl.searchParams.get("partial") === "1" && extraSymbols.length > 0;
    const payload = await getScreenerPayload("mexc", extraSymbols, partialOnly);
    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": partialOnly
          ? "public, s-maxage=30, stale-while-revalidate=90"
          : "public, s-maxage=15, stale-while-revalidate=45",
      },
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : "Unknown error";
    const cached = getCachedScreener("mexc");
    if (cached) {
      return NextResponse.json({
        ...cached,
        warning: `Using cached data (fetch failed: ${details})`,
        cached: true,
      });
    }
    return NextResponse.json(
      {
        error: "Failed to build screener",
        details,
      },
      { status: 500 },
    );
  }
}
