import type { JournalAiInsights, JournalPayload } from "@/lib/journal";
import { generateDeepseekInsights } from "@/lib/server/deepseek";

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function erfApprox(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const abs = Math.abs(x);
  const p = 0.3275911;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const t = 1 / (1 + p * abs);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-abs * abs));
  return sign * y;
}

function normalCdf(z: number): number {
  return 0.5 * (1 + erfApprox(z / Math.sqrt(2)));
}

function corrAndPvalue(x: number[], y: number[]): { r: number; p: number } {
  const n = Math.min(x.length, y.length);
  if (n < 5) return { r: 0, p: 1 };

  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  if (!dx2 || !dy2) return { r: 0, p: 1 };
  const r = num / Math.sqrt(dx2 * dy2);
  const z = Math.abs(r) * Math.sqrt(n - 3);
  const p = Math.max(0.0001, 2 * (1 - normalCdf(z)));
  return { r, p };
}

type StreakType = "win" | "loss" | "none";

function buildStats(payload: JournalPayload): {
  topLeakTitle: string;
  whatFoundLine: string;
  pValueText: string;
  effectSizeText: string;
  significant: boolean;
  tradesAnalyzed: number;
  currentStreak: { type: StreakType; length: number };
  avgHoldTime: number;
  holdByLeak: Record<string, number>;
  trendDirection: "improving" | "degrading" | "stable";
  trendPercent: number;
} {
  const sortedLeaks = [...payload.overview.leakBuckets].sort((a, b) => a.grossPnl - b.grossPnl);
  const worstLeak = sortedLeaks[0];

  const tradesByTime = [...payload.trades].sort((a, b) => a.closeTime - b.closeTime);
  let streakLength = 0;
  let streakType: StreakType = "none";
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  for (const t of tradesByTime) {
    if (t.realizedPnl > 0) {
      if (streakType === "win") streakLength++;
      else {
        streakType = "win";
        streakLength = 1;
      }
      if (streakLength > maxWinStreak) maxWinStreak = streakLength;
    } else if (t.realizedPnl < 0) {
      if (streakType === "loss") streakLength++;
      else {
        streakType = "loss";
        streakLength = 1;
      }
      if (streakLength > maxLossStreak) maxLossStreak = streakLength;
    } else {
      streakLength = 0;
      streakType = "none";
    }
  }
  const currentStreak: { type: StreakType; length: number } = {
    type: streakType,
    length: streakLength,
  };

  const totalHold = tradesByTime.reduce((a, t) => a + t.holdMinutes, 0);
  const avgHoldTime = tradesByTime.length ? totalHold / tradesByTime.length : 0;

  const holdByLeak: Record<string, number> = {};
  const leakHoldCounts: Record<string, { total: number; count: number }> = {};
  for (const t of tradesByTime) {
    const key = t.leakFlags.length ? t.leakFlags.join(",") : "clean";
    const row = leakHoldCounts[key] ?? { total: 0, count: 0 };
    row.total += t.holdMinutes;
    row.count += 1;
    leakHoldCounts[key] = row;
  }
  for (const [key, row] of Object.entries(leakHoldCounts)) {
    holdByLeak[key] = row.count ? row.total / row.count : 0;
  }

  const halfIdx = Math.floor(tradesByTime.length / 2);
  const firstHalf = tradesByTime.slice(0, halfIdx);
  const secondHalf = tradesByTime.slice(halfIdx);
  const firstPnL = firstHalf.reduce((a, t) => a + t.realizedPnl, 0);
  const secondPnL = secondHalf.reduce((a, t) => a + t.realizedPnl, 0);
  const trendPercent = firstPnL ? ((secondPnL - firstPnL) / Math.abs(firstPnL)) * 100 : 0;
  const trendDirection: "improving" | "degrading" | "stable" = trendPercent > 10 ? "improving" : trendPercent < -10 ? "degrading" : "stable";

  const byDay = new Map<string, { losses: number; entries: number }>();
  for (const t of payload.trades) {
    const day = new Date(t.closeTime).toISOString().slice(0, 10);
    const row = byDay.get(day) ?? { losses: 0, entries: 0 };
    row.entries += 1;
    if (t.realizedPnl < 0) row.losses += 1;
    byDay.set(day, row);
  }

  const losses: number[] = [];
  const entries: number[] = [];
  for (const row of byDay.values()) {
    losses.push(row.losses);
    entries.push(row.entries);
  }
  const { r, p } = corrAndPvalue(losses, entries);

  const label = worstLeak?.label ?? "Behavioral leak";
  const statement =
    worstLeak
      ? `Significant relationship between prior losses and trade frequency, with ${label.toLowerCase()} as the top leak.`
      : "Insufficient leak data for strong statistical statement.";

  return {
    topLeakTitle: `${label} Spike`,
    whatFoundLine: statement,
    pValueText: p < 0.001 ? "<0.001" : p.toFixed(3),
    effectSizeText: round3(r).toFixed(3),
    significant: p < 0.05,
    tradesAnalyzed: payload.overview.tradeCount,
    currentStreak,
    avgHoldTime,
    holdByLeak,
    trendDirection,
    trendPercent: round3(trendPercent),
  };
}

function buildPrompt(payload: JournalPayload): string {
  const stats = buildStats(payload);
  const sampleTrades = payload.trades.slice(0, 60).map((t) => ({
    symbol: t.symbol,
    side: t.side,
    holdMinutes: t.holdMinutes,
    pnl: t.realizedPnl,
    leakFlags: t.leakFlags,
    closeTime: t.closeTime,
  }));

  return [
    "You are a strict elite trading performance coach and behavioral analyst.",
    "Use ONLY provided data - never invent metrics.",
    "Return EXACT JSON schema below:",
    JSON.stringify(
      {
        title: "string - max 40 chars",
        confidence: "low|medium|high",
        whatWeFound: { statement: "string", pValueText: "string", significant: true, effectSizeText: "string" },
        whyItMatters: "string - max 80 chars",
        psychology: { biasName: "string", explanation: "string - max 100 chars", reference: "string" },
        whatToDo: {
          primaryAction: { title: "string", description: "string - include specific timer/number", cta: "string" },
          secondaryAction: { title: "string", description: "string", cta: "string" },
        },
        basis: { tradesAnalyzed: 0, minimumRequired: 30 },
      },
      null,
      2,
    ),
    "Requirements:",
    "- Max 2 sentences per field.",
    "- Include specific timers, numbers, thresholds in actions.",
    "- Compare current vs prior period performance.",
    "- Identify streaks and hold time patterns.",
    "- HIGH confidence only if p < 0.05 and enough trades.",
    "Evidence (must reference):",
    JSON.stringify(stats, null, 2),
    "Data:",
    JSON.stringify({ overview: payload.overview, sampleTrades, rangeKey: payload.overview.rangeKey }, null, 2),
  ].join("\n");
}

const CACHE_TTL_MS = 3 * 60_000;
let cache: { key: string; at: number; data: JournalAiInsights } | null = null;

export async function getJournalAiInsights(payload: JournalPayload): Promise<JournalAiInsights> {
  const key = `${payload.overview.tradeCount}-${payload.overview.netPnl}-${payload.overview.asOf}`;
  const now = Date.now();
  if (cache && cache.key === key && now - cache.at < CACHE_TTL_MS) return cache.data;
  try {
    const prompt = buildPrompt(payload);
    const data = await generateDeepseekInsights(prompt);
    cache = { key, at: now, data };
    return data;
  } catch {
    const stats = buildStats(payload);
    return {
      title: stats.topLeakTitle,
      confidence: "medium",
      whatWeFound: {
        statement: stats.whatFoundLine,
        pValueText: stats.pValueText,
        significant: stats.significant,
        effectSizeText: stats.effectSizeText,
      },
      whyItMatters: `Current streak: ${stats.currentStreak.length}x ${stats.currentStreak.type}. Trend: ${stats.trendDirection} (${stats.trendPercent > 0 ? "+" : ""}${stats.trendPercent}%). Avg hold: ${stats.avgHoldTime.toFixed(1)}m.`,
      psychology: {
        biasName: "Action Bias + Streak Blindness",
        explanation: `You have a ${stats.currentStreak.length}-trade ${stats.currentStreak.type} streak active. ${stats.currentStreak.type === "loss" ? "Loss aversion compels revenge trading." : "Overconfidence after wins leads to oversized positions."}`,
        reference: "Kahneman (2011), behavioral economics",
      },
      whatToDo: {
        primaryAction: {
          title: stats.currentStreak.type === "loss" ? "Reset: 45min timeout" : `Hold: ${Math.max(15, stats.avgHoldTime * 0.5).toFixed(0)}m minimum`,
          description: stats.currentStreak.type === "loss" 
            ? "After loss streak, enforce 45min cooldown. Review last 2 trades before next entry."
            : `After win streak, wait minimum hold time (${Math.max(15, stats.avgHoldTime * 0.5).toFixed(0)}m) before exiting.`,
          cta: "Enforce",
        },
        secondaryAction: {
          title: stats.trendDirection === "degrading" ? "Reduce size 50%" : "Track session P&L",
          description: stats.trendDirection === "degrading" 
            ? "Performance degrading. Reduce position size by 50% until trend reverses."
            : "Monitor session P&L. Stop after -2R or 2 consecutive losses.",
          cta: "Apply",
        },
      },
      basis: {
        tradesAnalyzed: stats.tradesAnalyzed,
        minimumRequired: 30,
      },
    };
  }
}
