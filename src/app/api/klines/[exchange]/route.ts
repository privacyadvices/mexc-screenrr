import { type NextRequest, NextResponse } from "next/server";
import { acquireMexcKlineSlot, getCached1mKline } from "@/lib/server/marketData";
import type { ExchangeId } from "@/lib/exchange";

export const maxDuration = 60;

export type ChartBar = {
  time: number; // Unix timestamp in seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type CachedBars = {
  at: number;
  bars: ChartBar[];
};

const chartKlineCache = new Map<string, CachedBars>();
const CACHE_TTL_MS = 5_000;

function mapInterval(tvInterval: string): {
  mexc: string;
  bybit: string;
  binance: string;
  hl: string;
  seconds: number;
} {
  switch (tvInterval) {
    case "1":
      return { mexc: "Min1", bybit: "1", binance: "1m", hl: "1m", seconds: 60 };
    case "5":
      return { mexc: "Min5", bybit: "5", binance: "5m", hl: "5m", seconds: 300 };
    case "15":
      return { mexc: "Min15", bybit: "15", binance: "15m", hl: "15m", seconds: 900 };
    case "60":
      return { mexc: "Min60", bybit: "60", binance: "1h", hl: "1h", seconds: 3600 };
    case "240":
      return { mexc: "Hour4", bybit: "240", binance: "4h", hl: "4h", seconds: 14400 };
    case "D":
    case "1D":
      return { mexc: "Day1", bybit: "D", binance: "1d", hl: "1d", seconds: 86400 };
    default:
      return { mexc: "Min15", bybit: "15", binance: "15m", hl: "15m", seconds: 900 };
  }
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ exchange: string }> },
) {
  try {
    const { exchange } = await context.params;
    const ex = exchange.toLowerCase();
    const symbol = (req.nextUrl.searchParams.get("symbol") || "").trim().toUpperCase();
    const tvInterval = (req.nextUrl.searchParams.get("interval") || "15").trim();
    const limit = Math.min(500, Math.max(60, Number(req.nextUrl.searchParams.get("limit")) || 320));

    if (!symbol) {
      return NextResponse.json({ error: "Missing symbol parameter" }, { status: 400 });
    }

    const cacheKey = `${ex}:${symbol}:${tvInterval}:${limit}`;
    const now = Date.now();
    const cached = chartKlineCache.get(cacheKey);
    if (cached && now - cached.at < CACHE_TTL_MS) {
      return NextResponse.json({
        exchange: ex,
        symbol,
        interval: tvInterval,
        bars: cached.bars,
        cached: true,
      });
    }

    const intv = mapInterval(tvInterval);
    let bars: ChartBar[] = [];

    if (ex === "mexc") {
      const endSec = Math.floor(now / 1000);
      const startSec = endSec - limit * intv.seconds;
      const urlsToTry = [
        `https://api.mexc.com/api/v1/contract/kline/${encodeURIComponent(symbol)}?interval=${intv.mexc}&start=${startSec}&end=${endSec}`,
        `https://contract.mexc.com/api/v1/contract/kline/${encodeURIComponent(symbol)}?interval=${intv.mexc}&start=${startSec}&end=${endSec}`,
        `https://api.mexc.com/api/v1/contract/kline/${encodeURIComponent(symbol)}?interval=${intv.mexc}`,
        `https://contract.mexc.com/api/v1/contract/kline/${encodeURIComponent(symbol)}?interval=${intv.mexc}`,
      ];

      for (const url of urlsToTry) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            if (attempt > 0) {
              await acquireMexcKlineSlot();
              await new Promise((r) => setTimeout(r, 200 * attempt));
            }
            const res = await fetch(url, {
              headers: { Accept: "application/json" },
              cache: "no-store",
              signal: AbortSignal.timeout(6_000),
            });
            if (!res.ok) continue;
            const json = (await res.json()) as {
              success?: boolean;
              code?: number;
              data?: {
                time?: number[];
                open?: number[];
                high?: number[];
                low?: number[];
                close?: number[];
                amount?: number[];
                vol?: number[];
              };
            };
            if (json.success === false) {
              continue;
            }
            const d = json.data;
            if (d?.time && d?.open && d?.high && d?.low && d?.close) {
              const len = Math.min(d.time.length, d.open.length, d.high.length, d.low.length, d.close.length);
              const vols = d.amount && d.amount.length === len ? d.amount : d.vol || [];
              const candidateBars: ChartBar[] = [];
              for (let i = 0; i < len; i++) {
                const tRaw = Number(d.time[i]);
                const time = tRaw > 1e11 ? Math.floor(tRaw / 1000) : tRaw;
                const open = Number(d.open[i]);
                const high = Number(d.high[i]);
                const low = Number(d.low[i]);
                const close = Number(d.close[i]);
                const volume = Number(vols[i] ?? 0);
                if (Number.isFinite(time) && Number.isFinite(close) && close > 0) {
                  candidateBars.push({
                    time,
                    open: Number.isFinite(open) && open > 0 ? open : close,
                    high: Number.isFinite(high) && high > 0 ? high : close,
                    low: Number.isFinite(low) && low > 0 ? low : close,
                    close,
                    volume: Number.isFinite(volume) ? volume : 0,
                  });
                }
              }
              if (candidateBars.length > bars.length) {
                bars = candidateBars.slice(-limit);
              }
            }
            if (bars.length > 0) break;
          } catch {
            // Try next attempt or fallback URL
          }
        }
        if (bars.length >= 15) break;
      }
    } else if (ex === "bybit") {
      try {
        const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${encodeURIComponent(symbol)}&interval=${intv.bybit}&limit=${limit}`;
        const res = await fetch(url, {
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: AbortSignal.timeout(6_000),
        });
        if (res.ok) {
          const json = (await res.json()) as {
            retCode?: number;
            result?: { list?: string[][] };
          };
          const list = json.result?.list || [];
          const asc = [...list].reverse();
          for (const r of asc) {
            const time = Math.floor(Number(r[0]) / 1000);
            const open = Number(r[1]);
            const high = Number(r[2]);
            const low = Number(r[3]);
            const close = Number(r[4]);
            const volume = Number(r[6] ?? r[5] ?? 0);
            if (Number.isFinite(time) && Number.isFinite(close) && close > 0) {
              bars.push({ time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
            }
          }
        }
      } catch {
        // Fall back to cached 1m klines below
      }
    } else if (ex === "binance") {
      try {
        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${intv.binance}&limit=${limit}`;
        const res = await fetch(url, {
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: AbortSignal.timeout(6_000),
        });
        if (res.ok) {
          const rows = (await res.json()) as unknown[][];
          if (Array.isArray(rows)) {
            for (const r of rows) {
              const time = Math.floor(Number(r[0]) / 1000);
              const open = Number(r[1]);
              const high = Number(r[2]);
              const low = Number(r[3]);
              const close = Number(r[4]);
              const volume = Number(r[7] ?? r[5] ?? 0);
              if (Number.isFinite(time) && Number.isFinite(close) && close > 0) {
                bars.push({ time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
              }
            }
          }
        }
      } catch {
        // Fall back to cached 1m klines below
      }
    } else if (ex === "hyperliquid") {
      try {
        const coin = symbol.replace(/[-_]?USDT$/i, "").replace(/[-_]?USDC$/i, "");
        const endTime = now;
        const startTime = endTime - limit * intv.seconds * 1000;
        const res = await fetch("https://api.hyperliquid.xyz/info", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            type: "candleSnapshot",
            req: { coin, interval: intv.hl, startTime, endTime },
          }),
          cache: "no-store",
          signal: AbortSignal.timeout(6_000),
        });
        if (res.ok) {
          const candles = (await res.json()) as Array<{
            t: number;
            o: string;
            h: string;
            l: string;
            c: string;
            v: string;
          }>;
          if (Array.isArray(candles)) {
            for (const c of candles) {
              const time = Math.floor(Number(c.t) / 1000);
              const open = Number(c.o);
              const high = Number(c.h);
              const low = Number(c.l);
              const close = Number(c.c);
              const vBase = Number(c.v);
              const volume = Number.isFinite(vBase) && Number.isFinite(close) ? vBase * close : 0;
              if (Number.isFinite(time) && Number.isFinite(close) && close > 0) {
                bars.push({ time, open, high, low, close, volume });
              }
            }
          }
        }
      } catch {
        // Fall back to cached 1m klines below
      }
    }

    if (bars.length === 0 && (ex === "mexc" || ex === "bybit" || ex === "binance" || ex === "hyperliquid")) {
      const cached1m = getCached1mKline(ex as ExchangeId, symbol);
      if (cached1m && cached1m.close.length > 0) {
        const step = Math.max(1, Math.round(intv.seconds / 60));
        const len = cached1m.close.length;
        const baseEndSec = Math.floor(now / 60_000) * 60;
        for (let i = 0; i < len; i += step) {
          const endIdx = Math.min(len - 1, i + step - 1);
          const tSec =
            cached1m.time && cached1m.time[i]
              ? cached1m.time[i]
              : baseEndSec - (len - 1 - i) * 60;
          const open = cached1m.open[i] ?? cached1m.close[i];
          const close = cached1m.close[endIdx];
          let high = open;
          let low = open;
          let volume = 0;
          for (let j = i; j <= endIdx; j++) {
            const h = cached1m.high[j] ?? cached1m.close[j];
            const l = cached1m.low[j] ?? cached1m.close[j];
            if (h > high) high = h;
            if (l < low) low = l;
            volume += cached1m.vol[j] || 0;
          }
          bars.push({ time: tSec, open, high, low, close, volume });
        }
      }
    }

    if (bars.length === 0 && cached && cached.bars.length > 0) {
      bars = cached.bars;
    }

    bars.sort((a, b) => a.time - b.time);
    if (bars.length > 0) {
      chartKlineCache.set(cacheKey, { at: now, bars });
    }

    return NextResponse.json(
      {
        exchange: ex,
        symbol,
        interval: tvInterval,
        intervalSeconds: intv.seconds,
        bars,
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=12, stale-while-revalidate=30",
        },
      },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to fetch chart klines",
        details: error instanceof Error ? error.message : "Unknown error",
        bars: [],
      },
      { status: 502 },
    );
  }
}
