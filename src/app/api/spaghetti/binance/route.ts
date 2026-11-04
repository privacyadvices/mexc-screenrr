import { NextResponse } from "next/server";
import { getSpaghettiPayload } from "@/lib/server/marketData";

export async function GET() {
  try {
    const payload = await getSpaghettiPayload("binance");
    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "public, s-maxage=30, stale-while-revalidate=90",
      },
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({
      asOf: Date.now(),
      rows: [],
      warning: `Binance API unavailable from current IP: ${details}`,
    });
  }
}
