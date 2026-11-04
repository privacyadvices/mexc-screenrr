import { LEAK_LABELS, type JournalPayload, type JournalRangeKey, type LeakFlag, type SymbolStats, type PeriodComparison, type HoldTimeAnalysis, type TradeRecord } from "@/lib/journal";
import { fetchMexcHistoryTrades } from "@/lib/server/mexcPrivate";

const COOLDOWN_MINUTES = 45;
const CLUSTER_WINDOW_MINUTES = 90;
const CLUSTER_MAX_ENTRIES = 2;
const HIGH_FREQUENCY_DAILY = 6;
const NO_SETUP_HOLD_MINUTES = 15;
const REVENGE_LOSS_STREAK = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export const RANGE_MS: Record<JournalRangeKey, number> = {
  "24h": 1 * HOUR_MS * 24,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
  "60d": 60 * DAY_MS,
  "90d": 90 * DAY_MS,
  "1y": 365 * DAY_MS,
  "all": Infinity,
};

function clampTs(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function ratio(num: number, den: number): number {
  if (!den) return 0;
  return num / den;
}

function pushFlag(flags: LeakFlag[], flag: LeakFlag): void {
  if (!flags.includes(flag)) flags.push(flag);
}

function addLeakFlags(trades: TradeRecord[]): { trades: TradeRecord[]; dailyLossStopTriggers: number; consecutiveLossStopTriggers: number } {
  const withFlags = trades.map((t) => ({ ...t, leakFlags: [...t.leakFlags] }));
  const dayCounts = new Map<string, number>();
  let dailyLossStopTriggers = 0;
  let consecutiveLossStopTriggers = 0;
  let streakLosses = 0;

  for (let i = 0; i < withFlags.length; i += 1) {
    const trade = withFlags[i];
    const priorStreakLosses = streakLosses;
    const dKey = dayKey(trade.openTime);
    dayCounts.set(dKey, (dayCounts.get(dKey) ?? 0) + 1);

    let recentLosingClose: number | null = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      const prev = withFlags[j];
      if (prev.realizedPnl >= 0) continue;
      const gapMinutes = (trade.openTime - prev.closeTime) / 60_000;
      if (gapMinutes < 0) continue;
      if (gapMinutes <= COOLDOWN_MINUTES) {
        recentLosingClose = prev.closeTime;
        pushFlag(trade.leakFlags, "POST_LOSS_CHASE");
      }
      break;
    }

    let inWindow = 0;
    for (let j = i; j >= 0; j -= 1) {
      const diff = (trade.openTime - withFlags[j].openTime) / 60_000;
      if (diff > CLUSTER_WINDOW_MINUTES) break;
      inWindow += 1;
    }
    if (inWindow > CLUSTER_MAX_ENTRIES) {
      pushFlag(trade.leakFlags, "OVERTRADING_CLUSTER");
    }

    if ((dayCounts.get(dKey) ?? 0) > HIGH_FREQUENCY_DAILY) {
      pushFlag(trade.leakFlags, "HIGH_FREQUENCY_SESSION");
    }

    if (trade.holdMinutes < NO_SETUP_HOLD_MINUTES || (trade.holdMinutes < 30 && trade.realizedPnl < 0 && inWindow > 1)) {
      pushFlag(trade.leakFlags, "NO_SETUP_PROXY");
    }

    if ( priorStreakLosses >= REVENGE_LOSS_STREAK && recentLosingClose !== null) {
      const gapMinutes = (trade.openTime - recentLosingClose) / 60_000;
      if (gapMinutes >= 0 && gapMinutes <= COOLDOWN_MINUTES * 2) {
        pushFlag(trade.leakFlags, "REVENGE_STREAK");
        consecutiveLossStopTriggers += 1;
      }
    }

    if (trade.realizedPnl < 0) {
      streakLosses += 1;
    } else if (trade.realizedPnl > 0) {
      streakLosses = 0;
    }
  }

  for (const [d, count] of dayCounts.entries()) {
    if (count > HIGH_FREQUENCY_DAILY) {
      const dayStart = new Date(`${d}T00:00:00.000Z`).getTime();
      const dayEnd = dayStart + DAY_MS;
      const dayNet = withFlags
        .filter((t) => t.openTime >= dayStart && t.openTime < dayEnd)
        .reduce((acc, t) => acc + t.realizedPnl, 0);
      if (dayNet < 0) dailyLossStopTriggers += 1;
    }
  }

  return { trades: withFlags, dailyLossStopTriggers, consecutiveLossStopTriggers };
}

function computeSymbolStats(trades: TradeRecord[]): SymbolStats[] {
  const bySymbol = new Map<string, { wins: number; losses: number; pnl: number; holdSum: number; feeSum: number; count: number }>();
  for (const t of trades) {
    const sym = t.symbol;
    const row = bySymbol.get(sym) ?? { wins: 0, losses: 0, pnl: 0, holdSum: 0, feeSum: 0, count: 0 };
    row.count += 1;
    row.holdSum += t.holdMinutes;
    row.feeSum += t.fee;
    row.pnl += t.realizedPnl;
    if (t.realizedPnl > 0) row.wins++;
    else if (t.realizedPnl < 0) row.losses++;
    bySymbol.set(sym, row);
  }
  return Array.from(bySymbol.entries()).map(([symbol, r]) => ({
    symbol,
    tradeCount: r.count,
    winCount: r.wins,
    lossCount: r.losses,
    winRate: r.count ? (r.wins / r.count) * 100 : 0,
    netPnl: round2(r.pnl),
    avgHoldMinutes: round2(r.count ? r.holdSum / r.count : 0),
    totalFees: round2(r.feeSum),
  })).sort((a, b) => b.netPnl - a.netPnl);
}

function computeHoldTimeAnalysis(trades: TradeRecord[]): HoldTimeAnalysis {
  const wins = trades.filter((t) => t.realizedPnl > 0);
  const losses = trades.filter((t) => t.realizedPnl < 0);
  const avgWinHold = wins.length ? wins.reduce((a, t) => a + t.holdMinutes, 0) / wins.length : 0;
  const avgLossHold = losses.length ? losses.reduce((a, t) => a + t.holdMinutes, 0) / losses.length : 0;
  const diff = avgWinHold - avgLossHold;
  let impl = "OK";
  if (diff > 30) impl = "WARNING: Holding winners too long (avg +30m more than losers)";
  else if (diff < -30) impl = "WARNING: Cutting winners too early vs losers";
  else if (diff > 10) impl = "Monitor: Slightly longer on winners";
  return { avgWinHold, avgLossHold, holdDifference: round2(diff), implication: impl };
}

function computePeriodComparison(trades: TradeRecord[], rangeMs: number): PeriodComparison | null {
  if (rangeMs === Infinity || trades.length < 10) return null;
  const now = Date.now();
  const mid = now - rangeMs / 2;
  const current = trades.filter((t) => t.closeTime >= mid);
  const prior = trades.filter((t) => t.closeTime < mid && t.closeTime >= now - rangeMs);
  if (current.length < 3 || prior.length < 3) return null;
  
  const curPnL = current.reduce((a, t) => a + t.realizedPnl, 0);
  const priPnL = prior.reduce((a, t) => a + t.realizedPnl, 0);
  const curWin = current.filter((t) => t.realizedPnl > 0).length / current.length * 100;
  const priWin = prior.filter((t) => t.realizedPnl > 0).length / prior.length * 100;
  
  const change = priPnL ? ((curPnL - priPnL) / Math.abs(priPnL)) * 100 : 0;
  return {
    currentPeriod: { trades: current.length, netPnl: round2(curPnL), winRate: round2(curWin) },
    priorPeriod: { trades: prior.length, netPnl: round2(priPnL), winRate: round2(priWin) },
    changePercent: round2(change),
    trend: change > 15 ? "improving" : change < -15 ? "degrading" : "stable",
  };
}

export async function getJournalPayload(rangeKey: JournalRangeKey = "all"): Promise<JournalPayload & { symbolStats: SymbolStats[]; periodComparison: PeriodComparison | null; holdTimeAnalysis: HoldTimeAnalysis }> {
  const { trades: rawTrades, warnings } = await fetchMexcHistoryTrades();

  const cleaned = rawTrades
    .map((t) => ({
      ...t,
      openTime: clampTs(t.openTime),
      closeTime: clampTs(t.closeTime),
      holdMinutes: Math.max(0, t.holdMinutes),
    }))
    .filter((t) => t.closeTime >= t.openTime)
    .filter((t) => Number.isFinite(t.realizedPnl))
    .filter((t) => t.quantity === null || t.quantity > 0)
    .sort((a, b) => a.openTime - b.openTime);

  const now = Date.now();
  const cutoff = rangeKey === "all" ? 0 : now - RANGE_MS[rangeKey];
  const filtered = cutoff > 0 ? cleaned.filter((t) => t.closeTime >= cutoff) : cleaned;

  const cleanedRecords: TradeRecord[] = filtered.map((t) => ({
    ...t,
    fee: round2(t.fee),
    realizedPnl: round2(t.realizedPnl),
    holdMinutes: round2(t.holdMinutes),
    leakFlags: [],
  }));

  const { trades, dailyLossStopTriggers, consecutiveLossStopTriggers } = addLeakFlags(cleanedRecords);

  const wins = trades.filter((t) => t.realizedPnl > 0);
  const losses = trades.filter((t) => t.realizedPnl < 0);
  const grossProfit = wins.reduce((acc, t) => acc + t.realizedPnl, 0);
  const grossLossAbs = Math.abs(losses.reduce((acc, t) => acc + t.realizedPnl, 0));
  const netPnl = trades.reduce((acc, t) => acc + t.realizedPnl, 0);

  const leakKeys = Object.keys(LEAK_LABELS) as LeakFlag[];
  const leakBuckets = leakKeys.map((key) => {
    const impacted = trades.filter((t) => t.leakFlags.includes(key));
    return {
      key,
      label: LEAK_LABELS[key],
      tradeCount: impacted.length,
      grossPnl: round2(impacted.reduce((acc, t) => acc + t.realizedPnl, 0)),
    };
  });

  const tradesWithoutLeaksPnl = round2(
    trades.filter((t) => !t.leakFlags.length).reduce((acc, t) => acc + t.realizedPnl, 0),
  );

  const symbolStats = computeSymbolStats(trades);
  const holdTimeAnalysis = computeHoldTimeAnalysis(trades);
  const periodComparison = rangeKey !== "all" ? computePeriodComparison(trades, RANGE_MS[rangeKey]) : null;

  return {
    overview: {
      asOf: Date.now(),
      timezone: "UTC",
      baseCurrency: "USDT",
      rangeKey,
      tradeCount: trades.length,
      winRate: round2(ratio(wins.length, trades.length) * 100),
      profitFactor: round2(grossLossAbs ? grossProfit / grossLossAbs : grossProfit > 0 ? 999 : 0),
      expectancy: round2(ratio(netPnl, trades.length)),
      netPnl: round2(netPnl),
      avgWin: round2(ratio(grossProfit, wins.length)),
      avgLoss: round2(ratio(losses.reduce((acc, t) => acc + t.realizedPnl, 0), losses.length)),
      leakBuckets,
      tradesWithoutLeaksPnl,
      dailyLossStopTriggers,
      consecutiveLossStopTriggers,
      warnings,
    },
    trades: trades.sort((a, b) => b.closeTime - b.closeTime),
    symbolStats,
    holdTimeAnalysis,
    periodComparison,
  };
}
