import { NextResponse } from "next/server";
import { getSpaghettiPayload } from "@/lib/server/marketData";

export async function GET() {
  try {
    const payload = await getSpaghettiPayload("gate");
    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "public, s-maxage=30, stale-while-revalidate=90",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to build Gate.io spaghetti payload",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
