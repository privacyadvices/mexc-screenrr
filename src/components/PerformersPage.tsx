"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  toDisplaySymbol,
  toExchangeTradeUrl,
  toTradingViewChartUrl,
  toTradingViewSymbol,
} from "@/lib/exchange";
import { formatFunding, formatNumber, formatPercent, formatPrice } from "@/lib/screener";
import { loadWatchlistFromStorage, saveWatchlistToStorage, toWatchKey } from "@/lib/watchlist";

type Period = "24h" | "7d" | "30d" | "90d" | "1y";
type ViewMode = "gainers" | "losers";

type PerformerRow = {
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

type PerformersResponse = {
  asOf: number;
  period: Period;
  totalContracts?: number;
  gainers: PerformerRow[];
  losers: PerformerRow[];
};

const exchange = "mexc";

const TV_INTERVALS: { id: string; label: string; title: string }[] = [
  { id: "1", label: "1m", title: "1 Minute" },
  { id: "5", label: "5m", title: "5 Minutes" },
  { id: "15", label: "15m", title: "15 Minutes" },
  { id: "60", label: "1h", title: "1 Hour" },
  { id: "240", label: "4h", title: "4 Hours" },
  { id: "D", label: "1D", title: "1 Day" },
];

function changeForPeriod(row: PerformerRow, period: Period): number | null {
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

function changeColor(change: number | null | undefined): string {
  if (change === null || change === undefined || Number.isNaN(change)) return "text-zinc-500";
  if (change > 0) return "text-emerald-400";
  if (change < 0) return "text-rose-400";
  return "text-zinc-400";
}

export default function PerformersPage() {
  const [data, setData] = useState<PerformersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>("24h");
  const [viewMode, setViewMode] = useState<ViewMode>("gainers");
  const [query, setQuery] = useState("");
  const [minVolume24h, setMinVolume24h] = useState<number>(0);
  type SortKey =
    | "symbol"
    | "price"
    | "change"
    | "change24h"
    | "change7d"
    | "change30d"
    | "change90d"
    | "volume"
    | "oi"
    | "funding"
    | "mcap";
  const [sortBy, setSortBy] = useState<SortKey>("change");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [watchlistKeys, setWatchlistKeys] = useState<Set<string>>(new Set());
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [chartInterval, setChartInterval] = useState<string>("15");

  useEffect(() => {
    setWatchlistKeys(loadWatchlistFromStorage());
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const load = async () => {
      try {
        const res = await fetch(`/api/performers/mexc?period=${period}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = (await res.json()) as PerformersResponse;
        if (!alive) return;
        setData(payload);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "Failed to load performers");
      } finally {
        if (alive) setLoading(false);
      }
    };

    void load();
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void load();
    }, 45_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [period]);

  const rows = useMemo(() => {
    const source = viewMode === "gainers" ? data?.gainers : data?.losers;
    if (!source) return [];

    const filtered = source.filter((r) => {
      if (query.trim() && !r.symbol.toLowerCase().includes(query.trim().toLowerCase())) return false;
      if (minVolume24h > 0 && r.volume24 < minVolume24h) return false;
      return true;
    });

    const readVal = (r: PerformerRow): number | string | null => {
      switch (sortBy) {
        case "symbol":
          return toDisplaySymbol(exchange, r.symbol);
        case "price":
          return r.price;
        case "change24h":
          return r.change24h;
        case "change7d":
          return r.change7d;
        case "change30d":
          return r.change30d;
        case "change90d":
          return r.change90d;
        case "volume":
          return r.volume24;
        case "oi":
          return r.oiUsd;
        case "funding":
          return r.funding;
        case "mcap":
          return r.mcap;
        case "change":
        default: {
          const c = changeForPeriod(r, period);
          if (c === null || !Number.isFinite(c)) return null;
          // In losers mode, default "desc" means biggest loser first (most negative), and "asc" means smallest loser first
          return viewMode === "losers" ? Math.abs(c) : c;
        }
      }
    };

    return [...filtered].sort((a, b) => {
      const av = readVal(a);
      const bv = readVal(b);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (typeof av === "string" && typeof bv === "string") {
        const cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" });
        return sortDir === "desc" ? -cmp : cmp;
      }
      const an = Number(av);
      const bn = Number(bv);
      return sortDir === "desc" ? bn - an : an - bn;
    });
  }, [data, viewMode, query, minVolume24h, sortBy, sortDir, period]);

  const toggleWatch = (symbol: string) => {
    setWatchlistKeys((prev) => {
      const next = new Set(prev);
      const key = toWatchKey(exchange, symbol);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveWatchlistToStorage(next);
      return next;
    });
  };

  const chartSrc = useMemo(() => {
    if (!selectedSymbol) return null;
    const tv = toTradingViewSymbol(exchange, selectedSymbol);
    return `https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(`${tv.prefix}:${tv.symbol}`)}&interval=${chartInterval}&hidesidetoolbar=0&symboledit=1&saveimage=0&toolbarbg=0c0e14&theme=dark&style=1&locale=en`;
  }, [selectedSymbol, chartInterval]);

  const handleSort = (key: SortKey) => {
    if (sortBy === key) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortBy(key);
      setSortDir(key === "symbol" ? "asc" : "desc");
    }
  };

  return (
    <div className="min-h-screen bg-[#07080c] text-zinc-200">
      <div className="mx-auto max-w-[2100px] px-3 py-3 sm:px-4">
        <header className="sticky top-0 z-40 rounded-xl border border-[#191d28] bg-[#0c0e14]/95 p-3 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h1 className="text-base font-bold tracking-tight text-zinc-100">
                MEXC Multi-Horizon Top Performers
              </h1>
              <p className="text-xs text-zinc-500">
                {viewMode === "gainers" ? "Top Gainers" : "Top Losers"} • Horizon{" "}
                <strong className="text-cyan-300">{period}</strong> • {rows.length} shown of{" "}
                {data?.totalContracts ?? 0} MEXC perpetuals •{" "}
                {data ? new Date(data.asOf).toLocaleTimeString() : "--:--:--"}
              </p>
            </div>

            <nav className="flex flex-wrap items-center gap-1.5 text-xs">
              <Link
                href="/screener/mexc"
                className="rounded-md border border-zinc-700/80 bg-[#12151e] px-3 py-1.5 text-zinc-300 hover:border-zinc-500"
              >
                MEXC Screener
              </Link>
              <Link
                href="/screener/mexc/spaghetti/price"
                className="rounded-md border border-zinc-700/80 bg-[#12151e] px-3 py-1.5 text-zinc-300 hover:border-zinc-500"
              >
                Spaghetti
              </Link>
              <Link
                href="/screener/watchlist"
                className="rounded-md border border-zinc-700/80 bg-[#12151e] px-3 py-1.5 text-zinc-300 hover:border-zinc-500"
              >
                ★ Watchlist
              </Link>
              <Link
                href="/screener/journal"
                className="rounded-md border border-zinc-700/80 bg-[#12151e] px-3 py-1.5 text-zinc-300 hover:border-zinc-500"
              >
                Journal
              </Link>
            </nav>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-zinc-800/70 pt-2">
            <span className="text-xs text-zinc-500">Horizon:</span>
            <div className="flex overflow-hidden rounded-md border border-zinc-700">
              {(["24h", "7d", "30d", "90d", "1y"] as Period[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={`px-3 py-1 text-xs font-semibold ${
                    period === p
                      ? "bg-cyan-500/20 text-cyan-300"
                      : "bg-[#10131c] text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>

            <div className="flex overflow-hidden rounded-md border border-zinc-700">
              <button
                onClick={() => setViewMode("gainers")}
                className={`px-3 py-1 text-xs font-semibold ${
                  viewMode === "gainers"
                    ? "bg-emerald-500/20 text-emerald-300"
                    : "bg-[#10131c] text-zinc-400 hover:text-zinc-200"
                }`}
              >
                ↑ Top Gainers ({data?.gainers.length ?? 0})
              </button>
              <button
                onClick={() => setViewMode("losers")}
                className={`px-3 py-1 text-xs font-semibold ${
                  viewMode === "losers"
                    ? "bg-rose-500/20 text-rose-300"
                    : "bg-[#10131c] text-zinc-400 hover:text-zinc-200"
                }`}
              >
                ↓ Top Losers ({data?.losers.length ?? 0})
              </button>
            </div>

            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter symbol..."
              className="h-7 w-40 rounded-md border border-zinc-700/80 bg-[#090b10] px-2.5 text-xs text-zinc-200 outline-none focus:border-cyan-400 placeholder:text-zinc-600"
            />

            <select
              value={minVolume24h}
              onChange={(e) => setMinVolume24h(Number(e.target.value))}
              className="h-7 rounded-md border border-zinc-700/80 bg-[#090b10] px-2 text-xs text-zinc-300"
            >
              <option value={0}>Min 24h Vol: All</option>
              <option value={500_000}>Min Vol &gt; $500K</option>
              <option value={2_000_000}>Min Vol &gt; $2M</option>
              <option value={10_000_000}>Min Vol &gt; $10M</option>
              <option value={50_000_000}>Min Vol &gt; $50M</option>
            </select>
          </div>
        </header>

        {loading && !data ? (
          <div className="py-24 text-center text-zinc-500">Loading performers...</div>
        ) : error ? (
          <div className="mt-3 rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
            Failed to load: {error}
          </div>
        ) : (
          <div className={`mt-3 grid gap-3 ${selectedSymbol ? "xl:grid-cols-[1fr_560px]" : "grid-cols-1"}`}>
            <div className="overflow-hidden rounded-xl border border-[#191d28] bg-[#0c0e14]">
              <div className="max-h-[calc(100vh-170px)] overflow-auto">
                <table className="min-w-full text-[12px] tabular-nums">
                  <thead className="sticky top-0 z-30 bg-[#0f121a]">
                    <tr className="border-b border-[#191d28] text-[11px] text-zinc-400">
                      {(
                        [
                          { key: "symbol", label: "# / Symbol", align: "left" },
                          { key: "price", label: "Price", align: "right" },
                          { key: "change", label: `${period} %`, align: "right" },
                          { key: "change24h", label: "24h %", align: "right" },
                          { key: "change7d", label: "7d %", align: "right" },
                          { key: "change30d", label: "30d %", align: "right" },
                          { key: "change90d", label: "90d %", align: "right" },
                          { key: "volume", label: "Vol 24h", align: "right" },
                          { key: "oi", label: "OI $", align: "right" },
                          { key: "funding", label: "Funding", align: "right" },
                          { key: "mcap", label: "MCAP", align: "right" },
                        ] as { key: SortKey; label: string; align: "left" | "right" }[]
                      ).map((col) => {
                        const isSorted = sortBy === col.key;
                        return (
                          <th
                            key={col.key}
                            onClick={() => handleSort(col.key)}
                            className={`cursor-pointer select-none px-3 py-2 text-${col.align} font-semibold uppercase hover:text-zinc-100 ${
                              isSorted ? "bg-cyan-500/10 text-cyan-200" : ""
                            }`}
                          >
                            {col.label}{" "}
                            {isSorted ? (
                              <span className={sortDir === "desc" ? "text-cyan-400" : "text-amber-400"}>
                                {sortDir === "desc" ? "▼" : "▲"}
                              </span>
                            ) : (
                              ""
                            )}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, idx) => {
                      const activeChange = changeForPeriod(row, period);
                      return (
                        <tr
                          key={row.symbol}
                          onClick={() => setSelectedSymbol((prev) => (prev === row.symbol ? null : row.symbol))}
                          className={`cursor-pointer border-b border-zinc-900/80 ${
                            selectedSymbol === row.symbol
                              ? "bg-[#132332]"
                              : idx % 2 === 0
                                ? "bg-[#0a0c12]"
                                : "bg-[#0d1017]"
                          } hover:bg-[#161b26]`}
                        >
                          <td className="px-3 py-2 font-semibold text-zinc-100">
                            <div className="flex items-center gap-1.5">
                              <span className="inline-block w-5 text-[10px] text-zinc-500">{idx + 1}</span>
                              {(() => {
                                const isWatched = watchlistKeys.has(toWatchKey(exchange, row.symbol));
                                return (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toggleWatch(row.symbol);
                                    }}
                                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border transition-all ${
                                      isWatched
                                        ? "border-amber-400/80 bg-amber-500/25 text-amber-300 shadow-[0_0_8px_rgba(251,191,36,0.3)] hover:bg-amber-500/35"
                                        : "border-zinc-700/80 bg-[#121622] text-zinc-400 hover:border-amber-400/60 hover:bg-amber-500/15 hover:text-amber-300"
                                    }`}
                                    title={isWatched ? "Starred in Watchlist (Click to unstar)" : "Click to Star / Add to Watchlist"}
                                  >
                                    <svg
                                      className="h-3.5 w-3.5"
                                      viewBox="0 0 24 24"
                                      fill={isWatched ? "currentColor" : "none"}
                                      stroke="currentColor"
                                      strokeWidth="2"
                                    >
                                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                                    </svg>
                                  </button>
                                );
                              })()}
                              <span>{toDisplaySymbol(exchange, row.symbol)}</span>
                              {row.isZeroFee && (
                                <span className="rounded bg-emerald-500/15 px-1 py-0.2 text-[9px] text-emerald-300">
                                  0%
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right text-zinc-200">
                            ${formatPrice(row.price, row.priceScale)}
                          </td>
                          <td className={`px-3 py-2 text-right font-bold ${changeColor(activeChange)}`}>
                            {formatPercent(activeChange)}
                          </td>
                          <td className={`px-3 py-2 text-right ${changeColor(row.change24h)}`}>
                            {formatPercent(row.change24h)}
                          </td>
                          <td className={`px-3 py-2 text-right ${changeColor(row.change7d)}`}>
                            {formatPercent(row.change7d)}
                          </td>
                          <td className={`px-3 py-2 text-right ${changeColor(row.change30d)}`}>
                            {formatPercent(row.change30d)}
                          </td>
                          <td className={`px-3 py-2 text-right ${changeColor(row.change90d)}`}>
                            {formatPercent(row.change90d)}
                          </td>
                          <td className="px-3 py-2 text-right text-zinc-300">${formatNumber(row.volume24)}</td>
                          <td className="px-3 py-2 text-right text-zinc-300">
                            {row.oiUsd ? `$${formatNumber(row.oiUsd)}` : "-"}
                          </td>
                          <td className={`px-3 py-2 text-right ${row.funding >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                            {formatFunding(row.funding)}
                          </td>
                          <td className="px-3 py-2 text-right text-zinc-300">
                            {row.mcap === null ? "-" : `$${formatNumber(row.mcap)}`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Right Docked Chart — only mounted when a ticker row is clicked */}
            {selectedSymbol && chartSrc && (
              <div className="sticky top-[115px] h-fit overflow-hidden rounded-xl border border-[#191d28] bg-[#0c0e14]">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#191d28] bg-[#0f121a] px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold text-zinc-100">
                      {toDisplaySymbol(exchange, selectedSymbol)}
                    </span>
                    <div className="flex items-center overflow-hidden rounded border border-zinc-700/80 bg-[#090b10]">
                      {TV_INTERVALS.map((intv) => (
                        <button
                          key={intv.id}
                          onClick={() => setChartInterval(intv.id)}
                          title={intv.title}
                          className={`px-2 py-0.5 font-mono text-[11px] font-semibold transition-colors ${
                            chartInterval === intv.id
                              ? "bg-cyan-500/25 text-cyan-200"
                              : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                          }`}
                        >
                          {intv.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <a
                      href={toExchangeTradeUrl(exchange, selectedSymbol)}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-300"
                    >
                      Trade MEXC ↗
                    </a>
                    <a
                      href={toTradingViewChartUrl(exchange, selectedSymbol)}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded border border-zinc-700 bg-[#12151e] px-2 py-0.5 text-[11px] text-zinc-300"
                    >
                      TV ↗
                    </a>
                    <button
                      onClick={() => setSelectedSymbol(null)}
                      className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[11px] font-semibold text-rose-300 hover:bg-rose-500/20"
                    >
                      ✕ Close
                    </button>
                  </div>
                </div>
                <div className="h-[480px] w-full bg-[#08090d]">
                  <iframe
                    key={`${selectedSymbol}:${chartInterval}`}
                    title="Performer chart"
                    src={chartSrc}
                    className="h-full w-full"
                    allow="clipboard-write"
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
