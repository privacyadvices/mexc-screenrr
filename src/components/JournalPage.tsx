"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LEAK_LABELS,
  type JournalAiInsights,
  type JournalPayload,
  type JournalRangeKey,
  type LeakBucket,
  type LeakFlag,
  type SymbolStats,
  type PeriodComparison,
  type HoldTimeAnalysis,
  type TradeChartPayload,
  type TradeRecord,
} from "@/lib/journal";

const RANGE_OPTIONS: { key: JournalRangeKey; label: string }[] = [
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
  { key: "60d", label: "60d" },
  { key: "90d", label: "90d" },
  { key: "1y", label: "1y" },
  { key: "all", label: "All" },
];

const SIDE_OPTIONS = ["all", "long", "short"] as const;
const OUTCOME_OPTIONS = ["all", "wins", "losses"] as const;

type ExtendedJournalPayload = JournalPayload & {
  symbolStats?: SymbolStats[];
  holdTimeAnalysis?: HoldTimeAnalysis;
  periodComparison?: PeriodComparison | null;
};

function money(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)} USDT`;
}

function dt(ts: number): string {
  return new Date(ts).toLocaleString();
}

function sideColor(side: TradeRecord["side"]): string {
  if (side === "long") return "text-emerald-300";
  if (side === "short") return "text-rose-300";
  return "text-zinc-400";
}

function parseSymbolForTv(symbol: string): string {
  return symbol.replace("_USDT", "USDT");
}

function minMax(values: number[]): { min: number; max: number } {
  if (!values.length) return { min: 0, max: 1 };
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) return { min: min - 1, max: max + 1 };
  return { min, max };
}

function chartPolyline(points: TradeChartPayload["points"], w: number, h: number): string {
  const padX = 40;
  const padY = 20;
  const { min, max } = minMax(points.map((p) => p.close));
  const xRange = w - padX * 2;
  const yRange = h - padY * 2;
  const range = max - min || 1;
  return points
    .map((p, i) => {
      const x = padX + (i / Math.max(1, points.length - 1)) * xRange;
      const y = padY + (1 - (p.close - min) / range) * yRange;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

function markerY(price: number, min: number, max: number, h: number): number {
  const padY = 20;
  const yRange = h - padY * 2;
  const range = max - min || 1;
  return padY + (1 - (price - min) / range) * yRange;
}

function markerX(timestamp: number, start: number, end: number, w: number): number {
  const padX = 40;
  const xRange = w - padX * 2;
  const range = Math.max(1, end - start);
  const ratio = Math.min(1, Math.max(0, (timestamp - start) / range));
  return padX + ratio * xRange;
}

function leakDisplay(flags: LeakFlag[]): string {
  if (!flags.length) return "Clean / no leak rule triggered";
  return flags.map((f) => LEAK_LABELS[f]).join(", ");
}

function exportToCsv(trades: TradeRecord[], filename: string) {
  const headers = ["Close Time", "Symbol", "Side", "Hold (min)", "Entry Price", "Exit Price", "Fee", "PnL", "Leak Flags"];
  const rows = trades.map((t) => [
    new Date(t.closeTime).toISOString(),
    t.symbol,
    t.side,
    t.holdMinutes.toFixed(2),
    t.entryPrice?.toString() ?? "",
    t.exitPrice?.toString() ?? "",
    t.fee.toFixed(2),
    t.realizedPnl.toFixed(2),
    t.leakFlags.join(";"),
  ]);
  const csv = [headers.join(","), ...rows.map((r) => r.map((c) => `"${c}"`).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function evaluateTradesClientSide(rawTrades: TradeRecord[], rangeKey: JournalRangeKey, labelNote: string): ExtendedJournalPayload {
  const chronological = [...rawTrades].sort((a, b) => a.closeTime - b.closeTime);

  const dayCounts = new Map<string, number>();
  const dayPnl = new Map<string, number>();
  for (const t of chronological) {
    const day = new Date(t.closeTime).toISOString().slice(0, 10);
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
    dayPnl.set(day, (dayPnl.get(day) ?? 0) + t.realizedPnl);
  }

  let lossStreak = 0;
  let consecutiveLossStopTriggers = 0;
  for (let i = 0; i < chronological.length; i += 1) {
    const t = chronological[i];
    const prev = i > 0 ? chronological[i - 1] : null;
    const flags = new Set<LeakFlag>(t.leakFlags);

    if (prev && prev.realizedPnl < 0) {
      const sincePrevLossMin = Math.max(0, (t.openTime - prev.closeTime) / 60_000);
      if (sincePrevLossMin <= 45) flags.add("POST_LOSS_CHASE");
    }

    if (lossStreak >= 2 && t.realizedPnl < 0) {
      flags.add("REVENGE_STREAK");
    }

    let hourCount = 0;
    for (let j = i; j >= 0; j -= 1) {
      if (t.openTime - chronological[j].openTime <= 3_600_000) hourCount += 1;
      else break;
    }
    if (hourCount > 3 && t.realizedPnl < 0) flags.add("OVERTRADING_CLUSTER");

    const dayKey = new Date(t.closeTime).toISOString().slice(0, 10);
    if ((dayCounts.get(dayKey) ?? 0) > 8 && (dayPnl.get(dayKey) ?? 0) < 0 && t.realizedPnl < 0) {
      flags.add("HIGH_FREQUENCY_SESSION");
    }

    if (t.holdMinutes <= 5 && t.realizedPnl < 0) flags.add("NO_SETUP_PROXY");

    t.leakFlags = Array.from(flags);

    if (t.realizedPnl < 0) {
      lossStreak += 1;
      if (lossStreak === 2) consecutiveLossStopTriggers += 1;
    } else if (t.realizedPnl > 0) {
      lossStreak = 0;
    }
  }

  let dailyLossStopTriggers = 0;
  for (const [day, count] of dayCounts.entries()) {
    if (count > 8 && (dayPnl.get(day) ?? 0) < 0) dailyLossStopTriggers += 1;
  }

  const wins = chronological.filter((t) => t.realizedPnl > 0);
  const losses = chronological.filter((t) => t.realizedPnl < 0);
  const netPnl = chronological.reduce((acc, t) => acc + t.realizedPnl, 0);
  const grossWin = wins.reduce((acc, t) => acc + t.realizedPnl, 0);
  const grossLoss = Math.abs(losses.reduce((acc, t) => acc + t.realizedPnl, 0));
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? -grossLoss / losses.length : 0;
  const winRate = chronological.length ? (wins.length / chronological.length) * 100 : 0;
  const wr = winRate / 100;
  const expectancy = wr * avgWin + (1 - wr) * avgLoss;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;

  const leakKeys: LeakFlag[] = [
    "POST_LOSS_CHASE",
    "OVERTRADING_CLUSTER",
    "HIGH_FREQUENCY_SESSION",
    "REVENGE_STREAK",
    "NO_SETUP_PROXY",
  ];

  const leakBuckets: LeakBucket[] = leakKeys.map((key) => {
    const matching = chronological.filter((t) => t.leakFlags.includes(key));
    const grossPnl = matching.reduce((acc, t) => acc + t.realizedPnl, 0);
    return {
      key,
      label: LEAK_LABELS[key],
      tradeCount: matching.length,
      grossPnl,
    };
  });

  const tradesWithoutLeaksPnl = chronological
    .filter((t) => t.leakFlags.length === 0)
    .reduce((acc, t) => acc + t.realizedPnl, 0);

  const bySymbol = new Map<string, TradeRecord[]>();
  for (const t of chronological) {
    const arr = bySymbol.get(t.symbol) ?? [];
    arr.push(t);
    bySymbol.set(t.symbol, arr);
  }

  const symbolStats: SymbolStats[] = Array.from(bySymbol.entries())
    .map(([symbol, list]) => {
      const sw = list.filter((t) => t.realizedPnl > 0);
      const sl = list.filter((t) => t.realizedPnl < 0);
      return {
        symbol,
        tradeCount: list.length,
        winCount: sw.length,
        lossCount: sl.length,
        winRate: list.length ? (sw.length / list.length) * 100 : 0,
        netPnl: list.reduce((a, b) => a + b.realizedPnl, 0),
        avgHoldMinutes: list.length ? list.reduce((a, b) => a + b.holdMinutes, 0) / list.length : 0,
        totalFees: list.reduce((a, b) => a + b.fee, 0),
      };
    })
    .sort((a, b) => b.netPnl - a.netPnl);

  const avgWinHold = wins.length ? wins.reduce((a, b) => a + b.holdMinutes, 0) / wins.length : 0;
  const avgLossHold = losses.length ? losses.reduce((a, b) => a + b.holdMinutes, 0) / losses.length : 0;
  const holdDifference = avgLossHold - avgWinHold;

  return {
    overview: {
      asOf: Date.now(),
      timezone: "UTC",
      baseCurrency: "USDT",
      rangeKey,
      tradeCount: chronological.length,
      winRate,
      netPnl,
      avgWin,
      avgLoss,
      expectancy,
      profitFactor,
      consecutiveLossStopTriggers,
      dailyLossStopTriggers,
      tradesWithoutLeaksPnl,
      leakBuckets,
      warnings: [labelNote],
    },
    trades: [...chronological].sort((a, b) => b.closeTime - a.closeTime),
    symbolStats,
    holdTimeAnalysis: {
      avgWinHold,
      avgLossHold,
      holdDifference,
      implication:
        holdDifference > 20
          ? "Holding losers significantly longer than winners — classic disposition effect."
          : "Balanced hold durations across wins and losses.",
    },
    periodComparison: null,
  };
}

function generateSampleTrades(): TradeRecord[] {
  const now = Date.now();
  const min = 60_000;
  const hr = 3_600_000;
  const raw: TradeRecord[] = [
    {
      id: "demo-1",
      symbol: "SOL_USDT",
      side: "long",
      openTime: now - 36 * hr,
      closeTime: now - 35.2 * hr,
      holdMinutes: 48,
      quantity: 120,
      entryPrice: 142.4,
      exitPrice: 146.1,
      realizedPnl: 184.5,
      fee: 3.2,
      leakFlags: [],
    },
    {
      id: "demo-2",
      symbol: "BTC_USDT",
      side: "short",
      openTime: now - 28 * hr,
      closeTime: now - 27.5 * hr,
      holdMinutes: 30,
      quantity: 0.8,
      entryPrice: 84200,
      exitPrice: 84650,
      realizedPnl: -92.4,
      fee: 4.1,
      leakFlags: [],
    },
    {
      id: "demo-3",
      symbol: "BTC_USDT",
      side: "long",
      openTime: now - 27.5 * hr + 12 * min,
      closeTime: now - 27 * hr,
      holdMinutes: 18,
      quantity: 1.2,
      entryPrice: 84700,
      exitPrice: 84120,
      realizedPnl: -148.0,
      fee: 5.8,
      leakFlags: [],
    },
    {
      id: "demo-4",
      symbol: "PEPE_USDT",
      side: "long",
      openTime: now - 27 * hr + 8 * min,
      closeTime: now - 23.5 * hr,
      holdMinutes: 202,
      quantity: 50000,
      entryPrice: 0.00000422,
      exitPrice: 0.00000398,
      realizedPnl: -215.6,
      fee: 6.4,
      leakFlags: [],
    },
    {
      id: "demo-5",
      symbol: "SUI_USDT",
      side: "long",
      openTime: now - 16 * hr,
      closeTime: now - 14.8 * hr,
      holdMinutes: 72,
      quantity: 1500,
      entryPrice: 2.18,
      exitPrice: 2.31,
      realizedPnl: 265.0,
      fee: 3.8,
      leakFlags: [],
    },
    {
      id: "demo-6",
      symbol: "ETH_USDT",
      side: "long",
      openTime: now - 10 * hr,
      closeTime: now - 9.2 * hr,
      holdMinutes: 48,
      quantity: 6,
      entryPrice: 1920,
      exitPrice: 1954,
      realizedPnl: 198.2,
      fee: 3.5,
      leakFlags: [],
    },
    {
      id: "demo-7",
      symbol: "DOGE_USDT",
      side: "short",
      openTime: now - 6 * hr,
      closeTime: now - 5.93 * hr,
      holdMinutes: 4,
      quantity: 20000,
      entryPrice: 0.1642,
      exitPrice: 0.1648,
      realizedPnl: -34.2,
      fee: 6.8,
      leakFlags: [],
    },
    {
      id: "demo-8",
      symbol: "HYPE_USDT",
      side: "long",
      openTime: now - 3 * hr,
      closeTime: now - 2.1 * hr,
      holdMinutes: 54,
      quantity: 200,
      entryPrice: 14.8,
      exitPrice: 15.65,
      realizedPnl: 166.4,
      fee: 2.9,
      leakFlags: [],
    },
  ];
  return raw;
}

export default function JournalPage() {
  const [data, setData] = useState<ExtendedJournalPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeLeak, setActiveLeak] = useState<LeakFlag | "all">("all");
  const [activeRange, setActiveRange] = useState<JournalRangeKey>(() => {
    if (typeof window !== "undefined") {
      return (localStorage.getItem("journalRange") as JournalRangeKey) || "all";
    }
    return "all";
  });
  const [activeSymbol, setActiveSymbol] = useState("");
  const [activeSide, setActiveSide] = useState<typeof SIDE_OPTIONS[number]>("all");
  const [activeOutcome, setActiveOutcome] = useState<typeof OUTCOME_OPTIONS[number]>("all");
  const [ai, setAi] = useState<JournalAiInsights | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [selectedTrade, setSelectedTrade] = useState<TradeRecord | null>(null);
  const [chart, setChart] = useState<TradeChartPayload | null>(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);
  const [showTvEmbed, setShowTvEmbed] = useState(false);
  const [isCustomMode, setIsCustomMode] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const tradesSectionRef = useRef<HTMLElement | null>(null);

  const fetchJournal = useCallback(async (range: JournalRangeKey) => {
    setLoading(true);
    try {
      const url = new URL("/api/journal", window.location.origin);
      url.searchParams.set("range", range);
      const res = await fetch(url.toString(), { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = (await res.json()) as ExtendedJournalPayload;
      setData(payload);
      setIsCustomMode(false);
      setError(null);
      localStorage.setItem("journalRange", range);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load journal");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isCustomMode) return;
    void fetchJournal(activeRange);
    const timer = setInterval(() => {
      if (!isCustomMode) void fetchJournal(activeRange);
    }, 60_000);
    return () => {
      clearInterval(timer);
    };
  }, [fetchJournal, activeRange, isCustomMode]);

  useEffect(() => {
    setSelectedTrade(null);
    setChart(null);
  }, [activeRange, activeSymbol, activeSide, activeOutcome]);

  useEffect(() => {
    if (!data || isCustomMode) return;
    let alive = true;
    const loadAi = async () => {
      try {
        setAiLoading(true);
        const url = new URL("/api/journal/ai", window.location.origin);
        url.searchParams.set("range", activeRange);
        const res = await fetch(url.toString(), { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = (await res.json()) as JournalAiInsights;
        if (!alive) return;
        setAi(payload);
      } catch {
        if (!alive) return;
        setAi(null);
      } finally {
        if (alive) setAiLoading(false);
      }
    };
    void loadAi();
    return () => {
      alive = false;
    };
  }, [data?.overview.rangeKey, activeRange, isCustomMode]);

  useEffect(() => {
    if (!selectedTrade) {
      setChart(null);
      setChartError(null);
      return;
    }
    let alive = true;
    const loadChart = async () => {
      try {
        setChartLoading(true);
        setChartError(null);
        const url = new URL("/api/journal/trade-chart", window.location.origin);
        url.searchParams.set("symbol", selectedTrade.symbol);
        url.searchParams.set("openTime", String(selectedTrade.openTime));
        url.searchParams.set("closeTime", String(selectedTrade.closeTime));
        if (selectedTrade.entryPrice !== null) url.searchParams.set("entryPrice", String(selectedTrade.entryPrice));
        if (selectedTrade.exitPrice !== null) url.searchParams.set("exitPrice", String(selectedTrade.exitPrice));
        const res = await fetch(url.toString(), { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = (await res.json()) as TradeChartPayload;
        if (!alive) return;
        setChart(payload);
      } catch (e) {
        if (!alive) return;
        setChartError(e instanceof Error ? e.message : "Failed to load chart");
        setChart(null);
      } finally {
        if (alive) setChartLoading(false);
      }
    };
    void loadChart();
    return () => {
      alive = false;
    };
  }, [selectedTrade]);

  const handleLoadDemo = () => {
    const sample = generateSampleTrades();
    const evaluated = evaluateTradesClientSide(
      sample,
      activeRange,
      "Demo Session Active: Displaying simulated MEXC trades with leak detection & live kline drilldown.",
    );
    setIsCustomMode(true);
    setData(evaluated);
    setSelectedTrade(evaluated.trades[0] ?? null);
  };

  const handleImportCsv = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length < 2) return;
      const imported: TradeRecord[] = [];
      for (let i = 1; i < lines.length; i += 1) {
        const cols = lines[i].split(",").map((c) => c.replace(/^"|"$/g, "").trim());
        if (cols.length < 5) continue;
        const closeTime = Date.parse(cols[0]) || Date.now() - i * 3_600_000;
        const rawSym = (cols[1] || "BTC_USDT").toUpperCase();
        const symbol = rawSym.includes("_") ? rawSym : rawSym.replace(/USDT$/, "_USDT");
        const sideRaw = (cols[2] || "long").toLowerCase();
        const side: TradeRecord["side"] = sideRaw.includes("short") ? "short" : "long";
        const holdMinutes = Math.max(1, Number(cols[3]) || 15);
        const openTime = closeTime - holdMinutes * 60_000;
        const entryPrice = cols[4] ? Number(cols[4]) : null;
        const exitPrice = cols[5] ? Number(cols[5]) : null;
        const fee = Math.abs(Number(cols[6]) || 0);
        const realizedPnl = Number(cols[7] ?? cols[4]) || 0;
        imported.push({
          id: `csv-${i}-${closeTime}`,
          symbol,
          side,
          openTime,
          closeTime,
          holdMinutes,
          quantity: 1,
          entryPrice: Number.isFinite(entryPrice) ? entryPrice : null,
          exitPrice: Number.isFinite(exitPrice) ? exitPrice : null,
          realizedPnl,
          fee,
          leakFlags: [],
        });
      }
      if (imported.length) {
        const evaluated = evaluateTradesClientSide(
          imported,
          activeRange,
          `Imported ${imported.length} trades from CSV (${file.name}).`,
        );
        setIsCustomMode(true);
        setData(evaluated);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const filteredTrades = useMemo(() => {
    if (!data) return [];
    let trades = data.trades;
    if (activeLeak !== "all") {
      trades = trades.filter((t) => t.leakFlags.includes(activeLeak));
    }
    if (activeSymbol) {
      trades = trades.filter((t) => t.symbol.toUpperCase().includes(activeSymbol));
    }
    if (activeSide !== "all") {
      trades = trades.filter((t) => t.side === activeSide);
    }
    if (activeOutcome === "wins") {
      trades = trades.filter((t) => t.realizedPnl > 0);
    } else if (activeOutcome === "losses") {
      trades = trades.filter((t) => t.realizedPnl < 0);
    }
    return trades;
  }, [data, activeLeak, activeSymbol, activeSide, activeOutcome]);

  const leakCost = useMemo(() => {
    if (!data) return 0;
    return data.trades
      .filter((t) => t.leakFlags.length)
      .reduce((acc, t) => acc + t.realizedPnl, 0);
  }, [data]);

  const sortedLeakBuckets = useMemo(() => {
    if (!data) return [];
    return [...data.overview.leakBuckets].sort((a, b) => a.grossPnl - b.grossPnl);
  }, [data]);

  const chartMeta = useMemo(() => {
    if (!chart?.points?.length) return null;
    const close = chart.points.map((p) => p.close);
    const mm = minMax(close);
    return {
      polyline: chartPolyline(chart.points, 950, 320),
      min: mm.min,
      max: mm.max,
    };
  }, [chart]);

  const confidenceClass = ai?.confidence === "high"
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
    : ai?.confidence === "low"
      ? "border-rose-500/30 bg-rose-500/10 text-rose-300"
      : "border-amber-500/30 bg-amber-500/10 text-amber-300";

  return (
    <div className="min-h-screen bg-[#06080c] text-zinc-200">
      <div className="mx-auto max-w-[1800px] px-3 py-3 sm:px-4">
        <header className="sticky top-0 z-40 rounded-xl border border-zinc-800/80 bg-[#0b0e15]/95 p-3 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h1 className="text-base font-bold tracking-tight text-zinc-100">MEXC Execution Journal & Leak Detector</h1>
              <p className="font-mono text-[11px] text-zinc-500">
                Private MEXC API sync + CSV import • Automated behavioral leak classification
              </p>
            </div>
            <nav className="flex flex-wrap items-center gap-1.5 text-xs">
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                onChange={handleImportCsv}
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="rounded border border-cyan-500/40 bg-cyan-500/15 px-2.5 py-1.5 font-medium text-cyan-200 hover:bg-cyan-500/25"
              >
                Import CSV
              </button>
              <button
                onClick={handleLoadDemo}
                className="rounded border border-amber-500/40 bg-amber-500/15 px-2.5 py-1.5 font-medium text-amber-200 hover:bg-amber-500/25"
              >
                Load Demo Session
              </button>
              {isCustomMode && (
                <button
                  onClick={() => {
                    setIsCustomMode(false);
                    void fetchJournal(activeRange);
                  }}
                  className="rounded border border-zinc-700 bg-[#121621] px-2.5 py-1.5 text-zinc-300 hover:border-zinc-500"
                >
                  Sync Live API
                </button>
              )}
              <div className="h-4 w-px bg-zinc-800" />
              <Link href="/screener/mexc" className="rounded border border-zinc-700 bg-[#121621] px-2.5 py-1.5 text-zinc-300 hover:border-zinc-500">
                MEXC Screener
              </Link>
              <Link href="/screener/performers" className="rounded border border-zinc-700 bg-[#121621] px-2.5 py-1.5 text-zinc-300 hover:border-zinc-500">
                Performers
              </Link>
              <Link href="/screener/watchlist" className="rounded border border-zinc-700 bg-[#121621] px-2.5 py-1.5 text-zinc-300 hover:border-zinc-500">
                Watchlist
              </Link>
              <Link href="/screener/mexc/spaghetti/price" className="rounded border border-zinc-700 bg-[#121621] px-2.5 py-1.5 text-zinc-300 hover:border-zinc-500">
                Spaghetti
              </Link>
            </nav>
          </div>
        </header>

        {loading && !data ? (
          <div className="py-24 text-center text-zinc-500">Loading journal...</div>
        ) : error ? (
          <div className="mt-3 rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">Failed to load: {error}</div>
        ) : !data ? (
          <div className="mt-3 rounded-md border border-zinc-800 bg-[#0d0f14] p-3 text-sm text-zinc-400">No data</div>
        ) : (
          <>
            {!!data.overview.warnings.length && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                <div className="space-y-1">
                  {data.overview.warnings.map((w) => (
                    <div key={w}>{w}</div>
                  ))}
                </div>
                {!data.trades.length && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleLoadDemo}
                      className="rounded border border-amber-400/50 bg-amber-500/20 px-3 py-1.5 font-semibold text-amber-100 hover:bg-amber-500/30"
                    >
                      Preview with Demo Trades
                    </button>
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="rounded border border-cyan-400/50 bg-cyan-500/20 px-3 py-1.5 font-semibold text-cyan-100 hover:bg-cyan-500/30"
                    >
                      Import CSV History
                    </button>
                  </div>
                )}
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800/70 bg-[#0d0f14] p-2">
              <div className="flex flex-wrap gap-1">
                {RANGE_OPTIONS.map((r) => (
                  <button
                    key={r.key}
                    onClick={() => setActiveRange(r.key)}
                    className={`rounded px-2 py-1 text-xs font-medium ${
                      activeRange === r.key
                        ? "bg-cyan-600 text-white"
                        : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              <div className="h-4 w-px bg-zinc-700" />
              <input
                type="text"
                placeholder="Symbol search..."
                value={activeSymbol}
                onChange={(e) => setActiveSymbol(e.target.value.toUpperCase())}
                className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              />
              <div className="flex gap-1">
                {SIDE_OPTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => setActiveSide(s)}
                    className={`rounded px-2 py-1 text-xs font-medium capitalize ${
                      activeSide === s
                        ? "bg-emerald-600 text-white"
                        : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <div className="flex gap-1">
                {OUTCOME_OPTIONS.map((o) => (
                  <button
                    key={o}
                    onClick={() => setActiveOutcome(o)}
                    className={`rounded px-2 py-1 text-xs font-medium capitalize ${
                      activeOutcome === o
                        ? "bg-amber-600 text-white"
                        : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                    }`}
                  >
                    {o}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
              <StatCard label="Net PnL" value={money(data.overview.netPnl)} accent={data.overview.netPnl >= 0 ? "text-emerald-300" : "text-rose-300"} />
              <StatCard label="Win Rate" value={`${data.overview.winRate.toFixed(1)}%`} />
              <StatCard label="Profit Factor" value={data.overview.profitFactor.toFixed(2)} />
              <StatCard label="Expectancy" value={money(data.overview.expectancy)} accent={data.overview.expectancy >= 0 ? "text-emerald-300" : "text-rose-300"} />
              <StatCard label="Leak PnL" value={money(leakCost)} accent={leakCost >= 0 ? "text-emerald-300" : "text-rose-300"} />
              <StatCard label="No Leak PnL" value={money(data.overview.tradesWithoutLeaksPnl)} accent={data.overview.tradesWithoutLeaksPnl >= 0 ? "text-emerald-300" : "text-rose-300"} />
            </div>

            <section className="mt-3 rounded-xl border border-zinc-800/70 bg-[#0d0f14] p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-xs font-semibold text-zinc-400">AI Coach</div>
                <div className="text-[11px] text-zinc-500">Model: {process.env.NEXT_PUBLIC_AI_MODEL_LABEL || "deepseek-chat"}</div>
              </div>
              {aiLoading ? (
                <div className="text-sm text-zinc-500">Thinking...</div>
              ) : ai ? (
                <div className="rounded-2xl border border-zinc-700/70 bg-[linear-gradient(180deg,#0d1322,#0a1020)] p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xl font-semibold tracking-tight text-zinc-100">{ai.title}</div>
                    <div className={`rounded-full border px-3 py-1 text-xs ${confidenceClass}`}>
                      {ai.confidence === "high" ? "High Confidence" : ai.confidence === "low" ? "Low Confidence" : "Medium Confidence"}
                    </div>
                  </div>

                  <div className="grid gap-3 lg:grid-cols-2">
                    <div className="rounded-xl border border-zinc-700/70 bg-[#111827]/50 p-3">
                      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-400">What We Found</div>
                      <div className="text-sm text-zinc-200">{ai.whatWeFound.statement}</div>
                      <div className="mt-2 text-xs text-zinc-400">
                        p-value: {ai.whatWeFound.pValueText} &nbsp; Significant: {ai.whatWeFound.significant ? "Yes" : "No"} &nbsp; Effect size: {ai.whatWeFound.effectSizeText}
                      </div>
                    </div>

                    <div className="rounded-xl border border-zinc-700/70 bg-[#111827]/50 p-3">
                      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-400">Why It Matters</div>
                      <div className="text-sm text-zinc-200">{ai.whyItMatters}</div>
                    </div>
                  </div>

                  <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3">
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-amber-300">The Psychology</div>
                    <div className="text-base font-medium text-amber-200">{ai.psychology.biasName}</div>
                    <div className="mt-1 text-sm text-zinc-200">{ai.psychology.explanation}</div>
                    <div className="mt-2 text-xs text-zinc-500">{ai.psychology.reference}</div>
                  </div>

                  <div className="mt-3 grid gap-3 lg:grid-cols-2">
                    <div className="rounded-xl border border-zinc-700/70 bg-[#111827]/50 p-3">
                      <div className="text-base font-semibold text-zinc-100">{ai.whatToDo.primaryAction.title}</div>
                      <div className="mt-1 text-sm text-zinc-300">{ai.whatToDo.primaryAction.description}</div>
                      <button
                        onClick={() => {
                          const worstLeak = sortedLeakBuckets[0];
                          if (worstLeak && worstLeak.tradeCount > 0) {
                            setActiveLeak(worstLeak.key);
                          }
                          tradesSectionRef.current?.scrollIntoView({ behavior: "smooth" });
                        }}
                        className="mt-3 w-full rounded-md bg-orange-600 px-3 py-2 text-sm font-medium text-white hover:bg-orange-500"
                      >
                        {ai.whatToDo.primaryAction.cta}
                      </button>
                    </div>

                    <div className="rounded-xl border border-zinc-700/70 bg-[#111827]/50 p-3">
                      <div className="text-base font-semibold text-zinc-100">{ai.whatToDo.secondaryAction.title}</div>
                      <div className="mt-1 text-sm text-zinc-300">{ai.whatToDo.secondaryAction.description}</div>
                      <button
                        onClick={() => {
                          setActiveOutcome("losses");
                          tradesSectionRef.current?.scrollIntoView({ behavior: "smooth" });
                        }}
                        className="mt-3 w-full rounded-md border border-zinc-600 bg-zinc-800/70 px-3 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-700/70"
                      >
                        {ai.whatToDo.secondaryAction.cta}
                      </button>
                    </div>
                  </div>

                  <div className="mt-3 border-t border-zinc-700/60 pt-2 text-xs text-zinc-500">
                    Based on {ai.basis.tradesAnalyzed} trades (minimum required: {ai.basis.minimumRequired})
                  </div>
                </div>
              ) : (
                <div className="text-xs text-zinc-500">AI insights unavailable.</div>
              )}
            </section>

            <div className="mt-3 grid gap-3 xl:grid-cols-2">
              <section className="rounded-xl border border-zinc-800/70 bg-[#0d0f14] p-3">
                <div className="mb-2 text-xs font-semibold text-zinc-400">Leak Cost by Category (Click to Filter)</div>
                <div className="space-y-2">
                  {sortedLeakBuckets.map((bucket) => {
                    const width = Math.min(100, Math.abs(bucket.grossPnl) * 2);
                    return (
                      <button
                        key={bucket.key}
                        onClick={() => setActiveLeak((prev) => (prev === bucket.key ? "all" : bucket.key))}
                        className={`block w-full rounded border px-2 py-2 text-left text-xs ${activeLeak === bucket.key ? "border-cyan-500/50 bg-cyan-500/10" : "border-zinc-800 bg-[#11131a]"}`}
                      >
                        <div className="mb-1 flex items-center justify-between">
                          <span>{bucket.label}</span>
                          <span className={bucket.grossPnl >= 0 ? "text-emerald-300" : "text-rose-300"}>{money(bucket.grossPnl)}</span>
                        </div>
                        <div className="h-1.5 rounded bg-zinc-800">
                          <div
                            className={`h-1.5 rounded ${bucket.grossPnl >= 0 ? "bg-emerald-500/70" : "bg-rose-500/70"}`}
                            style={{ width: `${width}%` }}
                          />
                        </div>
                        <div className="mt-1 text-zinc-500">{bucket.tradeCount} trades flagged</div>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="rounded-xl border border-zinc-800/70 bg-[#0d0f14] p-3">
                <div className="mb-2 text-xs font-semibold text-zinc-400">Kill-Switch Simulation</div>
                <div className="space-y-2 text-sm">
                  <div className="rounded border border-zinc-800 bg-[#11131a] px-3 py-2">
                    <div className="text-zinc-500">Consecutive-loss triggers</div>
                    <div className="text-lg text-zinc-200">{data.overview.consecutiveLossStopTriggers}</div>
                  </div>
                  <div className="rounded border border-zinc-800 bg-[#11131a] px-3 py-2">
                    <div className="text-zinc-500">High-frequency losing days</div>
                    <div className="text-lg text-zinc-200">{data.overview.dailyLossStopTriggers}</div>
                  </div>
                  <div className="text-xs text-zinc-500">Defaults: 45m cooldown, &gt;3 trades/60m cluster, &gt;8 trades/day high-frequency.</div>
                </div>
              </section>
            </div>

            <div className="mt-3 grid gap-3 xl:grid-cols-2">
              {data.symbolStats && (
                <section className="rounded-xl border border-zinc-800/70 bg-[#0d0f14] p-3">
                  <div className="mb-2 flex items-center justify-between text-xs font-semibold text-zinc-400">
                    Symbol Performance (Top/Bottom)
                    <button
                      onClick={() => exportToCsv(data.trades, `trades_${data.overview.rangeKey}_${Date.now()}.csv`)}
                      className="rounded bg-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-600"
                    >
                      Export CSV
                    </button>
                  </div>
                  <div className="max-h-48 overflow-auto">
                    <table className="min-w-full text-[11px]">
                      <thead className="sticky top-0 bg-[#0d0f14]">
                        <tr className="border-b border-zinc-800 text-zinc-500">
                          <th className="px-2 py-1 text-left">Symbol</th>
                          <th className="px-2 py-1 text-right">Trades</th>
                          <th className="px-2 py-1 text-right">Win%</th>
                          <th className="px-2 py-1 text-right">PnL</th>
                          <th className="px-2 py-1 text-right">Avg Hold</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.symbolStats.slice(0, 15).map((s) => (
                          <tr key={s.symbol} className="border-b border-zinc-900/50">
                            <td className="px-2 py-1 text-zinc-200">{s.symbol.replace("_USDT", "")}</td>
                            <td className="px-2 py-1 text-right text-zinc-400">{s.tradeCount}</td>
                            <td className={`px-2 py-1 text-right ${s.winRate >= 50 ? "text-emerald-400" : "text-rose-400"}`}>{s.winRate.toFixed(0)}%</td>
                            <td className={`px-2 py-1 text-right ${s.netPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{money(s.netPnl)}</td>
                            <td className="px-2 py-1 text-right text-zinc-400">{s.avgHoldMinutes.toFixed(0)}m</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              {data.holdTimeAnalysis && (
                <section className="rounded-xl border border-zinc-800/70 bg-[#0d0f14] p-3">
                  <div className="mb-2 text-xs font-semibold text-zinc-400">Hold Time Analysis</div>
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-zinc-400">Avg win hold:</span>
                      <span className="text-emerald-400">{data.holdTimeAnalysis.avgWinHold.toFixed(1)}m</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-zinc-400">Avg loss hold:</span>
                      <span className="text-rose-400">{data.holdTimeAnalysis.avgLossHold.toFixed(1)}m</span>
                    </div>
                    <div className="rounded border border-zinc-700 bg-[#11131a] px-3 py-2 text-xs">
                      <span className="text-zinc-400">Insight: </span>
                      <span className={data.holdTimeAnalysis.holdDifference > 0 ? "text-amber-400" : data.holdTimeAnalysis.holdDifference < 0 ? "text-rose-400" : "text-zinc-300"}>
                        {data.holdTimeAnalysis.implication}
                      </span>
                    </div>
                  </div>
                </section>
              )}
            </div>

            {data.periodComparison && (
              <div className="mt-3 rounded-xl border border-zinc-800/70 bg-[#0d0f14] p-3">
                <div className="mb-2 text-xs font-semibold text-zinc-400">Period Comparison (Current vs Prior)</div>
                <div className="grid gap-2 sm:grid-cols-3">
                  <div className="rounded border border-zinc-700 bg-[#11131a] px-3 py-2 text-center">
                    <div className="text-xs text-zinc-500">Current ({data.overview.rangeKey})</div>
                    <div className="text-lg font-semibold text-zinc-200">{data.periodComparison.currentPeriod.netPnl >= 0 ? "+" : ""}{data.periodComparison.currentPeriod.netPnl.toFixed(2)}</div>
                    <div className="text-xs text-zinc-500">{data.periodComparison.currentPeriod.trades} trades</div>
                  </div>
                  <div className="rounded border border-zinc-700 bg-[#11131a] px-3 py-2 text-center">
                    <div className="text-xs text-zinc-500">Prior Period</div>
                    <div className="text-lg font-semibold text-zinc-200">{data.periodComparison.priorPeriod.netPnl >= 0 ? "+" : ""}{data.periodComparison.priorPeriod.netPnl.toFixed(2)}</div>
                    <div className="text-xs text-zinc-500">{data.periodComparison.priorPeriod.trades} trades</div>
                  </div>
                  <div className="rounded border border-zinc-700 bg-[#11131a] px-3 py-2 text-center">
                    <div className="text-xs text-zinc-500">Trend</div>
                    <div className={`text-lg font-semibold ${data.periodComparison.trend === "improving" ? "text-emerald-400" : data.periodComparison.trend === "degrading" ? "text-rose-400" : "text-zinc-400"}`}>
                      {data.periodComparison.changePercent >= 0 ? "+" : ""}{data.periodComparison.changePercent}%
                    </div>
                    <div className="text-xs capitalize text-zinc-500">{data.periodComparison.trend}</div>
                  </div>
                </div>
              </div>
            )}

            <section ref={tradesSectionRef} className="mt-3 overflow-hidden rounded-xl border border-zinc-800/70 bg-[#0d0f14]">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2 text-xs">
                <span className="text-zinc-400 font-semibold">Recent Trades ({filteredTrades.length})</span>
                <div className="flex flex-wrap gap-1">
                  <button
                    onClick={() => setActiveLeak("all")}
                    className={`rounded border px-2 py-1 ${activeLeak === "all" ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-300" : "border-zinc-700 text-zinc-400"}`}
                  >
                    All
                  </button>
                  {(Object.keys(LEAK_LABELS) as LeakFlag[]).map((k) => (
                    <button
                      key={k}
                      onClick={() => setActiveLeak(k)}
                      className={`rounded border px-2 py-1 ${activeLeak === k ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-300" : "border-zinc-700 text-zinc-400"}`}
                    >
                      {LEAK_LABELS[k]}
                    </button>
                  ))}
                </div>
              </div>
              <div className="overflow-auto">
                <table className="min-w-full text-[12px]">
                  <thead className="sticky top-0 z-30 bg-[#0f121a]">
                    <tr className="border-b border-zinc-800">
                      <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide text-zinc-500">Close Time</th>
                      <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide text-zinc-500">Symbol</th>
                      <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide text-zinc-500">Side</th>
                      <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide text-zinc-500">Hold</th>
                      <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide text-zinc-500">Fee</th>
                      <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide text-zinc-500">PnL</th>
                      <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide text-zinc-500">Leak Flags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTrades.slice(0, 300).map((trade, idx) => (
                      <tr
                        key={trade.id}
                        onClick={() => setSelectedTrade(trade)}
                        className={`cursor-pointer border-b border-zinc-900/80 ${idx % 2 === 0 ? "bg-[#0b0d13]" : "bg-[#0d1018]"} ${selectedTrade?.id === trade.id ? "bg-cyan-500/10" : "hover:bg-zinc-800/40"}`}
                      >
                        <td className="whitespace-nowrap px-3 py-2 text-zinc-300">{dt(trade.closeTime)}</td>
                        <td className="px-3 py-2 font-semibold text-zinc-100">{trade.symbol}</td>
                        <td className={`px-3 py-2 font-medium ${sideColor(trade.side)}`}>{trade.side}</td>
                        <td className="px-3 py-2 text-zinc-300">{trade.holdMinutes.toFixed(1)}m</td>
                        <td className="px-3 py-2 text-zinc-300">{money(trade.fee)}</td>
                        <td className={`px-3 py-2 font-semibold ${trade.realizedPnl >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{money(trade.realizedPnl)}</td>
                        <td className="px-3 py-2 text-zinc-300">{leakDisplay(trade.leakFlags)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="mt-3 overflow-hidden rounded-xl border border-zinc-800/70 bg-[#0d0f14]">
              <div className="border-b border-zinc-800 px-3 py-2 text-xs text-zinc-500">Trade Drilldown Chart</div>
              {!selectedTrade ? (
                <div className="p-5 text-sm text-zinc-500">Click a trade row to load entry/exit chart context.</div>
              ) : chartLoading ? (
                <div className="p-5 text-sm text-zinc-500">Loading chart...</div>
              ) : chartError ? (
                <div className="p-5 text-sm text-rose-300">Failed to load chart: {chartError}</div>
              ) : chart && chartMeta ? (
                <div className="p-3">
                  <div className="mb-2 grid gap-2 text-xs sm:grid-cols-4">
                    <div className="rounded border border-zinc-800 bg-[#11131a] px-2 py-1 text-zinc-300">Symbol: {chart.symbol}</div>
                    <div className="rounded border border-zinc-800 bg-[#11131a] px-2 py-1 text-zinc-300">Entry: {dt(chart.entry.timestamp)}</div>
                    <div className="rounded border border-zinc-800 bg-[#11131a] px-2 py-1 text-zinc-300">Exit: {dt(chart.exit.timestamp)}</div>
                    <div className="rounded border border-zinc-800 bg-[#11131a] px-2 py-1 text-zinc-300">Hold: {selectedTrade.holdMinutes.toFixed(1)}m</div>
                  </div>

                  <div className="w-full overflow-x-auto rounded border border-zinc-800 bg-[#0a0d14]">
                    <svg viewBox="0 0 950 320" className="min-w-[860px] w-full" role="img" aria-label="Selected trade chart">
                      <rect x="0" y="0" width="950" height="320" fill="#0a0d14" />
                      <line x1="40" y1="20" x2="40" y2="300" stroke="#2a2f3a" strokeWidth="1" />
                      <line x1="40" y1="300" x2="910" y2="300" stroke="#2a2f3a" strokeWidth="1" />
                      <polyline points={chartMeta.polyline} fill="none" stroke="#6ee7ff" strokeWidth="1.8" opacity="0.9" />

                      {chart.entry.price !== null && (
                        <>
                          <line
                            x1={markerX(chart.entry.timestamp, chart.windowStart, chart.windowEnd, 950)}
                            y1="20"
                            x2={markerX(chart.entry.timestamp, chart.windowStart, chart.windowEnd, 950)}
                            y2="300"
                            stroke="#22c55e"
                            strokeWidth="1"
                            strokeDasharray="4 4"
                          />
                          <circle
                            cx={markerX(chart.entry.timestamp, chart.windowStart, chart.windowEnd, 950)}
                            cy={markerY(chart.entry.price, chartMeta.min, chartMeta.max, 320)}
                            r="4"
                            fill="#22c55e"
                          />
                        </>
                      )}

                      {chart.exit.price !== null && (
                        <>
                          <line
                            x1={markerX(chart.exit.timestamp, chart.windowStart, chart.windowEnd, 950)}
                            y1="20"
                            x2={markerX(chart.exit.timestamp, chart.windowStart, chart.windowEnd, 950)}
                            y2="300"
                            stroke="#f43f5e"
                            strokeWidth="1"
                            strokeDasharray="4 4"
                          />
                          <circle
                            cx={markerX(chart.exit.timestamp, chart.windowStart, chart.windowEnd, 950)}
                            cy={markerY(chart.exit.price, chartMeta.min, chartMeta.max, 320)}
                            r="4"
                            fill="#f43f5e"
                          />
                        </>
                      )}
                    </svg>
                  </div>

                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    <a
                      href={`https://www.tradingview.com/chart/?symbol=MEXC:${parseSymbolForTv(selectedTrade.symbol)}.P`}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded border border-zinc-700 bg-[#12141c] px-3 py-1 text-zinc-300 hover:border-zinc-500"
                    >
                      Open TradingView
                    </a>
                    <div className="rounded border border-zinc-800 bg-[#11131a] px-3 py-1 text-zinc-300">PnL: {money(selectedTrade.realizedPnl)}</div>
                    <div className="rounded border border-zinc-800 bg-[#11131a] px-3 py-1 text-zinc-300">Leak flags: {leakDisplay(selectedTrade.leakFlags)}</div>
                    <button
                      onClick={() => setShowTvEmbed((prev) => !prev)}
                      className="rounded border border-cyan-600/40 bg-cyan-500/10 px-3 py-1 text-cyan-300"
                    >
                      {showTvEmbed ? "Hide TV" : "Show TV Dropdown"}
                    </button>
                  </div>

                  {showTvEmbed && (
                    <div className="mt-3 overflow-hidden rounded border border-zinc-800 bg-[#0a0d14]">
                      <iframe
                        title="TradingView dropdown chart"
                        src={`https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(`MEXC:${parseSymbolForTv(selectedTrade.symbol)}.P`)}&interval=15&hidesidetoolbar=1&symboledit=1&saveimage=0&toolbarbg=131722&theme=dark&style=1&locale=en`}
                        className="h-[460px] w-full"
                        allow="clipboard-write"
                      />
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-5 text-sm text-zinc-500">No chart data in selected window.</div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-xl border border-zinc-800/70 bg-[#0d0f14] p-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`text-lg font-semibold ${accent ?? "text-zinc-100"}`}>{value}</div>
    </div>
  );
}
