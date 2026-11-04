"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { TIMEFRAMES, TIMEFRAME_TO_MINUTES, formatNumber, type Timeframe } from "@/lib/screener";
import {
  EXCHANGE_LABEL,
  exchangePath,
  exchangeSpaghettiPath,
  toDisplaySymbol,
  toExchangeTradeUrl,
  toTradingViewChartUrl,
  type ExchangeId,
} from "@/lib/exchange";

type Mode = "price" | "volume";

type SpaghettiRow = {
  symbol: string;
  amount24: number;
  close: number[];
  vol: number[];
};

type SpaghettiResponse = {
  asOf: number;
  rows: SpaghettiRow[];
  warning?: string;
};

type DerivedSeries = {
  symbol: string;
  amount24: number;
  points: number[];
  lastClose: number | null;
};

const CHART_W = 1200;
const CHART_H = 440;
const PAD_X = 56;
const PAD_Y = 28;

function hashSymbol(symbol: string): number {
  let h = 0;
  for (let i = 0; i < symbol.length; i += 1) {
    h = (h * 31 + symbol.charCodeAt(i)) >>> 0;
  }
  return h;
}

function colorForSymbol(symbol: string): string {
  const h = hashSymbol(symbol) % 360;
  return `hsl(${h} 82% 64%)`;
}

function normalizePrice(values: number[]): number[] {
  if (!values.length || values[0] === 0) return [];
  const base = values[0];
  return values.map((v) => ((v - base) / base) * 100);
}

function normalizeVolume(values: number[]): number[] {
  if (!values.length) return [];
  const mean = values.reduce((acc, v) => acc + v, 0) / values.length;
  if (!mean) return [];
  return values.map((v) => ((v - mean) / mean) * 100);
}

function yForValue(v: number, min: number, max: number): number {
  const range = max - min || 1;
  const yRange = CHART_H - PAD_Y * 2;
  return PAD_Y + (1 - (v - min) / range) * yRange;
}

function chartPoints(values: number[], min: number, max: number): string {
  if (!values.length) return "";
  const xRange = CHART_W - PAD_X * 2;
  return values
    .map((v, i) => {
      const x = PAD_X + (i / Math.max(1, values.length - 1)) * xRange;
      const y = yForValue(v, min, max);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

export default function SpaghettiChartPage({ mode, exchange = "mexc" }: { mode: Mode; exchange?: ExchangeId }) {
  const [data, setData] = useState<SpaghettiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState<Timeframe>("4h");
  const [query, setQuery] = useState("");
  const [hideKeywords, setHideKeywords] = useState("");
  const [topN, setTopN] = useState(40);
  const [hoveredSymbol, setHoveredSymbol] = useState<string | null>(null);
  const [lockedSymbol, setLockedSymbol] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const endpoint = `/api/spaghetti/${exchange}`;
        const res = await fetch(endpoint);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = (await res.json()) as SpaghettiResponse;
        if (!alive) return;
        setData(payload);
        setWarning(payload.warning ?? null);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "Failed to load spaghetti data");
        setWarning(null);
      } finally {
        if (alive) setLoading(false);
      }
    };

    void load();
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void load();
    }, 90_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [exchange]);

  const bars = Math.max(2, Math.floor(TIMEFRAME_TO_MINUTES[timeframe] / 5));

  const series = useMemo(() => {
    if (!data) return [] as DerivedSeries[];

    const hide = hideKeywords
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean);

    const filtered = data.rows
      .filter((row) => {
        if (query && !row.symbol.toLowerCase().includes(query.trim().toLowerCase())) return false;
        if (hide.some((k) => row.symbol.includes(k))) return false;
        return true;
      })
      .sort((a, b) => b.amount24 - a.amount24)
      .slice(0, Math.max(5, topN));

    const out: DerivedSeries[] = [];
    for (const row of filtered) {
      const source = mode === "price" ? row.close : row.vol;
      if (!source || source.length < 2) continue;
      const window = source.slice(-bars);
      const points = mode === "price" ? normalizePrice(window) : normalizeVolume(window);
      if (points.length < 2 || points.some((v) => !Number.isFinite(v))) continue;
      out.push({
        symbol: row.symbol,
        amount24: row.amount24,
        points,
        lastClose: row.close.at(-1) ?? null,
      });
    }

    return out;
  }, [bars, data, hideKeywords, mode, query, topN]);

  const yBounds = useMemo(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const s of series) {
      for (const v of s.points) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: -5, max: 5 };
    min = Math.min(min, 0);
    max = Math.max(max, 0);
    if (min === max) return { min: min - 1, max: max + 1 };
    return { min, max };
  }, [series]);

  const winners = useMemo(
    () => [...series].sort((a, b) => (b.points.at(-1) ?? 0) - (a.points.at(-1) ?? 0)).slice(0, 12),
    [series],
  );

  const laggards = useMemo(
    () => [...series].sort((a, b) => (a.points.at(-1) ?? 0) - (b.points.at(-1) ?? 0)).slice(0, 12),
    [series],
  );

  const activeSymbol = hoveredSymbol ?? lockedSymbol;
  const activeSeries = useMemo(
    () => series.find((s) => s.symbol === activeSymbol) ?? null,
    [series, activeSymbol],
  );

  const zeroY = yForValue(0, yBounds.min, yBounds.max);
  const midHigh = yBounds.max * 0.5;
  const midLow = yBounds.min * 0.5;

  const modeTitle = `${EXCHANGE_LABEL[exchange]} ${mode === "price" ? "Price Spaghetti" : "Volume Spaghetti"}`;
  const axisLabel = mode === "price" ? "Normalized Return vs Period Open (%)" : "USDT Volume Deviation vs Window Mean (%)";

  return (
    <div className="min-h-screen bg-[#06080c] text-zinc-200">
      <div className="mx-auto max-w-[1800px] px-3 py-3 sm:px-4">
        <header className="sticky top-0 z-40 rounded-xl border border-zinc-800/80 bg-[#0b0e15]/95 p-3 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h1 className="text-base font-bold tracking-tight text-zinc-100">{modeTitle}</h1>
              <p className="font-mono text-[11px] text-zinc-500">
                {series.length} contracts • {timeframe} window ({bars} × 5m bars) • as of {data ? new Date(data.asOf).toLocaleTimeString() : "--:--:--"}
              </p>
            </div>

            <nav className="flex flex-wrap items-center gap-1.5 text-xs">
              <Link href={exchangePath(exchange)} className="rounded border border-zinc-700 bg-[#121621] px-2.5 py-1.5 text-zinc-300 hover:border-zinc-500">
                {EXCHANGE_LABEL[exchange]} Screener
              </Link>
              <Link
                href={exchangeSpaghettiPath(exchange, "price")}
                className={`rounded border px-2.5 py-1.5 ${mode === "price" ? "border-cyan-500/50 bg-cyan-500/15 text-cyan-200 font-semibold" : "border-zinc-700 bg-[#121621] text-zinc-300"}`}
              >
                Price Mode
              </Link>
              <Link
                href={exchangeSpaghettiPath(exchange, "volume")}
                className={`rounded border px-2.5 py-1.5 ${mode === "volume" ? "border-cyan-500/50 bg-cyan-500/15 text-cyan-200 font-semibold" : "border-zinc-700 bg-[#121621] text-zinc-300"}`}
              >
                Volume Mode
              </Link>
              <div className="h-4 w-px bg-zinc-800" />
              {(["mexc", "bybit", "binance", "hyperliquid"] as ExchangeId[]).map((ex) => (
                <Link
                  key={ex}
                  href={exchangeSpaghettiPath(ex, mode)}
                  className={`rounded border px-2.5 py-1.5 ${exchange === ex ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-200 font-semibold" : "border-zinc-700 bg-[#121621] text-zinc-400"}`}
                >
                  {EXCHANGE_LABEL[ex]}
                </Link>
              ))}
              <div className="h-4 w-px bg-zinc-800" />
              <Link href="/screener/performers" className="rounded border border-zinc-700 bg-[#121621] px-2.5 py-1.5 text-zinc-300 hover:border-zinc-500">
                Performers
              </Link>
              <Link href="/screener/watchlist" className="rounded border border-zinc-700 bg-[#121621] px-2.5 py-1.5 text-zinc-300 hover:border-zinc-500">
                Watchlist
              </Link>
            </nav>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-2 text-xs">
            <div className="flex items-center gap-1 rounded border border-zinc-800 bg-[#0d111a] p-0.5">
              {TIMEFRAMES.map((tf) => (
                <button
                  key={tf}
                  onClick={() => setTimeframe(tf)}
                  className={`rounded px-2 py-1 text-[11px] font-medium transition ${
                    timeframe === tf ? "bg-cyan-500/20 text-cyan-200 border border-cyan-500/40" : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {tf}
                </button>
              ))}
            </div>

            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter symbol..."
              className="h-8 rounded border border-zinc-800 bg-[#0e121b] px-2.5 text-xs outline-none placeholder:text-zinc-600 focus:border-cyan-500/50"
            />
            <input
              value={hideKeywords}
              onChange={(e) => setHideKeywords(e.target.value)}
              placeholder="Exclude: BTC,ETH,SOL"
              className="h-8 w-44 rounded border border-zinc-800 bg-[#0e121b] px-2.5 text-xs outline-none placeholder:text-zinc-600 focus:border-cyan-500/50"
            />
            <label className="text-[11px] text-zinc-500">Top Vol Lines</label>
            <input
              type="number"
              min={5}
              max={90}
              value={topN}
              onChange={(e) => setTopN(Math.max(5, Math.min(90, Number(e.target.value) || 40)))}
              className="h-8 w-16 rounded border border-zinc-800 bg-[#0e121b] px-2 font-mono text-xs text-zinc-200"
            />
            {lockedSymbol && (
              <button
                onClick={() => setLockedSymbol(null)}
                className="rounded border border-amber-500/40 bg-amber-500/15 px-2.5 py-1 text-[11px] text-amber-200"
              >
                Pinned: {toDisplaySymbol(exchange, lockedSymbol)} ✕
              </button>
            )}
          </div>
        </header>

        {loading && !data ? (
          <div className="py-24 text-center text-zinc-500">Loading relative strength spaghetti chart...</div>
        ) : error ? (
          <div className="mt-3 rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">Failed to load: {error}</div>
        ) : (
          <>
            {warning && <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">{warning}</div>}
            <div className="mt-3 overflow-hidden rounded-xl border border-zinc-800/80 bg-[#0b0e15] p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="text-zinc-400">{axisLabel} • Click any line or ticker row to pin</span>
                {activeSeries && (
                  <div className="flex items-center gap-3 font-mono text-xs">
                    <span className="font-bold" style={{ color: colorForSymbol(activeSeries.symbol) }}>
                      {toDisplaySymbol(exchange, activeSeries.symbol)}
                    </span>
                    <span className={(activeSeries.points.at(-1) ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300"}>
                      {(activeSeries.points.at(-1) ?? 0) >= 0 ? "+" : ""}
                      {(activeSeries.points.at(-1) ?? 0).toFixed(2)}%
                    </span>
                    <span className="text-zinc-500">24h Vol: {formatNumber(activeSeries.amount24)}</span>
                  </div>
                )}
              </div>

              <div className="w-full overflow-x-auto">
                <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="min-w-[900px] w-full" role="img" aria-label={`${modeTitle} chart`}>
                  <rect x="0" y="0" width={CHART_W} height={CHART_H} fill="#080b11" />

                  {/* Y-axis grid lines & labels */}
                  {[yBounds.max, midHigh, 0, midLow, yBounds.min].map((val, idx) => {
                    const y = yForValue(val, yBounds.min, yBounds.max);
                    const isZero = Math.abs(val) < 1e-6;
                    return (
                      <g key={idx}>
                        <line
                          x1={PAD_X}
                          y1={y}
                          x2={CHART_W - PAD_X}
                          y2={y}
                          stroke={isZero ? "#475569" : "#182030"}
                          strokeWidth={isZero ? "1.2" : "1"}
                          strokeDasharray={isZero ? "5 4" : undefined}
                        />
                        <text x={PAD_X - 6} y={y + 4} textAnchor="end" fill={isZero ? "#94a3b8" : "#64748b"} fontSize="10" fontFamily="monospace">
                          {val > 0 ? `+${val.toFixed(1)}%` : `${val.toFixed(1)}%`}
                        </text>
                      </g>
                    );
                  })}

                  <line x1={PAD_X} y1={PAD_Y} x2={PAD_X} y2={CHART_H - PAD_Y} stroke="#2a3242" strokeWidth="1" />
                  <line x1={PAD_X} y1={CHART_H - PAD_Y} x2={CHART_W - PAD_X} y2={CHART_H - PAD_Y} stroke="#2a3242" strokeWidth="1" />

                  {series.map((s) => {
                    const points = chartPoints(s.points, yBounds.min, yBounds.max);
                    const selected = activeSymbol === s.symbol;
                    return (
                      <polyline
                        key={s.symbol}
                        points={points}
                        fill="none"
                        stroke={colorForSymbol(s.symbol)}
                        strokeWidth={selected ? 2.6 : 1.15}
                        opacity={activeSymbol ? (selected ? 1 : 0.14) : 0.65}
                        className="cursor-pointer transition-opacity"
                        onMouseEnter={() => setHoveredSymbol(s.symbol)}
                        onMouseLeave={() => setHoveredSymbol(null)}
                        onClick={() => setLockedSymbol((prev) => (prev === s.symbol ? null : s.symbol))}
                      />
                    );
                  })}

                  {/* Zero baseline label on right */}
                  <text x={CHART_W - PAD_X + 6} y={zeroY + 4} fill="#94a3b8" fontSize="10" fontFamily="monospace">
                    0.0%
                  </text>
                </svg>
              </div>
            </div>

            <div className="mt-3 grid gap-3 lg:grid-cols-3">
              <div className="rounded-xl border border-zinc-800/80 bg-[#0b0e15] p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-emerald-400">Relative Leaders ({timeframe})</div>
                <div className="space-y-1 text-xs">
                  {winners.map((s) => {
                    const endVal = s.points.at(-1) ?? 0;
                    const isPinned = lockedSymbol === s.symbol;
                    return (
                      <button
                        key={s.symbol}
                        onMouseEnter={() => setHoveredSymbol(s.symbol)}
                        onMouseLeave={() => setHoveredSymbol(null)}
                        onClick={() => setLockedSymbol((prev) => (prev === s.symbol ? null : s.symbol))}
                        className={`flex w-full items-center justify-between rounded border px-2.5 py-1.5 text-left font-mono transition ${
                          isPinned ? "border-cyan-500/50 bg-cyan-500/15" : "border-zinc-800/80 bg-[#10141f] hover:border-zinc-600"
                        }`}
                      >
                        <span className="font-semibold" style={{ color: colorForSymbol(s.symbol) }}>
                          {toDisplaySymbol(exchange, s.symbol)}
                        </span>
                        <span className={endVal >= 0 ? "text-emerald-300" : "text-rose-300"}>
                          {endVal >= 0 ? "+" : ""}
                          {endVal.toFixed(2)}%
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-xl border border-zinc-800/80 bg-[#0b0e15] p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-rose-400">Relative Laggards ({timeframe})</div>
                <div className="space-y-1 text-xs">
                  {laggards.map((s) => {
                    const endVal = s.points.at(-1) ?? 0;
                    const isPinned = lockedSymbol === s.symbol;
                    return (
                      <button
                        key={s.symbol}
                        onMouseEnter={() => setHoveredSymbol(s.symbol)}
                        onMouseLeave={() => setHoveredSymbol(null)}
                        onClick={() => setLockedSymbol((prev) => (prev === s.symbol ? null : s.symbol))}
                        className={`flex w-full items-center justify-between rounded border px-2.5 py-1.5 text-left font-mono transition ${
                          isPinned ? "border-cyan-500/50 bg-cyan-500/15" : "border-zinc-800/80 bg-[#10141f] hover:border-zinc-600"
                        }`}
                      >
                        <span className="font-semibold" style={{ color: colorForSymbol(s.symbol) }}>
                          {toDisplaySymbol(exchange, s.symbol)}
                        </span>
                        <span className={endVal >= 0 ? "text-emerald-300" : "text-rose-300"}>
                          {endVal >= 0 ? "+" : ""}
                          {endVal.toFixed(2)}%
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-xl border border-zinc-800/80 bg-[#0b0e15] p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">Inspected Contract</div>
                {activeSeries ? (
                  <div className="space-y-2.5 rounded border border-zinc-800 bg-[#10141f] p-3 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-base font-bold" style={{ color: colorForSymbol(activeSeries.symbol) }}>
                        {toDisplaySymbol(exchange, activeSeries.symbol)}
                      </span>
                      <span className="font-mono text-sm font-semibold text-zinc-200">
                        {(activeSeries.points.at(-1) ?? 0) >= 0 ? "+" : ""}
                        {(activeSeries.points.at(-1) ?? 0).toFixed(2)}%
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
                      <div className="rounded border border-zinc-800/80 bg-[#0b0e15] p-2">
                        <div className="text-zinc-500">24h Turnover</div>
                        <div className="text-zinc-200">{formatNumber(activeSeries.amount24)}</div>
                      </div>
                      <div className="rounded border border-zinc-800/80 bg-[#0b0e15] p-2">
                        <div className="text-zinc-500">Window Peak / Low</div>
                        <div className="text-zinc-200">
                          {Math.max(...activeSeries.points).toFixed(1)}% / {Math.min(...activeSeries.points).toFixed(1)}%
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 pt-1">
                      <a
                        href={toExchangeTradeUrl(exchange, activeSeries.symbol)}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-500/25"
                      >
                        Trade on {EXCHANGE_LABEL[exchange]} ↗
                      </a>
                      <a
                        href={toTradingViewChartUrl(exchange, activeSeries.symbol)}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded border border-zinc-700 bg-[#141926] px-3 py-1.5 text-[11px] text-zinc-200 hover:border-zinc-500"
                      >
                        TradingView ↗
                      </a>
                    </div>
                  </div>
                ) : (
                  <div className="rounded border border-zinc-800 bg-[#10141f] p-4 text-xs text-zinc-500">
                    Hover or click any line on the chart or symbol in the leaderboards to inspect its trajectory and open trade links.
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
