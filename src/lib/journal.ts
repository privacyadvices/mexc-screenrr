export interface TradeRecord {
  id: string;
  symbol: string;
  side: "long" | "short" | "unknown";
  openTime: number;
  closeTime: number;
  holdMinutes: number;
  quantity: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  fee: number;
  realizedPnl: number;
  leakFlags: LeakFlag[];
}

export interface LeakBucket {
  key: LeakFlag;
  label: string;
  tradeCount: number;
  grossPnl: number;
}

export interface JournalOverview {
  asOf: number;
  timezone: string;
  baseCurrency: string;
  rangeKey: JournalRangeKey;
  tradeCount: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  netPnl: number;
  avgWin: number;
  avgLoss: number;
  leakBuckets: LeakBucket[];
  tradesWithoutLeaksPnl: number;
  dailyLossStopTriggers: number;
  consecutiveLossStopTriggers: number;
  warnings: string[];
}

export type JournalRangeKey = "24h" | "7d" | "30d" | "60d" | "90d" | "1y" | "all";

export interface JournalPayload {
  overview: JournalOverview;
  trades: TradeRecord[];
}

export interface JournalAiInsights {
  title: string;
  confidence: "low" | "medium" | "high";
  whatWeFound: {
    statement: string;
    pValueText: string;
    significant: boolean;
    effectSizeText: string;
  };
  whyItMatters: string;
  psychology: {
    biasName: string;
    explanation: string;
    reference: string;
  };
  whatToDo: {
    primaryAction: {
      title: string;
      description: string;
      cta: string;
    };
    secondaryAction: {
      title: string;
      description: string;
      cta: string;
    };
  };
  basis: {
    tradesAnalyzed: number;
    minimumRequired: number;
  };
}

export interface TradeChartPoint {
  timestamp: number;
  close: number;
}

export interface TradeChartPayload {
  symbol: string;
  interval: "Min5";
  points: TradeChartPoint[];
  entry: { timestamp: number; price: number | null };
  exit: { timestamp: number; price: number | null };
  windowStart: number;
  windowEnd: number;
}

export type LeakFlag =
  | "POST_LOSS_CHASE"
  | "OVERTRADING_CLUSTER"
  | "HIGH_FREQUENCY_SESSION"
  | "REVENGE_STREAK"
  | "NO_SETUP_PROXY";

export const LEAK_LABELS: Record<LeakFlag, string> = {
  POST_LOSS_CHASE: "Post-loss chase",
  OVERTRADING_CLUSTER: "Overtrading cluster",
  HIGH_FREQUENCY_SESSION: "High-frequency session",
  REVENGE_STREAK: "Revenge streak",
  NO_SETUP_PROXY: "No-setup proxy",
};

export interface SymbolStats {
  symbol: string;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  netPnl: number;
  avgHoldMinutes: number;
  totalFees: number;
}

export interface PeriodComparison {
  currentPeriod: { trades: number; netPnl: number; winRate: number };
  priorPeriod: { trades: number; netPnl: number; winRate: number };
  changePercent: number;
  trend: "improving" | "degrading" | "stable";
}

export interface HoldTimeAnalysis {
  avgWinHold: number;
  avgLossHold: number;
  holdDifference: number;
  implication: string;
}
