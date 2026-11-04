"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  EXCHANGE_LABEL,
  exchangePath,
  exchangeSpaghettiPath,
  toDisplaySymbol,
  toExchangeTradeUrl,
  toTradingViewChartUrl,
  toTradingViewSymbol,
  type ExchangeId,
} from "@/lib/exchange";
import { formatFunding, formatNumber, formatPercent, formatPrice, type ScreenerResponse } from "@/lib/screener";
import { loadWatchlistFromStorage, saveWatchlistToStorage, toWatchKey, parseWatchKey, type WatchlistItem } from "@/lib/watchlist";

type RowWithExchange = ScreenerResponse["rows"][number] & { exchange: ExchangeId };

function parseWatchlistKeys(keys: Set<string>): WatchlistItem[] {
  const out: WatchlistItem[] = [];
  for (const key of keys) {
    const parsed = parseWatchKey(key);
    if (parsed) out.push(parsed);
  }
  return out;
}

function pctClass(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "text-zinc-500";
  if (v > 0) return "text-emerald-400";
  if (v < 0) return "text-rose-400";
  return "text-zinc-300";
}

const TV_INTERVALS: { id: string; label: string; title: string }[] = [
  { id: "1", label: "1m", title: "1 Minute" },
  { id: "5", label: "5m", title: "5 Minutes" },
  { id: "15", label: "15m", title: "15 Minutes" },
  { id: "60", label: "1h", title: "1 Hour" },
  { id: "240", label: "4h", title: "4 Hours" },
  { id: "D", label: "1D", title: "1 Day" },
];

export default function WatchlistPage() {
  type WatchSortKey =
    | "symbol"
    | "exchange"
    | "price"
    | "chg5m"
    | "chg15m"
    | "chg1h"
    | "chg24h"
    | "oiUsd"
    | "oiChg1h"
    | "rvol"
    | "funding"
    | "vol24h";
  const [watchKeys, setWatchKeys] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<RowWithExchange[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ exchange: ExchangeId; symbol: string } | null>(null);
  const [chartInterval, setChartInterval] = useState<string>("15");
  const [addInput, setAddInput] = useState("");
  const [addExchange, setAddExchange] = useState<ExchangeId>("mexc");
  const [sortBy, setSortBy] = useState<WatchSortKey>("vol24h");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const handleSort = (key: WatchSortKey) => {
    if (sortBy === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortBy(key);
      setSortDir(key === "symbol" || key === "exchange" ? "asc" : "desc");
    }
  };

  const sortedRows = useMemo(() => {
    const readVal = (r: RowWithExchange): number | string | null => {
      switch (sortBy) {
        case "symbol":
          return toDisplaySymbol(r.exchange, r.symbol);
        case "exchange":
          return EXCHANGE_LABEL[r.exchange];
        case "price":
          return r.price;
        case "chg5m":
          return r.changePct["5m"];
        case "chg15m":
          return r.changePct["15m"];
        case "chg1h":
          return r.changePct["1h"];
        case "chg24h":
          return r.changePct["1d"];
        case "oiUsd":
          return r.oiUsd;
        case "oiChg1h":
          return r.oiChangePct["1h"];
        case "rvol":
          return r.rvol;
        case "funding":
          return r.funding;
        case "vol24h":
        default:
          return r.volume["1d"];
      }
    };

    return [...rows].sort((a, b) => {
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
  }, [rows, sortBy, sortDir]);

  useEffect(() => {
    const keys = loadWatchlistFromStorage();
    setWatchKeys(keys);
  }, []);

  useEffect(() => {
    let alive = true;

    const load = async () => {
      const items = parseWatchlistKeys(watchKeys);
      if (!items.length) {
        if (!alive) return;
        setRows([]);
        setLoading(false);
        return;
      }

      try {
        const exchanges = Array.from(new Set(items.map((i) => i.exchange)));
        const responses = await Promise.all(
          exchanges.map((exchange) => {
            const symbolsForEx = items.filter((i) => i.exchange === exchange).map((i) => i.symbol);
            const partialFlag = symbolsForEx.length > 0 && symbolsForEx.length <= 25 ? "&partial=1" : "";
            const qs = symbolsForEx.length
              ? `?symbols=${encodeURIComponent(symbolsForEx.join(","))}${partialFlag}`
              : "";
            return fetch(`/api/screener/${exchange}${qs}`);
          }),
        );

        const payloads = (await Promise.all(
          responses.map((res) => (res.ok ? res.json() : Promise.resolve({ rows: [] }))),
        )) as Array<{ rows: ScreenerResponse["rows"] }>;

        const map = new Map<string, RowWithExchange>();
        payloads.forEach((payload, idx) => {
          const exchange = exchanges[idx];
          if (!exchange) return;
          for (const row of payload.rows || []) {
            map.set(toWatchKey(exchange, row.symbol), { ...row, exchange });
          }
        });

        const selectedRows: RowWithExchange[] = [];
        for (const item of items) {
          const found = map.get(toWatchKey(item.exchange, item.symbol));
          if (found) selectedRows.push(found);
        }

        selectedRows.sort((a, b) => (b.volume["1d"] ?? 0) - (a.volume["1d"] ?? 0));

        if (!alive) return;
        setRows(selectedRows);
        setSelected((prev) =>
          prev && selectedRows.some((r) => r.symbol === prev.symbol && r.exchange === prev.exchange) ? prev : null,
        );
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "Failed to load watchlist");
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
  }, [watchKeys]);

  const removeWatch = (exchange: ExchangeId, symbol: string) => {
    setWatchKeys((prev) => {
      const next = new Set(prev);
      next.delete(toWatchKey(exchange, symbol));
      saveWatchlistToStorage(next);
      return next;
    });
  };

  const handleAddSymbol = (e: React.FormEvent) => {
    e.preventDefault();
    const raw = addInput.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
    if (!raw) return;
    let normalized = raw;
    if (addExchange === "mexc") {
      if (!normalized.endsWith("_USDT")) {
        normalized = normalized.replace(/USDT$/, "") + "_USDT";
      }
    } else if (addExchange === "hyperliquid") {
      normalized = normalized.replace(/_USDT$/, "").replace(/USDT$/, "").replace(/USD$/, "");
    } else {
      normalized = normalized.replace(/_USDT$/, "USDT");
      if (!normalized.endsWith("USDT")) normalized += "USDT";
    }
    setWatchKeys((prev) => {
      const next = new Set(prev);
      next.add(toWatchKey(addExchange, normalized));
      saveWatchlistToStorage(next);
      return next;
    });
    setAddInput("");
  };

  const loadStarterPack = () => {
    const starters = ["BTC_USDT", "ETH_USDT", "SOL_USDT", "SUI_USDT", "PEPE_USDT", "DOGE_USDT", "XRP_USDT", "HYPE_USDT"];
    setWatchKeys((prev) => {
      const next = new Set(prev);
      for (const s of starters) next.add(toWatchKey("mexc", s));
      saveWatchlistToStorage(next);
      return next;
    });
  };

  const chartSrc = useMemo(() => {
    if (!selected) return null;
    const tv = toTradingViewSymbol(selected.exchange, selected.symbol);
    return `https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(`${tv.prefix}:${tv.symbol}`)}&interval=${chartInterval}&hidesidetoolbar=0&symboledit=1&saveimage=0&toolbarbg=0b0e15&theme=dark&style=1&locale=en`;
  }, [selected, chartInterval]);

  return (
    <div className="min-h-screen bg-[#06080c] text-zinc-200">
      <div className="mx-auto max-w-[1800px] px-3 py-3 sm:px-4">
        <header className="sticky top-0 z-40 rounded-xl border border-zinc-800/80 bg-[#0b0e15]/95 p-3 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h1 className="text-base font-bold tracking-tight text-zinc-100">Multi-Exchange Watchlist</h1>
              <p className="font-mono text-[11px] text-zinc-500">
                {rows.length} active perpetual contracts • Real-time MEXC / Bybit / Binance / Hyperliquid metrics
              </p>
            </div>
            <nav className="flex flex-wrap items-center gap-1.5 text-xs">
              <Link href="/screener/mexc" className="rounded border border-zinc-700 bg-[#121621] px-2.5 py-1.5 text-zinc-300 hover:border-zinc-500">
                MEXC Screener
              </Link>
              <Link href="/screener/bybit" className="rounded border border-zinc-700 bg-[#121621] px-2.5 py-1.5 text-zinc-300 hover:border-zinc-500">
                Bybit
              </Link>
              <Link href="/screener/binance" className="rounded border border-zinc-700 bg-[#121621] px-2.5 py-1.5 text-zinc-300 hover:border-zinc-500">
                Binance
              </Link>
              <Link href="/screener/hyperliquid" className="rounded border border-zinc-700 bg-[#121621] px-2.5 py-1.5 text-zinc-300 hover:border-zinc-500">
                Hyperliquid
              </Link>
              <Link href="/screener/performers" className="rounded border border-zinc-700 bg-[#121621] px-2.5 py-1.5 text-zinc-300 hover:border-zinc-500">
                Performers
              </Link>
              <Link href="/screener/journal" className="rounded border border-zinc-700 bg-[#121621] px-2.5 py-1.5 text-zinc-300 hover:border-zinc-500">
                Journal
              </Link>
            </nav>
          </div>

          <form onSubmit={handleAddSymbol} className="mt-2.5 flex flex-wrap items-center gap-2 text-xs">
            <select
              value={addExchange}
              onChange={(e) => setAddExchange(e.target.value as ExchangeId)}
              className="h-8 rounded border border-zinc-800 bg-[#0e121b] px-2.5 text-xs text-zinc-200"
            >
              <option value="mexc">MEXC</option>
              <option value="bybit">Bybit</option>
              <option value="binance">Binance</option>
              <option value="hyperliquid">Hyperliquid</option>
            </select>
            <input
              value={addInput}
              onChange={(e) => setAddInput(e.target.value)}
              placeholder="Add symbol (e.g. BTC, SOL, PEPE)..."
              className="h-8 w-56 rounded border border-zinc-800 bg-[#0e121b] px-2.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-cyan-500/50"
            />
            <button
              type="submit"
              className="h-8 rounded border border-cyan-500/40 bg-cyan-500/15 px-3 text-xs font-semibold text-cyan-200 hover:bg-cyan-500/25"
            >
              + Add to Watchlist
            </button>
            <button
              type="button"
              onClick={loadStarterPack}
              className="h-8 rounded border border-zinc-700 bg-[#121621] px-3 text-xs text-zinc-300 hover:border-zinc-500"
            >
              Load MEXC Core Pack
            </button>
          </form>
        </header>

        {loading ? (
          <div className="py-24 text-center text-zinc-500">Loading watchlist...</div>
        ) : error ? (
          <div className="mt-3 rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">Failed to load: {error}</div>
        ) : !rows.length ? (
          <div className="mt-3 rounded-xl border border-zinc-800/80 bg-[#0b0e15] p-6 text-center text-sm text-zinc-400">
            <p>Your watchlist is currently empty.</p>
            <p className="mt-1 text-xs text-zinc-500">Star any contract in the MEXC Screener or click below to populate core perpetuals.</p>
            <button
              onClick={loadStarterPack}
              className="mt-3 rounded border border-cyan-500/40 bg-cyan-500/15 px-4 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-500/25"
            >
              + Populate MEXC Core Watchlist (BTC, ETH, SOL, SUI, PEPE, DOGE, XRP, HYPE)
            </button>
          </div>
        ) : (
          <>
            {selected && chartSrc && (
              <div className="mt-3 overflow-hidden rounded-xl border border-zinc-800/80 bg-[#0b0e15]">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 bg-[#0f131d] px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold text-zinc-100">
                      {toDisplaySymbol(selected.exchange, selected.symbol)} ({EXCHANGE_LABEL[selected.exchange]})
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
                  <button
                    onClick={() => setSelected(null)}
                    className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[11px] font-semibold text-rose-300 hover:bg-rose-500/20"
                  >
                    ✕ Close
                  </button>
                </div>
                <div className="h-[420px] w-full bg-[#080b11]">
                  <iframe
                    key={`${selected.exchange}:${selected.symbol}:${chartInterval}`}
                    title="Watchlist chart"
                    src={chartSrc}
                    className="h-full w-full"
                    allow="clipboard-write"
                  />
                </div>
              </div>
            )}

            <div className="mt-3 overflow-hidden rounded-xl border border-zinc-800/80 bg-[#0b0e15]">
              <div className="overflow-auto">
                <table className="min-w-full font-mono text-[12px]">
                  <thead className="sticky top-0 z-30 bg-[#0f131d]">
                    <tr className="border-b border-zinc-800 text-[11px] text-zinc-400">
                      {(
                        [
                          { key: "symbol", label: "Symbol", align: "left" },
                          { key: "exchange", label: "Exch", align: "left" },
                          { key: "price", label: "Price", align: "right" },
                          { key: "chg5m", label: "5m %", align: "right" },
                          { key: "chg15m", label: "15m %", align: "right" },
                          { key: "chg1h", label: "1h %", align: "right" },
                          { key: "chg24h", label: "24h %", align: "right" },
                          { key: "oiUsd", label: "OI $", align: "right" },
                          { key: "oiChg1h", label: "OI Δ 1h", align: "right" },
                          { key: "rvol", label: "RVOL", align: "right" },
                          { key: "funding", label: "Funding", align: "right" },
                          { key: "vol24h", label: "24h Vol", align: "right" },
                        ] as { key: WatchSortKey; label: string; align: "left" | "right" }[]
                      ).map((col) => {
                        const isSorted = sortBy === col.key;
                        return (
                          <th
                            key={col.key}
                            onClick={() => handleSort(col.key)}
                            className={`cursor-pointer select-none px-3 py-2 text-${col.align} font-semibold uppercase tracking-wide hover:text-zinc-100 ${
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
                      <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map((row, idx) => {
                      const isSel = selected?.exchange === row.exchange && selected?.symbol === row.symbol;
                      return (
                        <tr
                          key={`${row.exchange}-${row.symbol}`}
                          onClick={() =>
                            setSelected((prev) =>
                              prev?.exchange === row.exchange && prev?.symbol === row.symbol
                                ? null
                                : { exchange: row.exchange, symbol: row.symbol },
                            )
                          }
                          className={`cursor-pointer border-b border-zinc-900/80 ${
                            isSel ? "bg-cyan-500/15" : idx % 2 === 0 ? "bg-[#090c12]" : "bg-[#0c1018]"
                          } hover:bg-zinc-800/40`}
                        >
                          <td className="px-3 py-2 font-sans font-bold text-zinc-100">
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  removeWatch(row.exchange, row.symbol);
                                }}
                                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-amber-400/80 bg-amber-500/25 text-amber-300 shadow-[0_0_8px_rgba(251,191,36,0.3)] hover:border-rose-400/80 hover:bg-rose-500/25 hover:text-rose-200"
                                title="Click to unstar / remove from Watchlist"
                              >
                                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2">
                                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                                </svg>
                              </button>
                              <span>{toDisplaySymbol(row.exchange, row.symbol)}</span>
                            </div>
                          </td>
                          <td className="px-3 py-2 font-sans text-xs text-zinc-400">{EXCHANGE_LABEL[row.exchange]}</td>
                          <td className="px-3 py-2 text-right text-zinc-100">${formatPrice(row.price, row.priceScale)}</td>
                          <td className={`px-3 py-2 text-right ${pctClass(row.changePct["5m"])}`}>{formatPercent(row.changePct["5m"])}</td>
                          <td className={`px-3 py-2 text-right ${pctClass(row.changePct["15m"])}`}>{formatPercent(row.changePct["15m"])}</td>
                          <td className={`px-3 py-2 text-right ${pctClass(row.changePct["1h"])}`}>{formatPercent(row.changePct["1h"])}</td>
                          <td className={`px-3 py-2 text-right font-semibold ${pctClass(row.changePct["1d"])}`}>{formatPercent(row.changePct["1d"])}</td>
                          <td className="px-3 py-2 text-right text-zinc-200">{formatNumber(row.oiUsd)}</td>
                          <td className={`px-3 py-2 text-right ${pctClass(row.oiChangePct["1h"])}`}>{formatPercent(row.oiChangePct["1h"])}</td>
                          <td className="px-3 py-2 text-right text-amber-200">{row.rvol !== null ? `${row.rvol.toFixed(2)}x` : "—"}</td>
                          <td className={`px-3 py-2 text-right ${pctClass(row.funding)}`}>{formatFunding(row.funding)}</td>
                          <td className="px-3 py-2 text-right text-zinc-200">{formatNumber(row.volume["1d"])}</td>
                          <td className="px-3 py-2 text-right font-sans">
                            <div className="flex items-center justify-end gap-1.5">
                              <a
                                href={toExchangeTradeUrl(row.exchange, row.symbol)}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-200 hover:bg-emerald-500/25"
                              >
                                Trade ↗
                              </a>
                              <a
                                href={toTradingViewChartUrl(row.exchange, row.symbol)}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-zinc-500"
                              >
                                TV ↗
                              </a>
                              <Link
                                href={exchangeSpaghettiPath(row.exchange, "price")}
                                onClick={(e) => e.stopPropagation()}
                                className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-zinc-500"
                              >
                                Spaghetti
                              </Link>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  removeWatch(row.exchange, row.symbol);
                                }}
                                className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[11px] text-rose-300 hover:bg-rose-500/20"
                              >
                                ✕
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
