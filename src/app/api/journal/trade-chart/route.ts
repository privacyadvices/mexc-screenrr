import { NextRequest, NextResponse } from "next/server";
import type { TradeChartPayload } from "@/lib/journal";

const MEXC_CONTRACT_BASE = "https://contract.mexc.com";

function asNumbers(values: unknown[]): number[] {
  return values.map((v) => Number(v)).filter((v) => Number.isFinite(v));
}

function toMs(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

export async function GET(req: NextRequest) {
  try {
    const search = req.nextUrl.searchParams;
    const symbol = search.get("symbol")?.toUpperCase();
    const openTime = Number(search.get("openTime"));
    const closeTime = Number(search.get("closeTime"));
    const entryPriceRaw = search.get("entryPrice");
    const exitPriceRaw = search.get("exitPrice");

    if (!symbol || !Number.isFinite(openTime) || !Number.isFinite(closeTime)) {
      return NextResponse.json({ error: "Missing required query params" }, { status: 400 });
    }

    const hold = Math.max(5 * 60_000, closeTime - openTime);
    const pad = Math.max(2 * 60 * 60_000, hold * 0.5);
    const windowStart = openTime - pad;
    const windowEnd = closeTime + pad;

    const startSec = Math.floor(windowStart / 1000);
    const endSec = Math.ceil(windowEnd / 1000);

    // Choose interval so total bars stay within MEXC's 2000-bar response limit
    const spanMinutes = (windowEnd - windowStart) / 60_000;
    const interval = spanMinutes > 1800 * 15 ? "Min60" : spanMinutes > 1800 * 5 ? "Min15" : "Min5";

    const res = await fetch(
      `${MEXC_CONTRACT_BASE}/api/v1/contract/kline/${symbol}?interval=${interval}&start=${startSec}&end=${endSec}`,
      {
        headers: { Accept: "application/json" },
        cache: "no-store",
      },
    );
    if (!res.ok) {
      return NextResponse.json({ error: `MEXC kline fetch failed (${res.status})` }, { status: 502 });
    }

    const body = (await res.json()) as { success?: boolean; data?: { time?: unknown[]; close?: unknown[] } };
    if (!body.success || !body.data?.time || !body.data?.close) {
      return NextResponse.json({ error: "Invalid kline response" }, { status: 502 });
    }

    const time = asNumbers(body.data.time).map(toMs);
    const close = asNumbers(body.data.close);
    const n = Math.min(time.length, close.length);
    const points = [] as TradeChartPayload["points"];
    for (let i = 0; i < n; i += 1) {
      const ts = time[i];
      const px = close[i];
      if (ts >= windowStart && ts <= windowEnd) {
        points.push({ timestamp: ts, close: px });
      }
    }

    const payload: TradeChartPayload = {
      symbol,
      interval: "Min5",
      points,
      entry: { timestamp: openTime, price: entryPriceRaw ? Number(entryPriceRaw) : null },
      exit: { timestamp: closeTime, price: exitPriceRaw ? Number(exitPriceRaw) : null },
      windowStart,
      windowEnd,
    };

    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to build trade chart payload",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
