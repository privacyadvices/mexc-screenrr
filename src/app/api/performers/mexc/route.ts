import { type NextRequest, NextResponse } from "next/server";
import { fetchTickers, fetchMcapMap, lookupMcap } from "@/lib/server/marketData";

const CACHE_TTL_MS = 15_000;

export type PerformerPeriod = "24h" | "7d" | "30d" | "90d" | "1y";

export type PerformerRow = {
  symbol: string;
  price: number;
  priceScale?: number;
  change24h: number | null;
  change7d: number | null;
  change30d: number | null;
  change90d: number | null;
  change1y: number | null;
  volume24: number;
  oiUsd: number;
  funding: number;
  mcap: number | null;
  basisPct: number | null;
  rangePos24h: number | null;
  maxLeverage: number | null;
  isZeroFee: boolean;
  isNew: boolean;
  isHot: boolean;
  sectors: string[];
};

export type PerformersResponse = {
  asOf: number;
  period: PerformerPeriod;
  totalContracts: number;
  gainers: PerformerRow[];
  losers: PerformerRow[];
};

const cacheByPeriod = new Map<PerformerPeriod, { at: number; payload: PerformersResponse }>();

function changeForPeriod(row: PerformerRow, period: PerformerPeriod): number | null {
  switch (period) {
    case "24h":
      return row.change24h;
    case "7d":
      return row.change7d;
    case "30d":
      return row.change30d;
    case "90d":
      return row.change90d;
    case "1y":
      return row.change1y;
  }
}

async function buildPayload(period: PerformerPeriod): Promise<PerformersResponse> {
  const [tickers, mcapMap] = await Promise.all([
    fetchTickers("mexc"),
    fetchMcapMap().catch(() => new Map<string, number>()),
  ]);

  const rows: PerformerRow[] = tickers.map((t) => ({
    symbol: t.symbol,
    price: t.price,
    priceScale: t.priceScale,
    change24h: t.change24hPct,
    change7d: t.change7dPct ?? null,
    change30d: t.change30dPct ?? null,
    change90d: t.change90dPct ?? null,
    change1y: t.change1yPct ?? null,
    volume24: t.amount24,
    oiUsd: t.oiUsd ?? 0,
    funding: t.fundingRate,
    mcap: lookupMcap(mcapMap, t.symbol),
    basisPct: t.basisPct,
    rangePos24h: t.rangePos24h,
    maxLeverage: t.maxLeverage ?? null,
    isZeroFee: Boolean(t.isZeroFee),
    isNew: Boolean(t.isNew),
    isHot: Boolean(t.isHot),
    sectors: t.sectors ?? [],
  }));

  const validRows = rows.filter((r) => {
    const chg = changeForPeriod(r, period);
    return chg !== null && Number.isFinite(chg);
  });

  const gainers = [...validRows]
    .filter((r) => (changeForPeriod(r, period) ?? 0) > 0)
    .sort((a, b) => (changeForPeriod(b, period) ?? 0) - (changeForPeriod(a, period) ?? 0))
    .slice(0, 150);

  const losers = [...validRows]
    .filter((r) => (changeForPeriod(r, period) ?? 0) < 0)
    .sort((a, b) => (changeForPeriod(a, period) ?? 0) - (changeForPeriod(b, period) ?? 0))
    .slice(0, 150);

  return {
    asOf: Date.now(),
    period,
    totalContracts: tickers.length,
    gainers,
    losers,
  };
}

export async function GET(req: NextRequest) {
  const rawPeriod = req.nextUrl.searchParams.get("period") || "24h";
  const validPeriods: PerformerPeriod[] = ["24h", "7d", "30d", "90d", "1y"];
  if (!validPeriods.includes(rawPeriod as PerformerPeriod)) {
    return NextResponse.json(
      { error: "Invalid period. Use 24h, 7d, 30d, 90d, or 1y" },
      { status: 400 },
    );
  }
  const period = rawPeriod as PerformerPeriod;

  try {
    const now = Date.now();
    const cached = cacheByPeriod.get(period);
    if (cached && now - cached.at < CACHE_TTL_MS) {
      return NextResponse.json(cached.payload, {
        headers: {
          "Cache-Control": "public, s-maxage=20, stale-while-revalidate=60",
        },
      });
    }

    const payload = await buildPayload(period);
    cacheByPeriod.set(period, { at: Date.now(), payload });
    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "public, s-maxage=20, stale-while-revalidate=60",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to build performers payload",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}