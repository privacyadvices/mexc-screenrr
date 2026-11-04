"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { PerpChart } from "@/components/PerpChart";
import {
  EXCHANGE_LABEL,
  exchangePath,
  exchangeSpaghettiPath,
  normalizeInputToExchangeSymbol,
  toDisplaySymbol,
  toExchangeTradeUrl,
  toTradingViewChartUrl,
  toTradingViewSymbol,
  type ExchangeId,
} from "@/lib/exchange";
import {
  loadWatchlistFromStorage,
  saveWatchlistToStorage,
  toWatchKey,
} from "@/lib/watchlist";
import {
  BTC_CORR_TIMEFRAMES,
  TIMEFRAMES,
  formatFilterFieldLabel,
  formatFilterRuleSummary,
  formatFilterThreshold,
  formatFunding,
  formatFundingPerHour,
  formatNumber,
  formatPercent,
  formatPrice,
  parseFilterInput,
  type BtcCorrTimeframe,
  type CompareOp,
  type ScreenerResponse,
  type Timeframe,
} from "@/lib/screener";
import {
  ExchangeBadgeIcon,
  OrionAlertsDrawer,
  OrionColumnVisibilityDrawer,
  OrionFilterModal,
  Sparkline24h,
  TokenAvatar,
  playAlertSound,
  renderGroupedFieldOptions,
  type AlertConditionRule,
  type TriggeredAlertEvent,
} from "@/components/OrionModals";

type GroupKey =
  | "changePct"
  | "changeUsd"
  | "volume"
  | "trades"
  | "volatility"
  | "oiChangePct"
  | "oiChangeUsd"
  | "cvd"
  | "volChangePct"
  | "volChangeUsd"
  | "btcCorr";

type CoreKey =
  | "symbol"
  | "price"
  | "oiUsd"
  | "fundingRate1h"
  | "funding"
  | "rvol"
  | "mcap"
  | "rangePos24h"
  | "basisPct"
  | "ticks5m"
  | "oiToMcapPct"
  | "volToOi"
  | "change7dPct"
  | "change30dPct";

type Row = ScreenerResponse["rows"][number];
type ScreenerPayload = ScreenerResponse & { warning?: string; cached?: boolean };

type MetricColumn =
  | { key: CoreKey; type: "core"; label: string; shortTip?: string; orionCore?: boolean }
  | { key: `${GroupKey}:${string}`; type: "metric"; label: string; group: GroupKey; timeframe: string };

type PresetId =
  | "highVolume"
  | "oiSpike"
  | "bigMovers"
  | "highFunding"
  | "pumpAlert"
  | "shortSqueeze"
  | "zeroFee"
  | "newHot";

type DockMode = "dropdown" | "right" | "top" | "hidden";
type ColumnPresetId = "orionDefault" | "scalper" | "orderflow" | "momentum" | "coreOnly" | "all";

type NumericField =
  | "price"
  | "oiUsd"
  | "fundingRate1h"
  | "funding"
  | "basisPct"
  | "rangePos24h"
  | "oiToMcapPct"
  | "volToOi"
  | "ticks5m"
  | "rvol"
  | "mcap"
  | "change7dPct"
  | "change30dPct"
  | `${GroupKey}:${string}`;

interface ManualFilter {
  id: string;
  field: NumericField;
  op: CompareOp;
  value: number;
  value2?: number;
}

interface SavedFilterPreset {
  id: string;
  name: string;
  filters: ManualFilter[];
}

interface LiveTickPatch {
  price: number;
  amount24?: number;
  change24hPct?: number;
  basisPct?: number | null;
  rangePos24h?: number | null;
  high24Price?: number;
  low24Price?: number;
  updatedAt: number;
}

const SETTINGS_STORAGE_KEY = "mexc-screener-workspace-v4";
const SAVED_PRESETS_STORAGE_KEY = "mexc-screener-saved-filter-presets-v1";
const ALERT_RULES_STORAGE_KEY = "mexc-screener-alert-rules-v1";

const CORE_COLUMNS: { key: CoreKey; type: "core"; label: string; shortTip?: string; orionCore?: boolean }[] = [
  { key: "symbol", type: "core", label: "Symbol", orionCore: true },
  { key: "price", type: "core", label: "Price", shortTip: "Current price in USD", orionCore: true },
  { key: "oiUsd", type: "core", label: "OI $", shortTip: "Total value of open positions in USD", orionCore: true },
  {
    key: "fundingRate1h",
    type: "core",
    label: "Funding/h",
    shortTip: "Funding rate normalized per hour (Orion standard)",
    orionCore: true,
  },
  {
    key: "rvol",
    type: "core",
    label: "RVOL",
    shortTip: "5m volume ÷ average 5m volume over the past 24h",
    orionCore: true,
  },
  { key: "mcap", type: "core", label: "MCAP", shortTip: "Market Capitalization in USD", orionCore: true },
  { key: "funding", type: "core", label: "Funding/period", shortTip: "Per-cycle perpetual funding rate" },
  { key: "rangePos24h", type: "core", label: "24h Range", shortTip: "Position within 24h Low–High" },
  { key: "basisPct", type: "core", label: "Basis %", shortTip: "Futures vs Spot Index premium/discount" },
  { key: "ticks5m", type: "core", label: "5m Ticks", shortTip: "Estimated/actual 5m trade count" },
  { key: "oiToMcapPct", type: "core", label: "OI/MCAP", shortTip: "Open Interest as % of Market Cap" },
  { key: "volToOi", type: "core", label: "Vol/OI", shortTip: "24h Volume to Open Interest turnover ratio" },
  { key: "change7dPct", type: "core", label: "7d %", shortTip: "7-day return (MEXC native)" },
  { key: "change30dPct", type: "core", label: "30d %", shortTip: "30-day return (MEXC native)" },
];

// Exact 11 groups and order from Orion Terminal Column Visibility (Screenshot 3)
const GROUPS: { key: GroupKey; label: string; menuLabel: string; timeframes: readonly string[] }[] = [
  { key: "changePct", label: "CHG %", menuLabel: "CHANGE %", timeframes: TIMEFRAMES },
  { key: "changeUsd", label: "CHG $", menuLabel: "CHANGE $", timeframes: TIMEFRAMES },
  { key: "volume", label: "VOL $", menuLabel: "VOLUME $", timeframes: TIMEFRAMES },
  { key: "trades", label: "TRADES", menuLabel: "TRADES", timeframes: TIMEFRAMES },
  { key: "volatility", label: "VLT", menuLabel: "VOLATILITY", timeframes: TIMEFRAMES },
  { key: "oiChangePct", label: "OI CHG %", menuLabel: "OI CHANGE %", timeframes: TIMEFRAMES },
  { key: "oiChangeUsd", label: "OI CHG $", menuLabel: "OI CHANGE $", timeframes: TIMEFRAMES },
  { key: "cvd", label: "VOL Δ", menuLabel: "VOLUME Δ", timeframes: TIMEFRAMES },
  { key: "volChangePct", label: "VOL CHG %", menuLabel: "VOL CHANGE %", timeframes: TIMEFRAMES },
  { key: "volChangeUsd", label: "VOL CHG $", menuLabel: "VOL CHANGE $", timeframes: TIMEFRAMES },
  { key: "btcCorr", label: "BTC CORR", menuLabel: "BTC CORR", timeframes: BTC_CORR_TIMEFRAMES },
];

const COLUMN_PRESETS: Record<Exclude<ColumnPresetId, "all">, string[]> = {
  orionDefault: [
    "symbol",
    "price",
    "oiUsd",
    "fundingRate1h",
    "rvol",
    "mcap",
    "changePct:5m",
    "changePct:15m",
    "changePct:1h",
    "changePct:4h",
    "changePct:8h",
    "changePct:1d",
    "volume:15m",
    "volume:1h",
    "volume:4h",
    "volume:8h",
    "volume:1d",
    "trades:15m",
    "volatility:15m",
    "oiChangePct:15m",
    "oiChangePct:1h",
    "oiChangePct:4h",
    "oiChangePct:8h",
    "oiChangePct:1d",
  ],
  scalper: [
    "symbol",
    "price",
    "rangePos24h",
    "oiUsd",
    "fundingRate1h",
    "rvol",
    "changePct:5m",
    "changePct:15m",
    "changePct:1h",
    "changePct:1d",
    "volume:5m",
    "volume:15m",
    "volume:1h",
    "volume:1d",
    "cvd:5m",
    "cvd:15m",
    "oiChangePct:5m",
    "oiChangePct:15m",
    "oiChangePct:1h",
    "volatility:5m",
    "volatility:15m",
    "trades:15m",
  ],
  orderflow: [
    "symbol",
    "price",
    "oiUsd",
    "oiToMcapPct",
    "volToOi",
    "fundingRate1h",
    "basisPct",
    "rvol",
    "oiChangePct:5m",
    "oiChangePct:15m",
    "oiChangePct:1h",
    "cvd:5m",
    "cvd:15m",
    "cvd:1h",
    "volChangePct:5m",
    "volChangePct:15m",
    "volChangePct:1h",
  ],
  momentum: [
    "symbol",
    "price",
    "rangePos24h",
    "rvol",
    "oiUsd",
    "mcap",
    "changePct:5m",
    "changePct:15m",
    "changePct:1h",
    "changePct:4h",
    "changePct:1d",
    "change7dPct",
    "change30dPct",
    "volume:1d",
  ],
  coreOnly: ["symbol", "price", "oiUsd", "fundingRate1h", "rvol", "mcap"],
};

const DEFAULT_VISIBLE = new Set<string>(COLUMN_PRESETS.orionDefault);

const DEFAULT_ALERT_RULES: AlertConditionRule[] = [
  {
    id: "default-5m-pump",
    name: "5m Fast Move (|CHG % 5m| > 2.2%)",
    field: "changePct:5m",
    fieldLabel: "CHG % (5m)",
    op: "abs_gt",
    value: 2.2,
    sound: "chime",
    cooldownMs: 300_000,
    enabled: true,
  },
  {
    id: "default-15m-oi",
    name: "15m OI Surge (OI CHG % 15m > 3.5%)",
    field: "oiChangePct:15m",
    fieldLabel: "OI CHG % (15m)",
    op: "gt",
    value: 3.5,
    sound: "bell",
    cooldownMs: 300_000,
    enabled: true,
  },
  {
    id: "default-rvol",
    name: "Unusual Volume Surge (RVOL > 3.5x)",
    field: "rvol",
    fieldLabel: "RVOL",
    op: "gt",
    value: 3.5,
    sound: "ding",
    cooldownMs: 600_000,
    enabled: true,
  },
];

const PRESET_DEFAULTS = {
  highVolume: 2, // Orion Terminal standard: RVOL > 2.0x
  oiSpike: 2.5,
  bigMovers: 3,
  highFunding: 0.03,
};

const FILTER_FIELD_OPTIONS: { value: NumericField; label: string; group: string }[] = [
  // Volume $ & Core Size Metrics
  { value: "volume:1d", label: "Volume $ (1d)", group: "Volume & Size ($)" },
  { value: "volume:1h", label: "Volume $ (1h)", group: "Volume & Size ($)" },
  { value: "volume:4h", label: "Volume $ (4h)", group: "Volume & Size ($)" },
  { value: "volume:8h", label: "Volume $ (8h)", group: "Volume & Size ($)" },
  { value: "volume:12h", label: "Volume $ (12h)", group: "Volume & Size ($)" },
  { value: "volume:15m", label: "Volume $ (15m)", group: "Volume & Size ($)" },
  { value: "volume:5m", label: "Volume $ (5m)", group: "Volume & Size ($)" },
  { value: "mcap", label: "MCAP $", group: "Volume & Size ($)" },
  { value: "oiUsd", label: "OI $", group: "Volume & Size ($)" },
  { value: "price", label: "Price $", group: "Volume & Size ($)" },
  { value: "rvol", label: "RVOL (5m vs 24h)", group: "Volume & Size ($)" },
  // Trades / Ticks
  { value: "trades:5m", label: "Trades (5m)", group: "Trades & Activity" },
  { value: "trades:15m", label: "Trades (15m)", group: "Trades & Activity" },
  { value: "trades:1h", label: "Trades (1h)", group: "Trades & Activity" },
  { value: "trades:4h", label: "Trades (4h)", group: "Trades & Activity" },
  { value: "trades:8h", label: "Trades (8h)", group: "Trades & Activity" },
  { value: "trades:12h", label: "Trades (12h)", group: "Trades & Activity" },
  { value: "trades:1d", label: "Trades (1d)", group: "Trades & Activity" },
  { value: "ticks5m", label: "5m Ticks", group: "Trades & Activity" },
  // Price Change %
  { value: "changePct:5m", label: "CHG % (5m)", group: "Price Change (%)" },
  { value: "changePct:15m", label: "CHG % (15m)", group: "Price Change (%)" },
  { value: "changePct:1h", label: "CHG % (1h)", group: "Price Change (%)" },
  { value: "changePct:4h", label: "CHG % (4h)", group: "Price Change (%)" },
  { value: "changePct:8h", label: "CHG % (8h)", group: "Price Change (%)" },
  { value: "changePct:12h", label: "CHG % (12h)", group: "Price Change (%)" },
  { value: "changePct:1d", label: "CHG % (1d)", group: "Price Change (%)" },
  { value: "change7dPct", label: "CHG % (7d)", group: "Price Change (%)" },
  { value: "change30dPct", label: "CHG % (30d)", group: "Price Change (%)" },
  // Price Change $
  { value: "changeUsd:5m", label: "CHG $ (5m)", group: "Price Change ($)" },
  { value: "changeUsd:15m", label: "CHG $ (15m)", group: "Price Change ($)" },
  { value: "changeUsd:1h", label: "CHG $ (1h)", group: "Price Change ($)" },
  { value: "changeUsd:4h", label: "CHG $ (4h)", group: "Price Change ($)" },
  { value: "changeUsd:8h", label: "CHG $ (8h)", group: "Price Change ($)" },
  { value: "changeUsd:12h", label: "CHG $ (12h)", group: "Price Change ($)" },
  { value: "changeUsd:1d", label: "CHG $ (1d)", group: "Price Change ($)" },
  // Open Interest Change
  { value: "oiChangePct:5m", label: "OI CHG % (5m)", group: "Open Interest Change (% & $)" },
  { value: "oiChangePct:15m", label: "OI CHG % (15m)", group: "Open Interest Change (% & $)" },
  { value: "oiChangePct:1h", label: "OI CHG % (1h)", group: "Open Interest Change (% & $)" },
  { value: "oiChangePct:4h", label: "OI CHG % (4h)", group: "Open Interest Change (% & $)" },
  { value: "oiChangePct:8h", label: "OI CHG % (8h)", group: "Open Interest Change (% & $)" },
  { value: "oiChangePct:12h", label: "OI CHG % (12h)", group: "Open Interest Change (% & $)" },
  { value: "oiChangePct:1d", label: "OI CHG % (1d)", group: "Open Interest Change (% & $)" },
  { value: "oiChangeUsd:5m", label: "OI CHG $ (5m)", group: "Open Interest Change (% & $)" },
  { value: "oiChangeUsd:15m", label: "OI CHG $ (15m)", group: "Open Interest Change (% & $)" },
  { value: "oiChangeUsd:1h", label: "OI CHG $ (1h)", group: "Open Interest Change (% & $)" },
  { value: "oiChangeUsd:4h", label: "OI CHG $ (4h)", group: "Open Interest Change (% & $)" },
  { value: "oiChangeUsd:8h", label: "OI CHG $ (8h)", group: "Open Interest Change (% & $)" },
  { value: "oiChangeUsd:12h", label: "OI CHG $ (12h)", group: "Open Interest Change (% & $)" },
  { value: "oiChangeUsd:1d", label: "OI CHG $ (1d)", group: "Open Interest Change (% & $)" },
  // VDelta / CVD $
  { value: "cvd:5m", label: "Volume Δ $ (5m)", group: "Volume Delta / CVD ($)" },
  { value: "cvd:15m", label: "Volume Δ $ (15m)", group: "Volume Delta / CVD ($)" },
  { value: "cvd:1h", label: "Volume Δ $ (1h)", group: "Volume Delta / CVD ($)" },
  { value: "cvd:4h", label: "Volume Δ $ (4h)", group: "Volume Delta / CVD ($)" },
  { value: "cvd:8h", label: "Volume Δ $ (8h)", group: "Volume Delta / CVD ($)" },
  { value: "cvd:12h", label: "Volume Δ $ (12h)", group: "Volume Delta / CVD ($)" },
  { value: "cvd:1d", label: "Volume Δ $ (1d)", group: "Volume Delta / CVD ($)" },
  // Volume Change % & $
  { value: "volChangePct:5m", label: "VOL CHG % (5m)", group: "Volume Change (% & $)" },
  { value: "volChangePct:15m", label: "VOL CHG % (15m)", group: "Volume Change (% & $)" },
  { value: "volChangePct:1h", label: "VOL CHG % (1h)", group: "Volume Change (% & $)" },
  { value: "volChangePct:4h", label: "VOL CHG % (4h)", group: "Volume Change (% & $)" },
  { value: "volChangePct:8h", label: "VOL CHG % (8h)", group: "Volume Change (% & $)" },
  { value: "volChangePct:12h", label: "VOL CHG % (12h)", group: "Volume Change (% & $)" },
  { value: "volChangePct:1d", label: "VOL CHG % (1d)", group: "Volume Change (% & $)" },
  { value: "volChangeUsd:5m", label: "VOL CHG $ (5m)", group: "Volume Change (% & $)" },
  { value: "volChangeUsd:15m", label: "VOL CHG $ (15m)", group: "Volume Change (% & $)" },
  { value: "volChangeUsd:1h", label: "VOL CHG $ (1h)", group: "Volume Change (% & $)" },
  { value: "volChangeUsd:4h", label: "VOL CHG $ (4h)", group: "Volume Change (% & $)" },
  { value: "volChangeUsd:8h", label: "VOL CHG $ (8h)", group: "Volume Change (% & $)" },
  { value: "volChangeUsd:12h", label: "VOL CHG $ (12h)", group: "Volume Change (% & $)" },
  { value: "volChangeUsd:1d", label: "VOL CHG $ (1d)", group: "Volume Change (% & $)" },
  // Volatility % (1m Return StdDev)
  { value: "volatility:5m", label: "Volatility (5m) / VLT %", group: "Volatility & BTC Correlation" },
  { value: "volatility:15m", label: "Volatility (15m) / VLT %", group: "Volatility & BTC Correlation" },
  { value: "volatility:1h", label: "Volatility (1h) / VLT %", group: "Volatility & BTC Correlation" },
  { value: "volatility:4h", label: "Volatility (4h) / VLT %", group: "Volatility & BTC Correlation" },
  { value: "volatility:8h", label: "Volatility (8h) / VLT %", group: "Volatility & BTC Correlation" },
  { value: "volatility:12h", label: "Volatility (12h) / VLT %", group: "Volatility & BTC Correlation" },
  { value: "volatility:1d", label: "Volatility (1d) / VLT %", group: "Volatility & BTC Correlation" },
  // BTC Correlation
  { value: "btcCorr:5m", label: "BTC CORR (5m)", group: "Volatility & BTC Correlation" },
  { value: "btcCorr:15m", label: "BTC CORR (15m)", group: "Volatility & BTC Correlation" },
  { value: "btcCorr:1h", label: "BTC CORR (1h)", group: "Volatility & BTC Correlation" },
  { value: "btcCorr:4h", label: "BTC CORR (4h)", group: "Volatility & BTC Correlation" },
  { value: "btcCorr:8h", label: "BTC CORR (8h)", group: "Volatility & BTC Correlation" },
  { value: "btcCorr:12h", label: "BTC CORR (12h)", group: "Volatility & BTC Correlation" },
  { value: "btcCorr:1d", label: "BTC CORR (1d)", group: "Volatility & BTC Correlation" },
  // Core Microstructure
  { value: "fundingRate1h", label: "Funding/h %", group: "Funding, Basis & Ratios" },
  { value: "funding", label: "Funding/period %", group: "Funding, Basis & Ratios" },
  { value: "basisPct", label: "Basis %", group: "Funding, Basis & Ratios" },
  { value: "rangePos24h", label: "24h Range %", group: "Funding, Basis & Ratios" },
  { value: "oiToMcapPct", label: "OI / MCAP %", group: "Funding, Basis & Ratios" },
  { value: "volToOi", label: "Vol / OI Ratio", group: "Funding, Basis & Ratios" },
];

const TV_INTERVALS = [
  { label: "1m", title: "1 Minute (1min)", value: "1" },
  { label: "5m", title: "5 Minutes (5min)", value: "5" },
  { label: "15m", title: "15 Minutes (15min)", value: "15" },
  { label: "1h", title: "1 Hour (1hr)", value: "60" },
  { label: "4h", title: "4 Hours (4hr)", value: "240" },
  { label: "1D", title: "1 Day (Day)", value: "D" },
] as const;

function buildAllMetricColumns(): MetricColumn[] {
  const out: MetricColumn[] = [];
  for (const group of GROUPS) {
    for (const tf of group.timeframes) {
      out.push({
        key: `${group.key}:${tf}`,
        type: "metric",
        label: `${group.label} (${tf.toUpperCase()})`,
        group: group.key,
        timeframe: tf,
      });
    }
  }
  return out;
}

const ALL_METRIC_COLUMNS = buildAllMetricColumns();

function getMetricValue(row: Row, group: GroupKey, timeframe: string): number | null {
  if (group === "btcCorr") return row.btcCorr[timeframe as BtcCorrTimeframe] ?? null;
  return row[group][timeframe as Timeframe] ?? null;
}

function colorForSigned(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "text-zinc-600";
  if (v > 0) return "text-[#3ee0a1]";
  if (v < 0) return "text-[#ff6b81]";
  return "text-zinc-400";
}

function renderMetricValue(group: GroupKey, value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  switch (group) {
    case "changePct":
    case "oiChangePct":
    case "volChangePct":
      return formatPercent(value);
    case "changeUsd":
    case "oiChangeUsd":
    case "volChangeUsd":
    case "cvd": {
      const sign = value > 0 ? "+" : "";
      return `${sign}$${formatNumber(value)}`;
    }
    case "volume":
      return `$${formatNumber(value)}`;
    case "trades":
      return formatNumber(value, 2).replace(/\.00$/, "");
    case "volatility":
      return value < 0.1 && value > 0 ? `${value.toFixed(3)}%` : `${value.toFixed(2)}%`;
    case "btcCorr":
      return value.toFixed(2);
    default:
      return "—";
  }
}

function readField(row: Row, field: NumericField): number | null {
  if (field.includes(":")) {
    const [group, timeframe] = field.split(":") as [GroupKey, string];
    return getMetricValue(row, group, timeframe);
  }
  switch (field) {
    case "price":
      return row.price;
    case "oiUsd":
      return row.oiUsd;
    case "fundingRate1h":
      return (row.fundingRate1h ?? row.funding / (row.fundingIntervalHours ?? 8)) * 100;
    case "funding":
      return row.funding * 100;
    case "basisPct":
      return row.basisPct ?? null;
    case "rangePos24h":
      return row.rangePos24h ?? null;
    case "oiToMcapPct":
      return row.oiToMcapPct ?? null;
    case "volToOi":
      return row.volToOi ?? null;
    case "ticks5m":
      return row.ticks5m;
    case "rvol":
      return row.rvol;
    case "mcap":
      return row.mcap;
    case "change7dPct":
      return row.change7dPct ?? null;
    case "change30dPct":
      return row.change30dPct ?? null;
    default:
      return null;
  }
}

function compare(value: number | null, op: CompareOp, target: number, target2?: number): boolean {
  if (value === null || Number.isNaN(value)) return false;
  if (op === ">") return value > target;
  if (op === ">=") return value >= target;
  if (op === "<") return value < target;
  if (op === "<=") return value <= target;
  if (op === "=") return Math.abs(value - target) < 1e-6;
  if (op === "abs_gt") return Math.abs(value) > target;
  if (op === "between") {
    const hi = target2 !== undefined && Number.isFinite(target2) ? Math.max(target, target2) : target;
    const lo = target2 !== undefined && Number.isFinite(target2) ? Math.min(target, target2) : target;
    return value >= lo && value <= hi;
  }
  return false;
}

function colWidth(key: string): string {
  if (key === "symbol") return "208px";
  if (key === "price") return "110px";
  if (key === "fundingRate1h" || key === "funding") return "112px";
  if (key === "rangePos24h") return "106px";
  if (key === "mcap" || key === "oiUsd") return "100px";
  if (key.startsWith("oiChangePct:")) return "116px";
  if (key.startsWith("changePct:")) return "104px";
  return "98px";
}

function cellStyle(key: string): { minWidth: string; width: string; flex: string } {
  const w = colWidth(key);
  return { minWidth: w, width: w, flex: key === "symbol" ? `0 0 ${w}` : "1 0 0" };
}

function headerAccentClass(key: string): string {
  if (key.startsWith("changePct:") || key.startsWith("changeUsd:") || key === "change7dPct" || key === "change30dPct") {
    return "border-t-2 border-t-cyan-500/60";
  }
  if (key === "oiUsd" || key.startsWith("oiChangePct:") || key.startsWith("oiChangeUsd:") || key === "oiToMcapPct") {
    return "border-t-2 border-t-violet-500/60";
  }
  if (key === "rvol" || key.startsWith("volume:") || key.startsWith("volChangePct:") || key.startsWith("volChangeUsd:") || key === "volToOi") {
    return "border-t-2 border-t-sky-500/60";
  }
  if (key.startsWith("cvd:")) {
    return "border-t-2 border-t-emerald-500/60";
  }
  if (key === "fundingRate1h" || key === "funding" || key === "basisPct") {
    return "border-t-2 border-t-amber-500/60";
  }
  return "border-t-2 border-t-transparent";
}

function heatBgForPct(val: number | null | undefined): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return "";
  if (val >= 8) return "bg-emerald-500/[0.22] font-bold text-emerald-100";
  if (val >= 3) return "bg-emerald-500/[0.13] font-semibold";
  if (val >= 1.5) return "bg-emerald-500/[0.06] font-medium";
  if (val <= -8) return "bg-rose-500/[0.22] font-bold text-rose-100";
  if (val <= -3) return "bg-rose-500/[0.13] font-semibold";
  if (val <= -1.5) return "bg-rose-500/[0.06] font-medium";
  return "";
}

/** % moves this small are noise — render them muted so real movers stand out when scanning */
function isNoisePct(val: number | null | undefined): boolean {
  return val !== null && val !== undefined && Number.isFinite(val) && Math.abs(val) < 0.05;
}

/** RVOL is a ratio around 1.0x — below average volume is not "bearish", so keep it neutral */
function rvolClass(rv: number | null | undefined): string {
  if (rv === null || rv === undefined || !Number.isFinite(rv)) return "text-zinc-600";
  if (rv >= 5) return "font-bold text-amber-200 bg-amber-500/[0.14]";
  if (rv >= 2.5) return "font-bold text-amber-300";
  if (rv >= 1.5) return "font-semibold text-sky-300";
  if (rv >= 1) return "text-zinc-200";
  return "text-zinc-500";
}

const US_STOCK_SECTORS = new Set(["usstocks", "stock", "stockindex", "etf", "preipo", "stockmeme", "techgiants"]);
const TRADFI_SECTORS = new Set([
  "tradfi",
  "usstocks",
  "stock",
  "stockindex",
  "etf",
  "preipo",
  "stockmeme",
  "jpstocks",
  "twstocks",
  "hkstocks",
  "commodities",
  "metalsfutures",
  "metals",
  "forex",
  "oil",
]);

function isUsStockRow(row: Row): boolean {
  if (row.symbol.includes("STOCK")) return true;
  const secs = row.sectors ?? [];
  if (secs.some((s) => US_STOCK_SECTORS.has(s))) return true;
  return /^(NVDA|NVIDIA|TSLA|TESLA|AAPL|MSFT|GOOGL|AMZN|META|COIN|MSTR|SPY|QQQ|NAS100|SPX500|US30|TQQQ|SOXL|SOXS|AMD|INTC|PLTR|HOOD)_?USDT$/i.test(
    row.symbol,
  );
}

function isTradFiRow(row: Row): boolean {
  if (isUsStockRow(row)) return true;
  const secs = row.sectors ?? [];
  return secs.some((s) => TRADFI_SECTORS.has(s));
}

function isKlineDependentSortKey(key: string): boolean {
  if (key === "rvol" || key === "ticks5m") return true;
  if (!key.includes(":")) return false;
  const [group, tf] = key.split(":");
  if (tf !== "1d") return true;
  return (
    group === "trades" ||
    group === "volatility" ||
    group === "cvd" ||
    group === "volChangePct" ||
    group === "volChangeUsd" ||
    group === "btcCorr"
  );
}

function getColumnsAddedByPreset(presetId: PresetId): string[] {
  if (presetId === "highVolume") {
    return ["rvol", "volume:5m", "volume:15m"];
  }
  if (presetId === "oiSpike") {
    return ["oiChangePct:5m", "oiChangePct:15m", "oiChangePct:1h"];
  }
  if (presetId === "pumpAlert" || presetId === "bigMovers") {
    return ["changePct:5m", "changePct:15m", "changePct:1h", "rvol"];
  }
  if (presetId === "shortSqueeze" || presetId === "highFunding") {
    return ["fundingRate1h", "funding", "basisPct", "changePct:15m"];
  }
  return [];
}

export default function Screener({ exchange = "mexc" }: { exchange?: ExchangeId }) {
  const [mounted, setMounted] = useState(false);
  const [data, setData] = useState<ScreenerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [quality, setQuality] = useState<"fast" | "full" | null>(null);
  const [refreshAfterMs, setRefreshAfterMs] = useState<number | null>(null);
  // Chart only loads when user explicitly clicks a ticker row
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [excludedSymbolsInput, setExcludedSymbolsInput] = useState("");
  const [excludedKeywordsInput, setExcludedKeywordsInput] = useState("");
  const [selectedSector, setSelectedSector] = useState<string>("all");
  const [excludedSectors, setExcludedSectors] = useState<Set<string>>(new Set());
  const [sectorFilterMode, setSectorFilterMode] = useState<"exclude" | "include">("exclude");
  const [hideUsStocks, setHideUsStocks] = useState<boolean>(false);
  const [hideAllTradFi, setHideAllTradFi] = useState<boolean>(false);
  const [showCategoryBar, setShowCategoryBar] = useState<boolean>(true);
  const [scopeMode, setScopeMode] = useState<"active" | "all">("all");
  const [dockMode, setDockMode] = useState<DockMode>("dropdown");
  const [tvInterval, setTvInterval] = useState<string>("15");
  const [chartWidthMode, setChartWidthMode] = useState<"std" | "wide" | "half" | "max">("wide");
  const [tvStyle, setTvStyle] = useState<"1" | "8" | "3" | "2">("1");
  const [tvStudies, setTvStudies] = useState<Set<string>>(new Set());
  const [tvShowDrawingTools, setTvShowDrawingTools] = useState<boolean>(true);
  const [tvFeedOverride, setTvFeedOverride] = useState<"auto" | "mexc_spot" | "bybit" | "binance">("auto");
  const [chartEngine, setChartEngine] = useState<"pro" | "tv">("pro");
  const [dropdownHeightMode, setDropdownHeightMode] = useState<"fit" | "medium" | "tall">("fit");
  const [tableViewport, setTableViewport] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [showChartMatrix, setShowChartMatrix] = useState<boolean>(true);
  const [showSparkline, setShowSparkline] = useState(true);
  const [showColumns, setShowColumns] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [showAlerts, setShowAlerts] = useState(false);
  const [watchlistKeys, setWatchlistKeys] = useState<Set<string>>(new Set());
  const [watchOnly, setWatchOnly] = useState(false);
  const [pinWatchedFirst, setPinWatchedFirst] = useState(false);
  const [activeTfFocus, setActiveTfFocus] = useState<string>("default");
  const [visible, setVisible] = useState<Set<string>>(new Set(DEFAULT_VISIBLE));
  const [sortBy, setSortBy] = useState<string>("volume:1d");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const userSortTriggerRef = useRef(false);
  const requestedKlinesRef = useRef<Map<string, number>>(new Map());
  const enrichedRowsCacheRef = useRef<Map<string, { at: number; row: Row }>>(new Map());
  const prePresetSortRef = useRef<{ sortBy: string; sortDir: "asc" | "desc" } | null>(null);
  const prePresetVisibleRef = useRef<Set<string> | null>(null);
  const stableSortedSymbolsRef = useRef<string[]>([]);
  const lastSortFilterKeyRef = useRef<string>("");

  // Alerts & Saved Filter Presets state
  const [alertRules, setAlertRules] = useState<AlertConditionRule[]>(DEFAULT_ALERT_RULES);
  const [alertEvents, setAlertEvents] = useState<TriggeredAlertEvent[]>([]);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const alertCooldownMapRef = useRef<Map<string, number>>(new Map());
  const [savedFilterPresets, setSavedFilterPresets] = useState<SavedFilterPreset[]>([]);
  const [newPresetName, setNewPresetName] = useState("");

  // Real-time Multi-Exchange WebSocket state
  const [wsEnabled, setWsEnabled] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);
  const [livePatches, setLivePatches] = useState<Record<string, LiveTickPatch>>({});
  const [priceFlashes, setPriceFlashes] = useState<Record<string, "up" | "down">>({});
  const prevPricesRef = useRef<Record<string, number>>({});

  const tableBodyRef = useRef<HTMLDivElement>(null);
  const topScrollTrackRef = useRef<HTMLDivElement>(null);
  const topScrollThumbRef = useRef<HTMLDivElement>(null);
  const hScrollTrackRef = useRef<HTMLDivElement>(null);
  const hScrollThumbRef = useRef<HTMLDivElement>(null);
  const topSliderRef = useRef<HTMLInputElement>(null);
  const bottomSliderRef = useRef<HTMLInputElement>(null);
  const hDragRef = useRef<{ active: boolean; startX: number; startScrollLeft: number; movablePx: number }>({
    active: false,
    startX: 0,
    startScrollLeft: 0,
    movablePx: 1,
  });

  const [enabledPresets, setEnabledPresets] = useState<Record<PresetId, boolean>>({
    highVolume: false,
    oiSpike: false,
    bigMovers: false,
    highFunding: false,
    pumpAlert: false,
    shortSqueeze: false,
    zeroFee: false,
    newHot: false,
  });
  const [presetThresholds, setPresetThresholds] = useState(PRESET_DEFAULTS);
  const [manualFilters, setManualFilters] = useState<ManualFilter[]>([]);
  const [builderField, setBuilderField] = useState<NumericField>("volume:1d");
  const [builderOp, setBuilderOp] = useState<CompareOp>(">");
  const [builderValue, setBuilderValue] = useState("");
  const [builderValue2, setBuilderValue2] = useState("");

  // Load persisted workspace configuration
  useEffect(() => {
    setMounted(true);
    setWatchlistKeys(loadWatchlistFromStorage());
    try {
      const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          visible?: string[];
          mcapDefaultV2?: boolean;
          orionExtendedColsV3?: boolean;
          showSparkline?: boolean;
          soundEnabledV2?: boolean;
          sortBy?: string;
          sortDir?: "asc" | "desc";
          dockMode?: DockMode;
          tvInterval?: string;
          excludedSymbolsInput?: string;
          excludedKeywordsInput?: string;
          excludedSectors?: string[];
          hideUsStocks?: boolean;
          hideAllTradFi?: boolean;
          showCategoryBar?: boolean;
          presetThresholds?: typeof PRESET_DEFAULTS;
        };
        if (Array.isArray(parsed.visible) && parsed.visible.length > 0) {
          const nextVis = new Set(parsed.visible);
          if (!parsed.mcapDefaultV2) {
            nextVis.add("mcap");
            nextVis.add("rvol");
          }
          if (!parsed.orionExtendedColsV3) {
            for (const col of COLUMN_PRESETS.orionDefault) {
              nextVis.add(col);
            }
          }
          setVisible(nextVis);
        }
        if (typeof parsed.showSparkline === "boolean") setShowSparkline(parsed.showSparkline);
        if (typeof parsed.soundEnabledV2 === "boolean") setSoundEnabled(parsed.soundEnabledV2);
        if (parsed.sortBy) setSortBy(parsed.sortBy);
        if (parsed.sortDir === "asc" || parsed.sortDir === "desc") setSortDir(parsed.sortDir);
        if (
          parsed.dockMode === "dropdown" ||
          parsed.dockMode === "right" ||
          parsed.dockMode === "top" ||
          parsed.dockMode === "hidden"
        ) {
          setDockMode(parsed.dockMode);
        }
        if (parsed.tvInterval) setTvInterval(parsed.tvInterval);
        if (typeof parsed.excludedSymbolsInput === "string") setExcludedSymbolsInput(parsed.excludedSymbolsInput);
        if (typeof parsed.excludedKeywordsInput === "string") setExcludedKeywordsInput(parsed.excludedKeywordsInput);
        if (Array.isArray(parsed.excludedSectors)) setExcludedSectors(new Set(parsed.excludedSectors));
        if (typeof parsed.hideUsStocks === "boolean") setHideUsStocks(parsed.hideUsStocks);
        if (typeof parsed.hideAllTradFi === "boolean") setHideAllTradFi(parsed.hideAllTradFi);
        if (typeof parsed.showCategoryBar === "boolean") setShowCategoryBar(parsed.showCategoryBar);
        if (parsed.presetThresholds) {
          setPresetThresholds((prev) => ({ ...prev, ...parsed.presetThresholds }));
        }
      }
      const rawPresets = window.localStorage.getItem(SAVED_PRESETS_STORAGE_KEY);
      if (rawPresets) {
        const parsedPresets = JSON.parse(rawPresets) as SavedFilterPreset[];
        if (Array.isArray(parsedPresets)) setSavedFilterPresets(parsedPresets);
      }
      const rawAlerts = window.localStorage.getItem(ALERT_RULES_STORAGE_KEY);
      if (rawAlerts) {
        const parsedAlerts = JSON.parse(rawAlerts) as AlertConditionRule[];
        if (Array.isArray(parsedAlerts) && parsedAlerts.length > 0) setAlertRules(parsedAlerts);
      }
    } catch {
      // Ignore corrupt localStorage
    }
  }, []);

  // Persist workspace settings on change
  useEffect(() => {
    if (!mounted) return;
    try {
      window.localStorage.setItem(
        SETTINGS_STORAGE_KEY,
        JSON.stringify({
          visible: [...visible],
          mcapDefaultV2: true,
          orionExtendedColsV3: true,
          showSparkline,
          soundEnabledV2: soundEnabled,
          sortBy,
          sortDir,
          dockMode,
          tvInterval,
          excludedSymbolsInput,
          excludedKeywordsInput,
          excludedSectors: [...excludedSectors],
          hideUsStocks,
          hideAllTradFi,
          showCategoryBar,
          presetThresholds,
        }),
      );
    } catch {
      // Ignore quota errors
    }
  }, [
    mounted,
    visible,
    showSparkline,
    soundEnabled,
    sortBy,
    sortDir,
    dockMode,
    tvInterval,
    excludedSymbolsInput,
    excludedKeywordsInput,
    excludedSectors,
    hideUsStocks,
    hideAllTradFi,
    showCategoryBar,
    presetThresholds,
  ]);

  useEffect(() => {
    if (!mounted) return;
    try {
      window.localStorage.setItem(SAVED_PRESETS_STORAGE_KEY, JSON.stringify(savedFilterPresets));
    } catch {
      // Ignore quota
    }
  }, [mounted, savedFilterPresets]);

  useEffect(() => {
    if (!mounted) return;
    try {
      window.localStorage.setItem(ALERT_RULES_STORAGE_KEY, JSON.stringify(alertRules));
    } catch {
      // Ignore quota
    }
  }, [mounted, alertRules]);

  const lastUserActivityAtRef = useRef<number>(Date.now());
  const lastFullFetchAtRef = useRef<number>(0);
  const IDLE_PAUSE_MS = 3 * 60_000; // Pause background Vercel HTTP polling after 3m of no mouse/scroll/keyboard activity

  const isClientActiveForPolling = useCallback(() => {
    if (typeof document !== "undefined" && document.hidden) return false;
    return Date.now() - lastUserActivityAtRef.current < IDLE_PAUSE_MS;
  }, [IDLE_PAUSE_MS]);

  const fetchScreenerData = useCallback(
    async (extraSyms: string[] = []) => {
      const isPartialDelta = extraSyms.length > 0;
      try {
        if (!isPartialDelta) {
          setRefreshing(true);
          lastFullFetchAtRef.current = Date.now();
        }
        const params = new URLSearchParams();
        if (isPartialDelta) {
          params.set("symbols", extraSyms.join(","));
          params.set("partial", "1");
        }
        const qs = params.toString();
        const endpoint = `/api/screener/${exchange}${qs ? `?${qs}` : ""}`;
        const res = await fetch(endpoint);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = (await res.json()) as ScreenerPayload;
        const now = Date.now();
        const cache = enrichedRowsCacheRef.current;
        const KLINE_CACHE_TTL_MS = 300_000; // 5-minute client kline cache TTL (re-anchored live via WebSocket)

        if (isPartialDelta) {
          if (payload.rows.length > 0) {
            const deltaMap = new Map<string, Row>();
            for (const r of payload.rows) {
              if (r.hasKlines !== false) {
                cache.set(r.symbol, { at: now, row: r });
              }
              deltaMap.set(r.symbol, r);
            }
            try {
              const entriesToSave = [...cache.entries()]
                .filter(([, v]) => now - v.at <= KLINE_CACHE_TTL_MS)
                .sort((a, b) => b[1].at - a[1].at)
                .slice(0, 400);
              window.sessionStorage.setItem(
                `mexc-screener-kline-cache-v1:${exchange}`,
                JSON.stringify(entriesToSave),
              );
            } catch {
              // Ignore sessionStorage quota errors
            }
            setData((prev) => {
              if (!prev) return prev;
              const nextRows = prev.rows.map((r) => deltaMap.get(r.symbol) ?? r);
              const klineSymbolsCount = nextRows.filter((r) => r.hasKlines !== false).length;
              return {
                ...prev,
                rows: nextRows,
                klineSymbolsCount,
              };
            });
          }
          return;
        }

        const mergedServerRows = payload.rows.map((r) => {
          if (r.hasKlines !== false) {
            cache.set(r.symbol, { at: now, row: r });
            return r;
          }
          const cached = cache.get(r.symbol);
          if (!cached || now - cached.at > KLINE_CACHE_TTL_MS) {
            if (cached) cache.delete(r.symbol);
            return r;
          }
          const cr = cached.row;
          const priceDelta = r.price - cr.price;
          const reanchorCachedPct = (oldPct: number | null): number | null => {
            if (oldPct === null || !Number.isFinite(oldPct) || cr.price <= 0) return oldPct;
            const denom = 1 + oldPct / 100;
            if (denom <= 0.01) return oldPct;
            const anchorPrice = cr.price / denom;
            return ((r.price - anchorPrice) / anchorPrice) * 100;
          };
          return {
            ...cr,
            price: r.price,
            oiUsd: r.oiUsd,
            funding: r.funding,
            fundingRate1h: r.fundingRate1h,
            fundingIntervalHours: r.fundingIntervalHours,
            basisPct: r.basisPct,
            rangePos24h: r.rangePos24h,
            high24Price: r.high24Price,
            low24Price: r.low24Price,
            mcap: r.mcap,
            oiToMcapPct: r.oiToMcapPct,
            volToOi: r.volToOi,
            isZeroFee: r.isZeroFee,
            isNew: r.isNew,
            isHot: r.isHot,
            sectors: r.sectors,
            hasKlines: true,
            changePct: {
              "5m": reanchorCachedPct(cr.changePct["5m"]),
              "15m": reanchorCachedPct(cr.changePct["15m"]),
              "1h": reanchorCachedPct(cr.changePct["1h"]),
              "4h": reanchorCachedPct(cr.changePct["4h"]),
              "8h": reanchorCachedPct(cr.changePct["8h"]),
              "12h": reanchorCachedPct(cr.changePct["12h"]),
              "1d": r.changePct["1d"],
            },
            changeUsd: {
              "5m": cr.changeUsd["5m"] !== null ? cr.changeUsd["5m"] + priceDelta : null,
              "15m": cr.changeUsd["15m"] !== null ? cr.changeUsd["15m"] + priceDelta : null,
              "1h": cr.changeUsd["1h"] !== null ? cr.changeUsd["1h"] + priceDelta : null,
              "4h": cr.changeUsd["4h"] !== null ? cr.changeUsd["4h"] + priceDelta : null,
              "8h": cr.changeUsd["8h"] !== null ? cr.changeUsd["8h"] + priceDelta : null,
              "12h": cr.changeUsd["12h"] !== null ? cr.changeUsd["12h"] + priceDelta : null,
              "1d": r.changeUsd["1d"],
            },
            volume: {
              ...cr.volume,
              "1d": r.volume["1d"],
            },
          };
        });

        try {
          const entriesToSave = [...cache.entries()]
            .filter(([, v]) => now - v.at <= KLINE_CACHE_TTL_MS)
            .sort((a, b) => b[1].at - a[1].at)
            .slice(0, 400);
          window.sessionStorage.setItem(
            `mexc-screener-kline-cache-v1:${exchange}`,
            JSON.stringify(entriesToSave),
          );
        } catch {
          // Ignore sessionStorage quota errors
        }

        setData({ ...payload, rows: mergedServerRows });
        setLivePatches((prev) => {
          const next: Record<string, LiveTickPatch> = {};
          for (const [k, v] of Object.entries(prev)) {
            if (v.updatedAt > payload.asOf) next[k] = v;
          }
          return next;
        });
        setWarning(payload.warning ?? null);
        setQuality(payload.quality ?? null);
        setRefreshAfterMs(payload.nextRefreshMs ?? null);
        setError(null);
      } catch (e) {
        if (!isPartialDelta) {
          setError(e instanceof Error ? e.message : "Failed to load screener");
          setWarning(null);
        }
      } finally {
        if (!isPartialDelta) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [exchange],
  );

  // Track user interaction & tab visibility: pause HTTP polling when tab is hidden or idle (>3m),
  // and immediately refresh when user focuses tab or interacts again after being idle.
  useEffect(() => {
    const markActive = () => {
      const now = Date.now();
      const wasIdle = now - lastUserActivityAtRef.current >= IDLE_PAUSE_MS;
      lastUserActivityAtRef.current = now;
      if (wasIdle && !document.hidden && now - lastFullFetchAtRef.current > 25_000) {
        void fetchScreenerData();
      }
    };
    const onPointerMove = () => {
      if (Date.now() - lastUserActivityAtRef.current > 2_500) {
        markActive();
      }
    };
    const onVisibilityChange = () => {
      if (!document.hidden) {
        lastUserActivityAtRef.current = Date.now();
        if (Date.now() - lastFullFetchAtRef.current > 20_000) {
          void fetchScreenerData();
        }
      }
    };
    window.addEventListener("pointerdown", markActive, { passive: true });
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("wheel", markActive, { passive: true });
    window.addEventListener("keydown", markActive, { passive: true });
    window.addEventListener("touchstart", markActive, { passive: true });
    window.addEventListener("focus", onVisibilityChange);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pointerdown", markActive);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("wheel", markActive);
      window.removeEventListener("keydown", markActive);
      window.removeEventListener("touchstart", markActive);
      window.removeEventListener("focus", onVisibilityChange);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [IDLE_PAUSE_MS, fetchScreenerData]);

  // Periodic HTTP refresh (every 45s while active; live WebSocket handles sub-second updates)
  useEffect(() => {
    setLoading(true);
    setLivePatches({});
    requestedKlinesRef.current.clear();
    enrichedRowsCacheRef.current.clear();
    try {
      const raw = window.sessionStorage.getItem(`mexc-screener-kline-cache-v1:${exchange}`);
      if (raw) {
        const parsed = JSON.parse(raw) as Array<[string, { at: number; row: Row }]>;
        const now = Date.now();
        if (Array.isArray(parsed)) {
          for (const [sym, entry] of parsed) {
            if (entry && typeof entry.at === "number" && now - entry.at <= 300_000 && entry.row) {
              enrichedRowsCacheRef.current.set(sym, entry);
            }
          }
        }
      }
    } catch {
      // Ignore corrupt sessionStorage
    }
    stableSortedSymbolsRef.current = [];
    lastSortFilterKeyRef.current = "";
    setSelectedSymbol(null);
    void fetchScreenerData();
    const timer = setInterval(() => {
      if (!isClientActiveForPolling()) return;
      void fetchScreenerData();
    }, 45_000);
    return () => clearInterval(timer);
  }, [exchange, fetchScreenerData, isClientActiveForPolling]);

  // Fast-mode follow-up fetch
  useEffect(() => {
    if (quality !== "fast" || !refreshAfterMs) return;
    const timer = setTimeout(() => {
      void fetchScreenerData();
    }, refreshAfterMs);
    return () => clearTimeout(timer);
  }, [quality, refreshAfterMs, fetchScreenerData]);

  // On-demand kline enrichment if user selects a symbol that doesn't have klines yet
  useEffect(() => {
    if (!data || !selectedSymbol) return;
    const row = data.rows.find((r) => r.symbol === selectedSymbol);
    const lastReq = requestedKlinesRef.current.get(selectedSymbol) ?? 0;
    if (row && row.hasKlines === false && Date.now() - lastReq > 15_000) {
      requestedKlinesRef.current.set(selectedSymbol, Date.now());
      void fetchScreenerData([selectedSymbol]);
    }
  }, [data, selectedSymbol, fetchScreenerData]);

  // Multi-Exchange Real-Time WebSocket Stream (MEXC, Binance, Hyperliquid, Bybit)
  useEffect(() => {
    if (!wsEnabled) {
      setWsConnected(false);
      return;
    }

    let ws: WebSocket | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let flushTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let alive = true;
    let pendingPatches: Record<string, LiveTickPatch> = {};
    let pendingFlashes: Record<string, "up" | "down"> = {};
    let hasPending = false;

    // Coalesce high-frequency WebSocket ticks into a smooth 450ms rAF-aligned commit
    flushTimer = setInterval(() => {
      if (!alive || !hasPending) return;
      const patchesToCommit = pendingPatches;
      const flashesToCommit = pendingFlashes;
      pendingPatches = {};
      pendingFlashes = {};
      hasPending = false;

      window.requestAnimationFrame(() => {
        if (!alive) return;
        if (Object.keys(patchesToCommit).length > 0) {
          setLivePatches((prev) => ({ ...prev, ...patchesToCommit }));
        }
        if (Object.keys(flashesToCommit).length > 0) {
          setPriceFlashes(flashesToCommit);
        }
      });
    }, 450);

    const wsUrl =
      exchange === "mexc"
        ? "wss://contract.mexc.com/edge"
        : exchange === "binance"
          ? "wss://fstream.binance.com/ws/!miniTicker@arr"
          : exchange === "hyperliquid"
            ? "wss://api.hyperliquid.xyz/ws"
            : "wss://stream.bybit.com/v5/public/linear";

    const connect = () => {
      if (!alive) return;
      try {
        ws = new WebSocket(wsUrl);
      } catch {
        setWsConnected(false);
        return;
      }

      ws.onopen = () => {
        if (!alive || !ws) return;
        setWsConnected(true);
        if (exchange === "mexc") {
          ws.send(JSON.stringify({ method: "sub.tickers", param: {} }));
          pingTimer = setInterval(() => {
            if (ws?.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ method: "ping" }));
            }
          }, 15_000);
        } else if (exchange === "hyperliquid") {
          ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "allMids" } }));
          pingTimer = setInterval(() => {
            if (ws?.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ method: "ping" }));
            }
          }, 25_000);
        } else if (exchange === "bybit") {
          const topSyms = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "SUIUSDT", "BNBUSDT", "HYPEUSDT"];
          ws.send(JSON.stringify({ op: "subscribe", args: topSyms.map((s) => `tickers.${s}`) }));
          pingTimer = setInterval(() => {
            if (ws?.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ op: "ping" }));
            }
          }, 20_000);
        }
      };

      ws.onmessage = (event) => {
        if (!alive) return;
        try {
          const now = Date.now();
          const patches: Record<string, LiveTickPatch> = {};
          const flashes: Record<string, "up" | "down"> = {};

          if (exchange === "mexc") {
            const msg = JSON.parse(String(event.data)) as {
              channel?: string;
              data?: Array<{
                symbol?: string;
                lastPrice?: number;
                amount24?: number;
                riseFallRate?: number;
                indexPrice?: number;
                high24Price?: number;
                lower24Price?: number;
              }>;
            };
            if (msg.channel !== "push.tickers" || !Array.isArray(msg.data)) return;

            for (const t of msg.data) {
              const sym = t.symbol;
              if (!sym || !sym.endsWith("_USDT")) continue;
              const price = Number(t.lastPrice);
              if (!Number.isFinite(price) || price <= 0) continue;

              const prevPrice = prevPricesRef.current[sym];
              if (prevPrice !== undefined && prevPrice !== price) {
                flashes[sym] = price > prevPrice ? "up" : "down";
              }
              prevPricesRef.current[sym] = price;

              const idxPrice = Number(t.indexPrice);
              const high24 = Number(t.high24Price);
              const low24 = Number(t.lower24Price);
              const rfr = Number(t.riseFallRate);
              const amt24 = Number(t.amount24);

              patches[sym] = {
                price,
                amount24: Number.isFinite(amt24) && amt24 > 0 ? amt24 : undefined,
                change24hPct: Number.isFinite(rfr) ? rfr * 100 : undefined,
                basisPct: idxPrice > 0 ? ((price - idxPrice) / idxPrice) * 100 : undefined,
                rangePos24h:
                  high24 > low24 && low24 > 0
                    ? Math.max(0, Math.min(100, ((price - low24) / (high24 - low24)) * 100))
                    : undefined,
                high24Price: high24 > 0 ? high24 : undefined,
                low24Price: low24 > 0 ? low24 : undefined,
                updatedAt: now,
              };
            }
          } else if (exchange === "binance") {
            const arr = JSON.parse(String(event.data)) as Array<{
              s?: string;
              c?: string;
              o?: string;
              h?: string;
              l?: string;
              q?: string;
            }>;
            if (!Array.isArray(arr)) return;
            for (const t of arr) {
              const sym = t.s;
              if (!sym || !sym.endsWith("USDT")) continue;
              const price = Number(t.c);
              if (!Number.isFinite(price) || price <= 0) continue;
              const prevPrice = prevPricesRef.current[sym];
              if (prevPrice !== undefined && prevPrice !== price) {
                flashes[sym] = price > prevPrice ? "up" : "down";
              }
              prevPricesRef.current[sym] = price;
              const open24 = Number(t.o);
              const high24 = Number(t.h);
              const low24 = Number(t.l);
              const qVol = Number(t.q);
              patches[sym] = {
                price,
                amount24: Number.isFinite(qVol) && qVol > 0 ? qVol : undefined,
                change24hPct: open24 > 0 ? ((price - open24) / open24) * 100 : undefined,
                rangePos24h:
                  high24 > low24 && low24 > 0
                    ? Math.max(0, Math.min(100, ((price - low24) / (high24 - low24)) * 100))
                    : undefined,
                high24Price: high24 > 0 ? high24 : undefined,
                low24Price: low24 > 0 ? low24 : undefined,
                updatedAt: now,
              };
            }
          } else if (exchange === "hyperliquid") {
            const msg = JSON.parse(String(event.data)) as {
              channel?: string;
              data?: { mids?: Record<string, string> };
            };
            if (msg.channel !== "allMids" || !msg.data?.mids) return;
            for (const [sym, rawPx] of Object.entries(msg.data.mids)) {
              const price = Number(rawPx);
              if (!Number.isFinite(price) || price <= 0) continue;
              const prevPrice = prevPricesRef.current[sym];
              if (prevPrice !== undefined && prevPrice !== price) {
                flashes[sym] = price > prevPrice ? "up" : "down";
              }
              prevPricesRef.current[sym] = price;
              patches[sym] = {
                price,
                updatedAt: now,
              };
            }
          } else if (exchange === "bybit") {
            const msg = JSON.parse(String(event.data)) as {
              topic?: string;
              data?: { symbol?: string; lastPrice?: string; turnover24h?: string; price24hPcnt?: string };
            };
            if (!msg.topic?.startsWith("tickers.") || !msg.data?.symbol) return;
            const sym = msg.data.symbol;
            const price = Number(msg.data.lastPrice);
            if (Number.isFinite(price) && price > 0) {
              const prevPrice = prevPricesRef.current[sym];
              if (prevPrice !== undefined && prevPrice !== price) {
                flashes[sym] = price > prevPrice ? "up" : "down";
              }
              prevPricesRef.current[sym] = price;
              const t24 = Number(msg.data.turnover24h);
              const p24 = Number(msg.data.price24hPcnt);
              patches[sym] = {
                price,
                amount24: Number.isFinite(t24) && t24 > 0 ? t24 : undefined,
                change24hPct: Number.isFinite(p24) ? p24 * 100 : undefined,
                updatedAt: now,
              };
            }
          }

          if (Object.keys(patches).length > 0) {
            const histMap = clientPriceHistoryRef.current;
            for (const [sym, p] of Object.entries(patches)) {
              if (!Number.isFinite(p.price) || p.price <= 0) continue;
              let arr = histMap.get(sym);
              if (!arr) {
                arr = [{ ts: now, price: p.price }];
                histMap.set(sym, arr);
              } else {
                const last = arr[arr.length - 1];
                if (!last || now - last.ts >= 10_000) {
                  arr.push({ ts: now, price: p.price });
                  if (arr.length > 96) arr.shift();
                }
              }
            }
            Object.assign(pendingPatches, patches);
            hasPending = true;
          }
          if (Object.keys(flashes).length > 0) {
            Object.assign(pendingFlashes, flashes);
            hasPending = true;
          }
        } catch {
          // Ignore malformed frame
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
        if (pingTimer) clearInterval(pingTimer);
        if (alive) {
          reconnectTimer = setTimeout(connect, 3_000);
        }
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();

    return () => {
      alive = false;
      if (pingTimer) clearInterval(pingTimer);
      if (flushTimer) clearInterval(flushTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [exchange, wsEnabled]);

  const clientPriceHistoryRef = useRef<Map<string, Array<{ ts: number; price: number }>>>(new Map());

  // Clear flash highlights periodically
  useEffect(() => {
    if (Object.keys(priceFlashes).length === 0) return;
    const timer = setTimeout(() => {
      setPriceFlashes({});
    }, 650);
    return () => clearTimeout(timer);
  }, [priceFlashes]);

  // Merge server rows with live WebSocket patches (only applying patches newer than data.asOf)
  // Every timeframe has its own distinct baseline (`row.changePct[tf]`) so live price ticks re-anchor
  // against each timeframe's distinct historical open price rather than applying a uniform delta from 0%.
  const mergedRows = useMemo(() => {
    if (!data) return [];
    if (Object.keys(livePatches).length === 0) return data.rows;
    const histMap = clientPriceHistoryRef.current;

    return data.rows.map((row) => {
      const patch = livePatches[row.symbol];
      if (!patch || patch.updatedAt <= data.asOf) return row;
      const priceRatio = row.price > 0 ? patch.price / row.price : 1;
      const liveOiUsd = row.oiUsd !== null ? row.oiUsd * priceRatio : null;
      const liveVol1d = patch.amount24 ?? row.volume["1d"];
      const liveChg1d = patch.change24hPct ?? row.changePct["1d"];

      const tickDeltaUsd = patch.price - row.price;
      const reanchorPct = (oldPct: number | null): number | null => {
        if (oldPct === null || !Number.isFinite(oldPct) || row.price <= 0) return oldPct;
        const denom = 1 + oldPct / 100;
        if (denom <= 0.01) return oldPct;
        const anchorPrice = row.price / denom;
        return ((patch.price - anchorPrice) / anchorPrice) * 100;
      };

      let chg5mPct = reanchorPct(row.changePct["5m"]);
      let chg5mUsd = row.changeUsd["5m"] !== null ? row.changeUsd["5m"] + tickDeltaUsd : null;
      const symHist = histMap.get(row.symbol);
      if (symHist && symHist.length >= 2) {
        const target5mTs = patch.updatedAt - 300_000;
        let best5m: { ts: number; price: number } | null = null;
        let bestDiff = Infinity;
        for (const pt of symHist) {
          const d = Math.abs(pt.ts - target5mTs);
          if (d < bestDiff) {
            bestDiff = d;
            best5m = pt;
          }
        }
        if (best5m && bestDiff <= 45_000 && best5m.price > 0) {
          chg5mPct = ((patch.price - best5m.price) / best5m.price) * 100;
          chg5mUsd = patch.price - best5m.price;
        }
      }

      return {
        ...row,
        price: patch.price,
        oiUsd: liveOiUsd,
        basisPct: patch.basisPct !== undefined ? patch.basisPct : row.basisPct,
        rangePos24h: patch.rangePos24h !== undefined ? patch.rangePos24h : row.rangePos24h,
        high24Price: patch.high24Price ?? row.high24Price,
        low24Price: patch.low24Price ?? row.low24Price,
        oiToMcapPct: liveOiUsd && row.mcap && row.mcap > 0 ? (liveOiUsd / row.mcap) * 100 : row.oiToMcapPct,
        volToOi: liveOiUsd && liveOiUsd > 0 && liveVol1d ? liveVol1d / liveOiUsd : row.volToOi,
        changePct: {
          ...row.changePct,
          "5m": chg5mPct,
          "15m": reanchorPct(row.changePct["15m"]),
          "1h": reanchorPct(row.changePct["1h"]),
          "4h": reanchorPct(row.changePct["4h"]),
          "8h": reanchorPct(row.changePct["8h"]),
          "12h": reanchorPct(row.changePct["12h"]),
          "1d": liveChg1d,
        },
        changeUsd: {
          ...row.changeUsd,
          "5m": chg5mUsd,
          "15m": row.changeUsd["15m"] !== null ? row.changeUsd["15m"] + tickDeltaUsd : null,
          "1h": row.changeUsd["1h"] !== null ? row.changeUsd["1h"] + tickDeltaUsd : null,
          "4h": row.changeUsd["4h"] !== null ? row.changeUsd["4h"] + tickDeltaUsd : null,
          "8h": row.changeUsd["8h"] !== null ? row.changeUsd["8h"] + tickDeltaUsd : null,
          "12h": row.changeUsd["12h"] !== null ? row.changeUsd["12h"] + tickDeltaUsd : null,
        },
        volume: (() => {
          const volDelta =
            liveVol1d !== null && row.volume["1d"] !== null && liveVol1d > row.volume["1d"]
              ? liveVol1d - row.volume["1d"]
              : 0;
          if (volDelta <= 0) {
            return {
              ...row.volume,
              "1d": liveVol1d,
            };
          }
          return {
            ...row.volume,
            "5m": row.volume["5m"] !== null ? row.volume["5m"] + volDelta : null,
            "15m": row.volume["15m"] !== null ? row.volume["15m"] + volDelta : null,
            "1h": row.volume["1h"] !== null ? row.volume["1h"] + volDelta : null,
            "4h": row.volume["4h"] !== null ? row.volume["4h"] + volDelta : null,
            "8h": row.volume["8h"] !== null ? row.volume["8h"] + volDelta : null,
            "12h": row.volume["12h"] !== null ? row.volume["12h"] + volDelta : null,
            "1d": liveVol1d,
          };
        })(),
      };
    });
  }, [data, livePatches]);

  // Live Alert Rule Evaluator (evaluates active rules against mergedRows with 180s per-coin cooldown)
  useEffect(() => {
    if (!mergedRows.length) return;
    const enabledRules = alertRules.filter((r) => r.enabled);
    if (!enabledRules.length) return;

    const now = Date.now();
    const newEvents: TriggeredAlertEvent[] = [];
    let soundToPlay: AlertConditionRule["sound"] | null = null;

    for (const rule of enabledRules) {
      const label = FILTER_FIELD_OPTIONS.find((f) => f.value === rule.field)?.label ?? rule.field;
      const cmpOp: CompareOp = rule.op === "gt" ? ">" : rule.op === "lt" ? "<" : "abs_gt";
      const requiresVerifiedKlines = isKlineDependentSortKey(rule.field);
      const isLowThresholdRule =
        (rule.field.startsWith("volume:") || rule.field === "mcap" || rule.field === "oiUsd") &&
        (rule.op === "lt" || rule.value < 100_000);
      for (const row of mergedRows) {
        if (!isLowThresholdRule && (row.volume["1d"] ?? 0) < 100_000) continue; // Ignore ultra-illiquid dust
        if (requiresVerifiedKlines && row.hasKlines === false) continue;
        const val = readField(row, rule.field as NumericField);
        if (val === null || !Number.isFinite(val)) continue;
        if (compare(val, cmpOp, rule.value)) {
          const cdKey = `${rule.id}:${exchange}:${row.symbol}`;
          const lastFired = alertCooldownMapRef.current.get(cdKey) ?? 0;
          if (now - lastFired >= (rule.cooldownMs || 180_000)) {
            alertCooldownMapRef.current.set(cdKey, now);
            const formattedVal =
              rule.field.includes("Pct") || rule.field.includes("changePct") || rule.field.includes("oiChangePct")
                ? `${val >= 0 ? "+" : ""}${val.toFixed(2)}%`
                : rule.field === "rvol"
                  ? `${val.toFixed(2)}x`
                  : formatFilterThreshold(rule.field, val);
            newEvents.push({
              id: `${now}-${rule.id}-${row.symbol}`,
              ts: now,
              exchange,
              symbol: row.symbol,
              ruleName: rule.name,
              detail: `${label}: ${formattedVal}`,
              price: row.price,
              isBullish: val >= 0,
            });
            soundToPlay = rule.sound;
            if (newEvents.length >= 6) break;
          }
        }
      }
      if (newEvents.length >= 6) break;
    }

    if (newEvents.length > 0) {
      setAlertEvents((prev) => [...newEvents, ...prev].slice(0, 60));
      if (soundEnabled && soundToPlay) {
        playAlertSound(soundToPlay);
      }
    }
  }, [mergedRows, alertRules, exchange, soundEnabled]);

  // Available sectors / categories across exchange contracts
  const availableSectors = useMemo(() => {
    if (!data) return [];
    const counts = new Map<string, number>();
    for (const r of data.rows) {
      for (const s of r.sectors ?? []) {
        counts.set(s, (counts.get(s) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 22)
      .map(([sec, count]) => ({ sector: sec, count }));
  }, [data]);

  const { usStockCount, tradFiCount } = useMemo(() => {
    if (!data) return { usStockCount: 0, tradFiCount: 0 };
    let us = 0;
    let tf = 0;
    for (const r of data.rows) {
      if (isUsStockRow(r)) us++;
      if (isTradFiRow(r)) tf++;
    }
    return { usStockCount: us, tradFiCount: tf };
  }, [data]);

  const toggleExcludedSector = (sector: string) => {
    setExcludedSectors((prev) => {
      const next = new Set(prev);
      if (next.has(sector)) next.delete(sector);
      else next.add(sector);
      return next;
    });
  };

  const readSortValue = useCallback(
    (row: Row, key: string): number | string | null => {
      if (key === "symbol") {
        return toDisplaySymbol(exchange, row.symbol);
      }
      if (key === "fundingRate1h") {
        const f1h = row.fundingRate1h ?? row.funding / (row.fundingIntervalHours || 8);
        return Number.isFinite(f1h) ? f1h * 100 : null;
      }
      if (key.includes(":")) {
        const [group, timeframe] = key.split(":") as [GroupKey, string];
        const val = getMetricValue(row, group, timeframe);
        return typeof val === "number" && Number.isFinite(val) ? val : null;
      }
      const val = row[key as CoreKey];
      return typeof val === "number" && Number.isFinite(val) ? val : null;
    },
    [exchange],
  );

  const parsedDraftPrimary = useMemo(() => parseFilterInput(builderValue), [builderValue]);
  const effectiveDraftOp = parsedDraftPrimary?.opOverride ?? builderOp;
  const needsSecondDraftInput =
    effectiveDraftOp === "between" && parsedDraftPrimary?.value2 === undefined;
  const parsedDraftSecondary = useMemo(
    () =>
      effectiveDraftOp === "between"
        ? parsedDraftPrimary?.value2 !== undefined
          ? { value: parsedDraftPrimary.value2 }
          : parseFilterInput(builderValue2)
        : null,
    [effectiveDraftOp, parsedDraftPrimary, builderValue2],
  );

  const liveDraftFilter = useMemo<ManualFilter | null>(() => {
    if (!parsedDraftPrimary) return null;
    if (effectiveDraftOp === "between") {
      const v2 = parsedDraftSecondary?.value;
      if (v2 === undefined || !Number.isFinite(v2)) return null;
      return {
        id: "__live_draft__",
        field: builderField,
        op: "between",
        value: parsedDraftPrimary.value,
        value2: v2,
      };
    }
    return {
      id: "__live_draft__",
      field: builderField,
      op: effectiveDraftOp,
      value: parsedDraftPrimary.value,
    };
  }, [builderField, effectiveDraftOp, parsedDraftPrimary, parsedDraftSecondary]);

  const effectiveManualFilters = useMemo<ManualFilter[]>(() => {
    if (!liveDraftFilter) return manualFilters;
    const duplicate = manualFilters.some(
      (f) =>
        f.field === liveDraftFilter.field &&
        f.op === liveDraftFilter.op &&
        Math.abs(f.value - liveDraftFilter.value) < 1e-9 &&
        (f.value2 ?? undefined) === (liveDraftFilter.value2 ?? undefined),
    );
    return duplicate ? manualFilters : [...manualFilters, liveDraftFilter];
  }, [manualFilters, liveDraftFilter]);

  const visibleColumns = useMemo(() => {
    const activeFilterFields = new Set<string>(effectiveManualFilters.map((f) => f.field));
    const core = CORE_COLUMNS.filter((c) => visible.has(c.key) || activeFilterFields.has(c.key));
    const metrics = ALL_METRIC_COLUMNS.filter((c) => visible.has(c.key) || activeFilterFields.has(c.key));
    return [...core, ...metrics];
  }, [visible, effectiveManualFilters]);

  // Compute filtered & sorted symbol order from server snapshot (data.rows) so 450ms WebSocket patches
  // update live cell numbers in place without constantly jumping rows under the user's cursor or open chart.
  const sortedSymbolOrder = useMemo(() => {
    const baseRows = data?.rows ?? [];
    if (!baseRows.length) return [];
    let out = baseRows;

    const searching = query.trim().length > 0;
    const bypassActiveVolumeFloor =
      searching ||
      watchOnly ||
      enabledPresets.zeroFee ||
      enabledPresets.newHot ||
      selectedSector !== "all" ||
      effectiveManualFilters.length > 0;

    if (scopeMode === "active" && !bypassActiveVolumeFloor) {
      out = out.filter((r) => (r.volume["1d"] ?? 0) >= 25_000 || (selectedSymbol !== null && r.symbol === selectedSymbol));
    }

    const excludedSymbols = new Set(
      excludedSymbolsInput
        .split(",")
        .map((x) => x.trim().toUpperCase())
        .filter(Boolean)
        .map((x) => normalizeInputToExchangeSymbol(exchange, x)),
    );
    const excludedKeywords = excludedKeywordsInput
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean);

    out = out.filter((r) => {
      if (excludedSymbols.has(r.symbol)) return false;
      if (excludedKeywords.some((k) => r.symbol.includes(k))) return false;
      if (hideAllTradFi && isTradFiRow(r)) return false;
      if (hideUsStocks && isUsStockRow(r)) return false;
      if (excludedSectors.size > 0 && (r.sectors ?? []).some((s) => excludedSectors.has(s))) return false;
      if (searching && !r.symbol.toLowerCase().includes(query.trim().toLowerCase())) return false;
      if (selectedSymbol && r.symbol === selectedSymbol && !searching && effectiveManualFilters.length === 0) return true;
      if (watchOnly && !watchlistKeys.has(toWatchKey(exchange, r.symbol))) return false;
      if (selectedSector !== "all" && !(r.sectors ?? []).includes(selectedSector)) return false;

      if (enabledPresets.pumpAlert) {
        if (r.hasKlines === false) return false;
        const c5 = r.changePct["5m"] ?? -Infinity;
        const c15 = r.changePct["15m"] ?? -Infinity;
        const rv = r.rvol ?? 0;
        if (!((c5 >= 1.2 || c15 >= 2.0) && rv >= 1.1)) return false;
      }
      if (enabledPresets.oiSpike) {
        if (r.hasKlines === false) return false;
        const oi5 = r.oiChangePct["5m"] ?? -Infinity;
        const oi15 = r.oiChangePct["15m"] ?? -Infinity;
        const oi1h = r.oiChangePct["1h"] ?? -Infinity;
        if (Math.max(oi5, oi15, oi1h) <= presetThresholds.oiSpike) return false;
      }
      if (enabledPresets.shortSqueeze) {
        const fundPct = (r.funding ?? 0) * 100;
        const basis = r.basisPct ?? 0;
        const c5 = r.changePct["5m"] ?? -Infinity;
        const c15 = r.changePct["15m"] ?? -Infinity;
        const c1h = r.changePct["1h"] ?? r.changePct["1d"] ?? -Infinity;
        if (!((fundPct <= -0.015 || basis <= -0.15) && (c5 > 0.3 || c15 > 0.5 || c1h > 0.5))) return false;
      }
      if (enabledPresets.highVolume) {
        if (r.hasKlines === false) return false;
        const rvolThreshold = presetThresholds.highVolume > 500 ? 2 : presetThresholds.highVolume;
        if (!compare(r.rvol, ">", rvolThreshold)) return false;
      }
      if (enabledPresets.bigMovers) {
        if (r.hasKlines === false) return false;
        if (
          !compare(
            Math.max(
              Math.abs(r.changePct["5m"] ?? 0),
              Math.abs(r.changePct["15m"] ?? 0),
              Math.abs(r.changePct["1h"] ?? 0),
            ),
            ">",
            presetThresholds.bigMovers,
          )
        ) {
          return false;
        }
      }
      if (enabledPresets.highFunding) {
        const cycleFundPct = Math.abs((r.funding ?? 0) * 100);
        const f1hPct = Math.abs((r.fundingRate1h ?? r.funding / (r.fundingIntervalHours || 8)) * 100);
        if (!compare(Math.max(cycleFundPct, f1hPct * 8), ">", presetThresholds.highFunding)) {
          return false;
        }
      }
      if (enabledPresets.zeroFee && !(r.isZeroFee || (r.sectors ?? []).includes("0fees"))) return false;
      if (enabledPresets.newHot && !(r.isNew || r.isHot || (r.sectors ?? []).includes("contract-new"))) return false;

      for (const f of effectiveManualFilters) {
        const value = readField(r, f.field);
        if (!compare(value, f.op, f.value, f.value2)) return false;
      }
      return true;
    });

    const sortFilterKey = JSON.stringify({
      exchange,
      q: query.trim(),
      exSym: excludedSymbolsInput,
      exKw: excludedKeywordsInput,
      sec: selectedSector,
      exSec: [...excludedSectors],
      hideUsStocks,
      hideAllTradFi,
      scopeMode,
      enabledPresets,
      presetThresholds,
      effectiveManualFilters,
      sortBy,
      sortDir,
      watchOnly,
      pinWatchedFirst,
      wl: pinWatchedFirst || watchOnly ? [...watchlistKeys] : [],
    });

    const isExplicitSortOrFilterChange =
      sortFilterKey !== lastSortFilterKeyRef.current || userSortTriggerRef.current;

    // When an inline dropdown chart is open and a background poll or on-demand kline enrichment arrives,
    // lock the current row order so the open chart does not jump to a different row index under the user.
    if (
      !isExplicitSortOrFilterChange &&
      dockMode === "dropdown" &&
      selectedSymbol &&
      stableSortedSymbolsRef.current.length > 0 &&
      stableSortedSymbolsRef.current.includes(selectedSymbol)
    ) {
      const allowedSet = new Set(out.map((r) => r.symbol));
      const preserved = stableSortedSymbolsRef.current.filter((sym) => allowedSet.has(sym));
      const preservedSet = new Set(preserved);
      for (const r of out) {
        if (!preservedSet.has(r.symbol)) {
          preserved.push(r.symbol);
        }
      }
      return preserved;
    }

    const preferVerifiedKlines =
      isKlineDependentSortKey(sortBy) ||
      effectiveManualFilters.some((f) => isKlineDependentSortKey(f.field));

    const sorted = [...out].sort((a, b) => {
      if (pinWatchedFirst) {
        const aPinned = watchlistKeys.has(toWatchKey(exchange, a.symbol));
        const bPinned = watchlistKeys.has(toWatchKey(exchange, b.symbol));
        if (aPinned !== bPinned) return aPinned ? -1 : 1;
      }

      if (preferVerifiedKlines) {
        const aHasKlines = a.hasKlines !== false;
        const bHasKlines = b.hasKlines !== false;
        if (aHasKlines !== bHasKlines) return aHasKlines ? -1 : 1;
      }

      const av = readSortValue(a, sortBy);
      const bv = readSortValue(b, sortBy);

      if (av === null && bv === null) {
        return (b.volume["1d"] ?? 0) - (a.volume["1d"] ?? 0) || a.symbol.localeCompare(b.symbol);
      }
      if (av === null) return 1;
      if (bv === null) return -1;

      if (typeof av === "string" && typeof bv === "string") {
        const cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" });
        return sortDir === "desc" ? -cmp : cmp;
      }

      const an = Number(av);
      const bn = Number(bv);
      if (an !== bn) {
        return sortDir === "desc" ? bn - an : an - bn;
      }
      return (b.volume["1d"] ?? 0) - (a.volume["1d"] ?? 0) || a.symbol.localeCompare(b.symbol);
    });

    const nextOrder = sorted.map((r) => r.symbol);
    stableSortedSymbolsRef.current = nextOrder;
    lastSortFilterKeyRef.current = sortFilterKey;
    userSortTriggerRef.current = false;
    return nextOrder;
  }, [
    data,
    query,
    excludedSymbolsInput,
    excludedKeywordsInput,
    selectedSector,
    excludedSectors,
    hideUsStocks,
    hideAllTradFi,
    scopeMode,
    enabledPresets,
    presetThresholds,
    effectiveManualFilters,
    sortBy,
    sortDir,
    watchOnly,
    pinWatchedFirst,
    watchlistKeys,
    exchange,
    readSortValue,
    dockMode,
    selectedSymbol,
  ]);

  const rows = useMemo(() => {
    if (!mergedRows.length || !sortedSymbolOrder.length) return [];
    const bySymbol = new Map<string, Row>();
    for (const r of mergedRows) {
      bySymbol.set(r.symbol, r);
    }
    const result: Row[] = [];
    for (const sym of sortedSymbolOrder) {
      const r = bySymbol.get(sym);
      if (r) result.push(r);
    }
    return result;
  }, [mergedRows, sortedSymbolOrder]);

  const latestSelectionOrderRef = useRef<{
    dockMode: DockMode;
    selectedSymbol: string | null;
    sortedSymbolOrder: string[];
  }>({
    dockMode,
    selectedSymbol,
    sortedSymbolOrder,
  });
  latestSelectionOrderRef.current = {
    dockMode,
    selectedSymbol,
    sortedSymbolOrder,
  };

  const selectedRow = useMemo(
    () =>
      selectedSymbol
        ? (rows.find((r) => r.symbol === selectedSymbol) ?? mergedRows.find((r) => r.symbol === selectedSymbol) ?? null)
        : null,
    [rows, mergedRows, selectedSymbol],
  );

  // Real-time Exchange Market Pulse & Breadth Strip
  const marketPulse = useMemo(() => {
    if (!mergedRows.length) return null;
    let totalVol24h = 0;
    let totalOiUsd = 0;
    let bullCount = 0;
    let bearCount = 0;
    let fundingSum = 0;
    let fundingCount = 0;
    let top5mGainer: Row | null = null;
    let top5mLoser: Row | null = null;
    let top15mOiSpike: Row | null = null;

    for (const r of mergedRows) {
      const v24 = r.volume["1d"] ?? 0;
      totalVol24h += v24;
      if (r.oiUsd && Number.isFinite(r.oiUsd)) totalOiUsd += r.oiUsd;
      const c1d = r.changePct["1d"] ?? 0;
      if (c1d > 0) bullCount += 1;
      else if (c1d < 0) bearCount += 1;

      const f1h = r.fundingRate1h ?? r.funding / (r.fundingIntervalHours || 8);
      if (Number.isFinite(f1h)) {
        fundingSum += f1h;
        fundingCount += 1;
      }

      if (v24 >= 100_000 && r.hasKlines !== false) {
        const c5m = r.changePct["5m"];
        if (c5m !== null && Number.isFinite(c5m)) {
          if (!top5mGainer || c5m > (top5mGainer.changePct["5m"] ?? -Infinity)) top5mGainer = r;
          if (!top5mLoser || c5m < (top5mLoser.changePct["5m"] ?? Infinity)) top5mLoser = r;
        }
        const oi15 = r.oiChangePct["15m"];
        if (oi15 !== null && Number.isFinite(oi15)) {
          if (!top15mOiSpike || oi15 > (top15mOiSpike.oiChangePct["15m"] ?? -Infinity)) top15mOiSpike = r;
        }
      }
    }

    const totalActive = bullCount + bearCount || 1;
    const bullPct = Math.round((bullCount / totalActive) * 100);
    const avgFunding1h = fundingCount > 0 ? fundingSum / fundingCount : 0;

    return {
      totalVol24h,
      totalOiUsd,
      bullCount,
      bearCount,
      bullPct,
      avgFunding1h,
      top5mGainer,
      top5mLoser,
      top15mOiSpike,
    };
  }, [mergedRows]);

  const applyTimeframeFocus = (tf: string) => {
    setActiveTfFocus(tf);
    prePresetVisibleRef.current = null;
    if (tf === "default") {
      setShowSparkline(true);
      setVisible(new Set(COLUMN_PRESETS.orionDefault));
      return;
    }
    if (tf === "all") {
      setShowSparkline(true);
      setVisible(new Set([...CORE_COLUMNS.map((c) => c.key), ...ALL_METRIC_COLUMNS.map((c) => c.key)]));
      return;
    }
    // Focus on a single timeframe (5m, 15m, 1h, 4h, 8h, 12h, 1d) across all metric groups + core columns
    const cols = new Set<string>([
      "symbol",
      "price",
      `changePct:${tf}`,
      `oiChangePct:${tf}`,
      `volume:${tf}`,
      `cvd:${tf}`,
      `volChangePct:${tf}`,
      `volatility:${tf}`,
      `trades:${tf}`,
      `btcCorr:${tf}`,
      "oiUsd",
      "rvol",
      "fundingRate1h",
      "mcap",
    ]);
    userSortTriggerRef.current = true;
    setVisible(cols);
    setSortBy(`changePct:${tf}`);
    setSortDir("desc");
  };

  const activeDropdownSizeKey = `${dropdownHeightMode}:${showChartMatrix ? 1 : 0}:${tableViewport.height}`;

  const getVirtualRowKey = useCallback(
    (index: number) => {
      const sym = rows[index]?.symbol ?? String(index);
      if (dockMode === "dropdown" && selectedSymbol && sym === selectedSymbol) {
        return `${sym}::open::${activeDropdownSizeKey}`;
      }
      return sym;
    },
    [rows, dockMode, selectedSymbol, activeDropdownSizeKey],
  );

  const estimateVirtualRowSize = useCallback(
    (index: number) => {
      if (dockMode === "dropdown" && selectedSymbol && rows[index]?.symbol === selectedSymbol) {
        const ch =
          dropdownHeightMode === "tall"
            ? Math.max(540, Math.round((tableViewport.height || 760) * 0.82))
            : dropdownHeightMode === "medium"
              ? Math.max(440, Math.round((tableViewport.height || 720) * 0.65))
              : Math.max(320, Math.min(740, (tableViewport.height || 720) - (showChartMatrix ? 336 : 210)));
        return 36 + ch + (showChartMatrix ? 290 : 140);
      }
      return 36;
    },
    [dockMode, selectedSymbol, rows, dropdownHeightMode, tableViewport.height, showChartMatrix],
  );

  const extractVirtualRange = useCallback(
    (range: Range) => {
      const next = defaultRangeExtractor(range);
      if (dockMode === "dropdown" && selectedSymbol) {
        const selIdx = rows.findIndex((r) => r.symbol === selectedSymbol);
        if (selIdx >= 0 && !next.includes(selIdx)) {
          next.push(selIdx);
          next.sort((a, b) => a - b);
        }
      }
      return next;
    },
    [dockMode, selectedSymbol, rows],
  );

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => tableBodyRef.current,
    getItemKey: getVirtualRowKey,
    estimateSize: estimateVirtualRowSize,
    rangeExtractor: extractVirtualRange,
    overscan: 14,
  });
  rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;

  // Keep scroll position at the top (scrollTop = 0) when filters or sort change, even if a dropdown chart is open
  useEffect(() => {
    if (!tableBodyRef.current) return;
    rowVirtualizer.scrollToOffset(0, { align: "start", behavior: "auto" });
    tableBodyRef.current.scrollTop = 0;
    const raf = window.requestAnimationFrame(() => {
      if (tableBodyRef.current) {
        rowVirtualizer.scrollToOffset(0, { align: "start", behavior: "auto" });
        tableBodyRef.current.scrollTop = 0;
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [
    query,
    excludedSymbolsInput,
    excludedKeywordsInput,
    selectedSector,
    excludedSectors,
    hideUsStocks,
    hideAllTradFi,
    scopeMode,
    enabledPresets,
    presetThresholds,
    effectiveManualFilters,
    sortBy,
    sortDir,
    rowVirtualizer,
  ]);

  const virtualItems = rowVirtualizer.getVirtualItems();
  const virtualRangeKey =
    virtualItems.length > 0
      ? `${virtualItems[0].index}-${virtualItems[virtualItems.length - 1].index}`
      : "0-0";

  // Immediately enrich 1m klines for currently visible viewport rows + top un-enriched rows in current sort order
  // using lightweight partial=1 delta endpoint (fits within 1 burst window = ~220ms with zero rate-limit wait!)
  useEffect(() => {
    if (!rows.length || !isClientActiveForPolling()) return;
    const now = Date.now();
    const maxBatch = exchange === "mexc" ? 17 : 22;
    const candidateSymbols = new Set<string>();
    const candidateRows: Row[] = [];

    for (const vItem of rowVirtualizer.getVirtualItems()) {
      const r = rows[vItem.index];
      if (r && r.hasKlines === false && !candidateSymbols.has(r.symbol)) {
        candidateSymbols.add(r.symbol);
        candidateRows.push(r);
      }
    }
    // Also include the first un-enriched rows within the top 54 sorted rows so that even when preferVerifiedKlines
    // places existing hasKlines:true rows at 0..17, the next top movers immediately hydrate without waiting for a timer.
    for (const r of rows.slice(0, 54)) {
      if (r && r.hasKlines === false && !candidateSymbols.has(r.symbol)) {
        candidateSymbols.add(r.symbol);
        candidateRows.push(r);
      }
    }

    const missingTop = candidateRows
      .filter((r) => {
        const lastReq = requestedKlinesRef.current.get(r.symbol) ?? 0;
        return now - lastReq > 120_000;
      })
      .slice(0, maxBatch)
      .map((r) => r.symbol);
    if (missingTop.length === 0) return;
    for (const sym of missingTop) {
      requestedKlinesRef.current.set(sym, now);
    }
    void fetchScreenerData(missingTop);
  }, [exchange, rows, virtualRangeKey, rowVirtualizer, fetchScreenerData, isClientActiveForPolling]);

  // Quota-friendly background kline warmer: warms only the top 60 sorted rows (not all 1,090) in lightweight partial=1 delta batches
  // every 18s ONLY while the user is actively interacting with the tab, with a 5-minute per-symbol cooldown.
  const latestRowsForWarmingRef = useRef<Row[]>([]);
  latestRowsForWarmingRef.current = rows;
  useEffect(() => {
    const timer = setInterval(() => {
      if (!isClientActiveForPolling()) return;
      const currentRows = latestRowsForWarmingRef.current.slice(0, 60);
      if (!currentRows.length) return;
      const now = Date.now();
      const batch: string[] = [];
      for (const r of currentRows) {
        if (r.hasKlines !== false) continue;
        const lastReq = requestedKlinesRef.current.get(r.symbol) ?? 0;
        if (now - lastReq <= 300_000) continue;
        batch.push(r.symbol);
        if (batch.length >= 20) break;
      }
      if (batch.length === 0) return;
      for (const sym of batch) {
        requestedKlinesRef.current.set(sym, now);
      }
      void fetchScreenerData(batch);
    }, 18_000);
    return () => clearInterval(timer);
  }, [exchange, fetchScreenerData, isClientActiveForPolling]);

  // Measure the open inline dropdown row directly so itemSizeCache always matches its exact expanded DOM height
  // even while smooth scrolling is in progress, while collapsed rows always use their exact 36px height.
  useEffect(() => {
    const raf = window.requestAnimationFrame(() => {
      const container = tableBodyRef.current;
      if (!container) return;
      const openNode = container.querySelector<HTMLElement>('[data-inline-dropdown="true"]');
      if (openNode) {
        rowVirtualizer.measureElement(openNode);
        const idx = Number(openNode.getAttribute("data-index"));
        if (Number.isFinite(idx) && idx >= 0 && openNode.offsetHeight > 36) {
          rowVirtualizer.resizeItem(idx, openNode.offsetHeight);
        }
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [selectedSymbol, dockMode, showChartMatrix, dropdownHeightMode, tableViewport.height, rows, rowVirtualizer]);

  // Sync horizontal scrollbar thumb & range sliders directly via DOM refs at 120fps (0 React re-renders)
  const syncHorizontalSliderDOM = useCallback(() => {
    const el = tableBodyRef.current;
    if (!el) return;
    const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
    const ratio = maxScroll > 0 ? Math.min(1, Math.max(0, el.scrollLeft / maxScroll)) : 0;
    const sliderVal = String(Math.round(ratio * 1000));

    if (topSliderRef.current && topSliderRef.current.value !== sliderVal) {
      topSliderRef.current.value = sliderVal;
    }
    if (bottomSliderRef.current && bottomSliderRef.current.value !== sliderVal) {
      bottomSliderRef.current.value = sliderVal;
    }

    const visibleFrac = el.scrollWidth > 0 ? Math.min(1, Math.max(0.12, el.clientWidth / el.scrollWidth)) : 1;

    const topTrack = topScrollTrackRef.current;
    const topThumb = topScrollThumbRef.current;
    if (topTrack && topThumb) {
      const trackW = topTrack.clientWidth;
      const thumbW = Math.max(56, Math.round(trackW * visibleFrac));
      const thumbX = Math.round(Math.max(0, trackW - thumbW) * ratio);
      topThumb.style.width = `${thumbW}px`;
      topThumb.style.transform = `translate3d(${thumbX}px, 0, 0)`;
    }

    const track = hScrollTrackRef.current;
    const thumb = hScrollThumbRef.current;
    if (track && thumb) {
      const trackW = track.clientWidth;
      const thumbW = Math.max(56, Math.round(trackW * visibleFrac));
      const thumbX = Math.round(Math.max(0, trackW - thumbW) * ratio);
      thumb.style.width = `${thumbW}px`;
      thumb.style.transform = `translate3d(${thumbX}px, 0, 0)`;
    }
  }, []);

  const setTableScrollRatio = useCallback(
    (ratio0to1000: number) => {
      const el = tableBodyRef.current;
      if (!el) return;
      const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
      el.scrollLeft = (Math.max(0, Math.min(1000, ratio0to1000)) / 1000) * maxScroll;
      syncHorizontalSliderDOM();
    },
    [syncHorizontalSliderDOM],
  );

  const nudgeTableScroll = useCallback((deltaPx: number) => {
    const el = tableBodyRef.current;
    if (!el) return;
    el.scrollBy({ left: deltaPx, behavior: "smooth" });
  }, []);

  // Track exact visible width and height of the table scroll viewport & sync horizontal slider
  useEffect(() => {
    const el = tableBodyRef.current;
    if (!el) return;
    const updateViewport = () => {
      setTableViewport({
        width: el.clientWidth,
        height: el.clientHeight,
      });
      syncHorizontalSliderDOM();
    };
    updateViewport();
    const onScroll = () => {
      syncHorizontalSliderDOM();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(updateViewport);
    ro.observe(el);
    window.addEventListener("resize", updateViewport);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      window.removeEventListener("resize", updateViewport);
    };
  }, [data, loading, visibleColumns.length, showSparkline, syncHorizontalSliderDOM]);

  // Window drag listeners for custom top & bottom horizontal scrollbar thumbs
  useEffect(() => {
    const onWinMove = (e: MouseEvent) => {
      if (!hDragRef.current.active) return;
      const el = tableBodyRef.current;
      if (!el) return;
      const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
      const movableTrack = Math.max(1, hDragRef.current.movablePx);
      const dx = e.clientX - hDragRef.current.startX;
      const scrollDelta = (dx / movableTrack) * maxScroll;
      el.scrollLeft = Math.max(0, Math.min(maxScroll, hDragRef.current.startScrollLeft + scrollDelta));
      syncHorizontalSliderDOM();
    };
    const onWinUp = () => {
      hDragRef.current.active = false;
    };
    window.addEventListener("mousemove", onWinMove);
    window.addEventListener("mouseup", onWinUp);
    return () => {
      window.removeEventListener("mousemove", onWinMove);
      window.removeEventListener("mouseup", onWinUp);
    };
  }, [syncHorizontalSliderDOM]);

  // Keyboard navigation (`↑` / `↓` when a ticker chart is open, `Escape` to close chart)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (!rows.length || !selectedSymbol) return;

      if (e.key === "Escape") {
        e.preventDefault();
        setSelectedSymbol(null);
        return;
      }

      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        const idx = rows.findIndex((r) => r.symbol === selectedSymbol);
        const nextIdx = Math.min(rows.length - 1, idx + 1);
        if (rows[nextIdx]) {
          setSelectedSymbol(rows[nextIdx].symbol);
          rowVirtualizer.scrollToIndex(nextIdx, { align: "auto" });
        }
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        const idx = rows.findIndex((r) => r.symbol === selectedSymbol);
        const prevIdx = Math.max(0, idx - 1);
        if (rows[prevIdx]) {
          setSelectedSymbol(rows[prevIdx].symbol);
          rowVirtualizer.scrollToIndex(prevIdx, { align: "auto" });
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [rows, selectedSymbol, rowVirtualizer]);

  const tv = useMemo(() => {
    if (!selectedSymbol) return null;
    const base = toDisplaySymbol(exchange, selectedSymbol);
    if (tvFeedOverride === "mexc_spot") {
      return { prefix: "MEXC", symbol: `${base}USDT` };
    }
    if (tvFeedOverride === "bybit") {
      return { prefix: "BYBIT", symbol: `${base}USDT.P` };
    }
    if (tvFeedOverride === "binance") {
      return { prefix: "BINANCE", symbol: `${base}USDT.P` };
    }
    return toTradingViewSymbol(exchange, selectedSymbol);
  }, [exchange, selectedSymbol, tvFeedOverride]);

  const chartSrc = useMemo(() => {
    if (!tv) return "";
    const studyParams = Array.from(tvStudies)
      .map((s) => (s === "MA36" || s === "MA60" ? "MASimple@tv-basicstudies" : s))
      .map((s) => `&studies=${encodeURIComponent(s)}`)
      .join("");
    const sideToolbar = tvShowDrawingTools ? "0" : "1";
    return `https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(`${tv.prefix}:${tv.symbol}`)}&interval=${tvInterval}&hidesidetoolbar=${sideToolbar}&symboledit=1&saveimage=0&toolbarbg=090b10&theme=dark&style=${tvStyle}&locale=en${studyParams}`;
  }, [tv, tvInterval, tvStyle, tvStudies, tvShowDrawingTools]);

  const toggleTvStudy = (studyId: string) => {
    setTvStudies((prev) => {
      const next = new Set(prev);
      if (next.has(studyId)) next.delete(studyId);
      else next.add(studyId);
      return next;
    });
  };

  const stepSelectedSymbol = (delta: -1 | 1) => {
    if (!rows.length || !selectedSymbol) return;
    const idx = rows.findIndex((r) => r.symbol === selectedSymbol);
    if (idx === -1) return;
    const nextIdx = Math.max(0, Math.min(rows.length - 1, idx + delta));
    if (rows[nextIdx]) {
      setSelectedSymbol(rows[nextIdx].symbol);
      if (dockMode === "dropdown" && tableBodyRef.current) {
        const targetTop = Math.max(0, nextIdx * 36 - 36);
        window.requestAnimationFrame(() => {
          tableBodyRef.current?.scrollTo({ top: targetTop, behavior: "smooth" });
        });
      } else {
        rowVirtualizer.scrollToIndex(nextIdx, { align: "auto" });
      }
    }
  };

  const toggleColumn = (key: string) => {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      if (prePresetVisibleRef.current) {
        if (next.has(key)) prePresetVisibleRef.current.add(key);
        else prePresetVisibleRef.current.delete(key);
      }
      return next;
    });
  };

  const applyColumnPreset = (preset: ColumnPresetId) => {
    prePresetVisibleRef.current = null;
    if (preset === "all") {
      setShowSparkline(true);
      setVisible(new Set([...CORE_COLUMNS.map((c) => c.key), ...ALL_METRIC_COLUMNS.map((c) => c.key)]));
    } else if (preset === "coreOnly") {
      setShowSparkline(false);
      setVisible(new Set(COLUMN_PRESETS.coreOnly));
    } else {
      if (preset === "orionDefault") setShowSparkline(true);
      setVisible(new Set(COLUMN_PRESETS[preset]));
    }
  };

  const groupAllOn = (groupKey: string) =>
    ALL_METRIC_COLUMNS.filter((c) => c.type === "metric" && c.group === groupKey).every((c) => visible.has(c.key));

  const toggleGroup = (group: GroupKey, on: boolean) => {
    setVisible((prev) => {
      const next = new Set(prev);
      for (const col of ALL_METRIC_COLUMNS) {
        if (col.type === "metric" && col.group === group) {
          if (on) {
            next.add(col.key);
            prePresetVisibleRef.current?.add(col.key);
          } else {
            next.delete(col.key);
            prePresetVisibleRef.current?.delete(col.key);
          }
        }
      }
      return next;
    });
  };

  const handleSort = (key: string, explicitDir?: "asc" | "desc") => {
    userSortTriggerRef.current = true;
    setVisible((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });

    if (tableBodyRef.current) {
      rowVirtualizer.scrollToOffset(0, { align: "start", behavior: "auto" });
      tableBodyRef.current.scrollTop = 0;
    }

    if (explicitDir) {
      setSortBy(key);
      setSortDir(explicitDir);
      return;
    }

    if (sortBy === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortBy(key);
      setSortDir(key === "symbol" ? "asc" : "desc");
    }
  };

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

  const togglePreset = (presetId: PresetId) => {
    const turningOn = !enabledPresets[presetId];
    const nextPresets = { ...enabledPresets, [presetId]: turningOn };
    setEnabledPresets(nextPresets);
    userSortTriggerRef.current = true;

    const sortOverridingPresets: PresetId[] = [
      "highVolume",
      "oiSpike",
      "pumpAlert",
      "bigMovers",
      "highFunding",
      "shortSqueeze",
    ];

    if (!turningOn) {
      const anyRemainingSortPreset = sortOverridingPresets.some((id) => nextPresets[id]);
      if (prePresetVisibleRef.current) {
        const baseVisible = new Set(prePresetVisibleRef.current);
        for (const id of sortOverridingPresets) {
          if (nextPresets[id]) {
            for (const colKey of getColumnsAddedByPreset(id)) {
              baseVisible.add(colKey);
            }
          }
        }
        setVisible(baseVisible);
        if (!anyRemainingSortPreset) {
          prePresetVisibleRef.current = null;
        }
      }
      if (!anyRemainingSortPreset && prePresetSortRef.current) {
        setSortBy(prePresetSortRef.current.sortBy);
        setSortDir(prePresetSortRef.current.sortDir);
        prePresetSortRef.current = null;
      }
      return;
    }

    if (sortOverridingPresets.includes(presetId)) {
      if (!prePresetSortRef.current) {
        prePresetSortRef.current = { sortBy, sortDir };
      }
      if (!prePresetVisibleRef.current) {
        prePresetVisibleRef.current = new Set(visible);
      }
    }

    const addedCols = getColumnsAddedByPreset(presetId);
    if (addedCols.length > 0) {
      setVisible((prev) => {
        const next = new Set(prev);
        for (const colKey of addedCols) {
          next.add(colKey);
        }
        return next;
      });
    }

    if (presetId === "highVolume") {
      setSortBy("rvol");
      setSortDir("desc");
    } else if (presetId === "oiSpike") {
      setSortBy("oiChangePct:15m");
      setSortDir("desc");
    } else if (presetId === "pumpAlert") {
      setSortBy("changePct:5m");
      setSortDir("desc");
    } else if (presetId === "bigMovers") {
      setSortBy("changePct:15m");
      setSortDir("desc");
    } else if (presetId === "highFunding") {
      setSortBy("fundingRate1h");
      setSortDir("desc");
    } else if (presetId === "shortSqueeze") {
      setSortBy("fundingRate1h");
      setSortDir("asc");
    }
  };

  const addManualFilter = () => {
    const parsed1 = parseFilterInput(builderValue);
    if (!parsed1) return;
    const effectiveOp = parsed1.opOverride ?? builderOp;
    let parsed2: number | undefined;
    if (effectiveOp === "between") {
      parsed2 =
        parsed1.value2 !== undefined ? parsed1.value2 : parseFilterInput(builderValue2)?.value;
      if (parsed2 === undefined || !Number.isFinite(parsed2)) return;
    }
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setManualFilters((prev) => {
      const filteredPrev = prev.filter(
        (f) =>
          !(
            f.field === builderField &&
            f.op === effectiveOp &&
            Math.abs(f.value - parsed1.value) < 1e-9 &&
            (f.value2 ?? undefined) === (parsed2 ?? undefined)
          ),
      );
      return [
        ...filteredPrev,
        {
          id,
          field: builderField,
          op: effectiveOp,
          value: parsed1.value,
          value2: parsed2,
        },
      ];
    });
    setVisible((prev) => {
      if (prev.has(builderField)) return prev;
      const next = new Set(prev);
      next.add(builderField);
      return next;
    });
    setBuilderValue("");
    setBuilderValue2("");
  };

  const applyQuickManualRule = (field: NumericField, op: CompareOp, rawValue: string) => {
    const parsed = parseFilterInput(rawValue);
    if (!parsed) return;
    const effectiveOp = parsed.opOverride ?? op;
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setBuilderField(field);
    setBuilderOp(effectiveOp);
    setBuilderValue("");
    setBuilderValue2("");
    setManualFilters((prev) => {
      const withoutSameFieldOp = prev.filter((f) => !(f.field === field && f.op === effectiveOp));
      return [
        ...withoutSameFieldOp,
        {
          id,
          field,
          op: effectiveOp,
          value: parsed.value,
          value2: parsed.value2,
        },
      ];
    });
    setVisible((prev) => {
      if (prev.has(field)) return prev;
      const next = new Set(prev);
      next.add(field);
      return next;
    });
  };

  const editManualFilter = (f: ManualFilter) => {
    const toShorthand = (n: number): string => {
      const abs = Math.abs(n);
      const sign = n < 0 ? "-" : "";
      if (abs >= 1_000_000_000 && abs % 1_000_000 === 0) return `${sign}${abs / 1_000_000_000}b`;
      if (abs >= 1_000_000 && abs % 1_000 === 0) return `${sign}${abs / 1_000_000}m`;
      if (abs >= 1_000 && abs % 100 === 0) return `${sign}${abs / 1_000}k`;
      return String(n);
    };
    setBuilderField(f.field);
    setBuilderOp(f.op);
    setBuilderValue(toShorthand(f.value));
    setBuilderValue2(f.value2 !== undefined ? toShorthand(f.value2) : "");
    setManualFilters((prev) => prev.filter((x) => x.id !== f.id));
  };

  const saveCurrentFilterPreset = () => {
    const name = newPresetName.trim();
    if (!name) return;
    const rulesToSave = effectiveManualFilters.map((f, idx) => ({
      ...f,
      id: f.id === "__live_draft__" ? `${Date.now()}-${idx}` : f.id,
    }));
    const preset: SavedFilterPreset = {
      id: `${Date.now()}`,
      name,
      filters: rulesToSave,
    };
    setSavedFilterPresets((prev) => [...prev, preset]);
    setNewPresetName("");
  };

  const applySavedFilterPreset = (preset: SavedFilterPreset) => {
    setBuilderValue("");
    setBuilderValue2("");
    setManualFilters([...(preset.filters ?? [])]);
  };

  const deleteSavedFilterPreset = (id: string) => {
    setSavedFilterPresets((prev) => prev.filter((p) => p.id !== id));
  };

  const clearAllFilters = () => {
    setManualFilters([]);
    setBuilderValue("");
    setBuilderValue2("");
    setSelectedSector("all");
    setExcludedSectors(new Set());
    setHideUsStocks(false);
    setHideAllTradFi(false);
    setEnabledPresets({
      pumpAlert: false,
      oiSpike: false,
      shortSqueeze: false,
      highVolume: false,
      bigMovers: false,
      highFunding: false,
      zeroFee: false,
      newHot: false,
    });
    if (prePresetVisibleRef.current) {
      setVisible(new Set(prePresetVisibleRef.current));
      prePresetVisibleRef.current = null;
    }
    if (prePresetSortRef.current) {
      userSortTriggerRef.current = true;
      setSortBy(prePresetSortRef.current.sortBy);
      setSortDir(prePresetSortRef.current.sortDir);
      prePresetSortRef.current = null;
    }
  };

  const activeFilterCount =
    effectiveManualFilters.length +
    Object.values(enabledPresets).filter(Boolean).length +
    (selectedSector !== "all" ? 1 : 0) +
    excludedSectors.size +
    (hideUsStocks ? 1 : 0) +
    (hideAllTradFi ? 1 : 0) +
    (watchOnly ? 1 : 0);

  const renderChartAndInspector = () => {
    if (!selectedSymbol) return null;
    const dispSym = toDisplaySymbol(exchange, selectedSymbol);
    const isStarred = watchlistKeys.has(toWatchKey(exchange, selectedSymbol));
    const currentIdx = rows.findIndex((r) => r.symbol === selectedSymbol);
    const chg24h = selectedRow?.changePct["1d"] ?? null;
    const chg15m = selectedRow?.changePct["15m"] ?? null;
    const f1h = selectedRow ? (selectedRow.fundingRate1h ?? selectedRow.funding / (selectedRow.fundingIntervalHours || 8)) : null;

    const chartHeightClass =
      dockMode === "dropdown"
        ? ""
        : chartWidthMode === "max" || dockMode === "top"
          ? showChartMatrix
            ? "h-[580px]"
            : "h-[700px]"
          : showChartMatrix
            ? "h-[490px] 2xl:h-[540px]"
            : "h-[640px] 2xl:h-[700px]";

    const dropdownChartHeightPx =
      dockMode === "dropdown"
        ? dropdownHeightMode === "tall"
          ? Math.max(540, Math.round((tableViewport.height || 760) * 0.82))
          : dropdownHeightMode === "medium"
            ? Math.max(440, Math.round((tableViewport.height || 720) * 0.65))
            : Math.max(
                320,
                Math.min(
                  740,
                  (tableViewport.height || 720) - (showChartMatrix ? 336 : 210),
                ),
              )
        : undefined;

    return (
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex flex-col overflow-hidden rounded-xl border border-cyan-500/35 bg-[#090b11] shadow-[0_14px_44px_rgba(0,0,0,0.75)]"
      >
        {/* Top Bar 1: Symbol Identity, Live Price, Stepper & Panel Controls */}
        <div className="border-b border-[#191d28] bg-gradient-to-r from-[#0e121c] via-[#0c0f18] to-[#0e121c] px-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            {/* Left: Prev/Next Stepper + Star + Avatar + Symbol + Live Price */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center overflow-hidden rounded-md border border-zinc-700/80 bg-[#080a0f]">
                <button
                  type="button"
                  onClick={() => stepSelectedSymbol(-1)}
                  disabled={currentIdx <= 0}
                  className="px-1.5 py-1 text-[10px] font-bold text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30"
                  title="Previous ticker in table (↑ / k)"
                >
                  ▲
                </button>
                <span className="border-x border-zinc-800 px-1.5 font-mono text-[10px] text-zinc-400">
                  {currentIdx >= 0 ? `#${currentIdx + 1}` : "—"}
                </span>
                <button
                  type="button"
                  onClick={() => stepSelectedSymbol(1)}
                  disabled={currentIdx < 0 || currentIdx >= rows.length - 1}
                  className="px-1.5 py-1 text-[10px] font-bold text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30"
                  title="Next ticker in table (↓ / j)"
                >
                  ▼
                </button>
              </div>

              <button
                type="button"
                onClick={() => toggleWatch(selectedSymbol)}
                className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold transition-all ${
                  isStarred
                    ? "border-amber-400/80 bg-amber-500/25 text-amber-200 shadow-[0_0_8px_rgba(251,191,36,0.25)] hover:bg-amber-500/35"
                    : "border-zinc-700 bg-[#141824] text-zinc-300 hover:border-amber-400/60 hover:bg-amber-500/15 hover:text-amber-200"
                }`}
                title={isStarred ? "Remove from Watchlist" : "Add to Watchlist / Pin"}
              >
                <svg
                  className="h-3.5 w-3.5"
                  viewBox="0 0 24 24"
                  fill={isStarred ? "currentColor" : "none"}
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
                <span>{isStarred ? "Starred" : "Star"}</span>
              </button>

              <div className="flex items-center gap-1.5">
                <TokenAvatar symbol={dispSym} iconUrl={selectedRow?.iconUrl} />
                <span className="text-base font-bold tracking-tight text-white">{dispSym}</span>
                <span className="rounded border border-zinc-700/80 bg-zinc-800/80 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-300">
                  {EXCHANGE_LABEL[exchange]}
                </span>
              </div>

              {selectedRow && (
                <div className="flex items-center gap-1.5 pl-1 font-mono">
                  <span className="text-base font-bold text-zinc-100">
                    ${formatPrice(selectedRow.price, selectedRow.priceScale)}
                  </span>
                  {chg24h !== null && (
                    <span
                      className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${
                        chg24h >= 0
                          ? "bg-emerald-500/15 text-[#3ee0a1] border border-emerald-500/30"
                          : "bg-rose-500/15 text-[#ff6b81] border border-rose-500/30"
                      }`}
                      title="24h Change %"
                    >
                      {formatPercent(chg24h)}
                    </span>
                  )}
                </div>
              )}

              {selectedRow?.maxLeverage && (
                <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-cyan-300">
                  {selectedRow.maxLeverage}x
                </span>
              )}
              {selectedRow?.isZeroFee && (
                <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300">
                  0% FEE
                </span>
              )}
            </div>

            {/* Right: Chart Placement Mode + Panel Size Presets + External Links + Close */}
            <div className="flex flex-wrap items-center gap-1.5">
              {/* Quick Chart Placement Mode Switcher (Dropdown vs Top vs Sidebar) */}
              <div
                className="flex items-center overflow-hidden rounded-md border border-zinc-700/80 bg-[#08090d] p-0.5"
                title="Switch how the chart opens: Inline Row Dropdown, Top Drawer, or Right Sidebar"
              >
                {(
                  [
                    { id: "dropdown", label: "▾ Row Dropdown" },
                    { id: "top", label: "⬒ Top Drawer" },
                    { id: "right", label: "◨ Sidebar" },
                  ] as const
                ).map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    onClick={() => setDockMode(mode.id)}
                    className={`rounded px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                      dockMode === mode.id
                        ? "bg-cyan-500/25 text-cyan-200 border border-cyan-500/50"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>

              {dockMode === "dropdown" && (
                <div
                  className="flex items-center overflow-hidden rounded-md border border-zinc-700/80 bg-[#08090d] p-0.5"
                  title="Dropdown chart height preset (Fit Screen automatically sizes the chart to fit your monitor height)"
                >
                  {(
                    [
                      { id: "fit", label: "Fit Screen" },
                      { id: "medium", label: "Medium" },
                      { id: "tall", label: "Tall" },
                    ] as const
                  ).map((hMode) => (
                    <button
                      key={hMode.id}
                      type="button"
                      onClick={() => setDropdownHeightMode(hMode.id)}
                      className={`rounded px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                        dropdownHeightMode === hMode.id
                          ? "bg-violet-500/25 text-violet-200 border border-violet-500/50"
                          : "text-zinc-400 hover:text-zinc-200"
                      }`}
                    >
                      {hMode.label}
                    </button>
                  ))}
                </div>
              )}

              {dockMode === "right" && (
                <div
                  className="flex items-center overflow-hidden rounded-md border border-zinc-700/80 bg-[#08090d] p-0.5"
                  title="Chart panel width"
                >
                  {(
                    [
                      { id: "std", label: "Compact" },
                      { id: "wide", label: "Wide" },
                      { id: "half", label: "50 / 50" },
                      { id: "max", label: "⛶ Max" },
                    ] as const
                  ).map((sz) => (
                    <button
                      key={sz.id}
                      type="button"
                      onClick={() => setChartWidthMode(sz.id)}
                      className={`rounded px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                        chartWidthMode === sz.id
                          ? "bg-violet-500/25 text-violet-200 border border-violet-500/50"
                          : "text-zinc-400 hover:text-zinc-200"
                      }`}
                    >
                      {sz.label}
                    </button>
                  ))}
                </div>
              )}
              <a
                href={toExchangeTradeUrl(exchange, selectedSymbol)}
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-emerald-500/50 bg-emerald-500/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-500/25"
              >
                Trade {EXCHANGE_LABEL[exchange]} ↗
              </a>
              <a
                href={toTradingViewChartUrl(exchange, selectedSymbol)}
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-zinc-700 bg-[#12151e] px-2 py-1 text-[11px] text-zinc-300 hover:border-zinc-500 hover:text-white"
                title="Open in full TradingView tab"
              >
                TV ↗
              </a>
              <button
                type="button"
                onClick={() => setSelectedSymbol(null)}
                className="inline-flex items-center gap-1 rounded-md border border-rose-500/60 bg-rose-500/20 px-3 py-1 text-[11px] font-bold text-rose-100 shadow-[0_0_10px_rgba(244,63,94,0.25)] hover:bg-rose-500/35"
                title="Close chart panel (Esc or click ticker row again)"
              >
                <span>✕</span>
                <span>Close Chart</span>
              </button>
            </div>
          </div>

          {/* Top Bar 2: Timeframes (1m, 5m, 15m, 1h, 4h, 1D), Chart Style, Studies & Feed Source */}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800/70 pt-2">
            {/* Timeframe Switcher */}
            <div className="flex flex-wrap items-center gap-1.5">
              <div className="flex items-center rounded-md border border-cyan-500/30 bg-[#07090e] p-0.5">
                <span className="px-1.5 text-[10px] font-semibold uppercase text-zinc-500">TF</span>
                {TV_INTERVALS.map((intv) => (
                  <button
                    key={intv.value}
                    type="button"
                    onClick={() => setTvInterval(intv.value)}
                    title={intv.title}
                    className={`rounded px-2.5 py-0.5 font-mono text-[11px] font-bold transition-all ${
                      tvInterval === intv.value
                        ? "bg-cyan-500/30 text-cyan-100 border border-cyan-400/70 shadow-[0_0_8px_rgba(34,211,238,0.25)]"
                        : "text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-100"
                    }`}
                  >
                    {intv.label}
                  </button>
                ))}
              </div>

              {/* Candle Type Switcher */}
              <div className="flex items-center rounded-md border border-zinc-800 bg-[#07090e] p-0.5">
                {(
                  [
                    { id: "1", label: "Candles" },
                    { id: "8", label: "Heikin" },
                    { id: "3", label: "Area" },
                  ] as const
                ).map((st) => (
                  <button
                    key={st.id}
                    type="button"
                    onClick={() => setTvStyle(st.id)}
                    className={`rounded px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                      tvStyle === st.id
                        ? "bg-zinc-700 text-zinc-100"
                        : "text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    {st.label}
                  </button>
                ))}
              </div>

              {/* 1-Click Indicator Overlays (Including MA36 & MA60 Manual Toggles) */}
              <div className="flex items-center gap-1 rounded-md border border-zinc-800 bg-[#07090e] p-0.5">
                <span className="px-1 text-[10px] font-semibold uppercase text-zinc-500">Indicators</span>
                {(
                  [
                    { id: "MA36", label: "MA 36", dotColor: "bg-[#f23645]" },
                    { id: "MA60", label: "MA 60", dotColor: "bg-[#a855f7]" },
                    { id: "BB@tv-basicstudies", label: "BB", dotColor: "" },
                    { id: "VWAP@tv-basicstudies", label: "VWAP", dotColor: "" },
                    { id: "RSI@tv-basicstudies", label: "RSI", dotColor: "" },
                    ...(chartEngine === "tv"
                      ? ([{ id: "MACD@tv-basicstudies", label: "MACD", dotColor: "" }] as const)
                      : []),
                  ] as const
                ).map((ind) => {
                  const active = tvStudies.has(ind.id);
                  return (
                    <button
                      key={ind.id}
                      type="button"
                      onClick={() => toggleTvStudy(ind.id)}
                      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold transition-colors ${
                        active
                          ? ind.id === "MA36"
                            ? "bg-[#f23645]/25 text-[#ff8a93] border border-[#f23645]/60"
                            : ind.id === "MA60"
                              ? "bg-[#a855f7]/25 text-[#d8b4fe] border border-[#a855f7]/60"
                              : "bg-emerald-500/25 text-emerald-200 border border-emerald-500/50"
                          : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                      }`}
                    >
                      {ind.dotColor && <span className={`h-1.5 w-1.5 rounded-full ${ind.dotColor}`} />}
                      <span>{ind.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Right: Chart Engine (% Crosshair vs TV Widget), Drawing Tools Toggle & TV Feed Source Fallback */}
            <div className="flex flex-wrap items-center gap-1.5">
              {/* Engine Toggle: Live % Crosshair Chart vs TradingView Embed */}
              <div
                className="flex items-center overflow-hidden rounded-md border border-cyan-500/40 bg-[#07090e] p-0.5"
                title="Switch between Live % Crosshair Chart (shows exact +10% / -10% cursor distance on price scale) and Classic TradingView Widget"
              >
                <button
                  type="button"
                  onClick={() => setChartEngine("pro")}
                  className={`rounded px-2 py-0.5 text-[10px] font-bold transition-colors ${
                    chartEngine === "pro"
                      ? "bg-cyan-500/25 text-cyan-100 border border-cyan-400/60"
                      : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  ⚡ % Crosshair Chart
                </button>
                <button
                  type="button"
                  onClick={() => setChartEngine("tv")}
                  className={`rounded px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                    chartEngine === "tv"
                      ? "bg-cyan-500/25 text-cyan-100 border border-cyan-400/60"
                      : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  📺 TV Widget
                </button>
              </div>

              {chartEngine === "tv" && (
                <>
                  <button
                    type="button"
                    onClick={() => setTvShowDrawingTools((v) => !v)}
                    className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                      tvShowDrawingTools
                        ? "border-cyan-500/40 bg-cyan-500/15 text-cyan-200"
                        : "border-zinc-800 bg-[#07090e] text-zinc-500 hover:text-zinc-300"
                    }`}
                    title="Show / hide left drawing tools bar inside TradingView"
                  >
                    ✏️ Draw Tools
                  </button>

                  <div
                    className="flex items-center rounded-md border border-zinc-800 bg-[#07090e] px-1.5 py-0.5 text-[10px]"
                    title="Switch TradingView chart data source if a newly listed perpetual is not yet indexed on TV"
                  >
                    <span className="mr-1 text-zinc-500">Feed:</span>
                    <select
                      value={tvFeedOverride}
                      onChange={(e) =>
                        setTvFeedOverride(e.target.value as "auto" | "mexc_spot" | "bybit" | "binance")
                      }
                      className="bg-transparent font-semibold text-zinc-200 outline-none"
                    >
                      <option value="auto" className="bg-[#0c0e14]">
                        Auto ({tv?.prefix}:{tv?.symbol})
                      </option>
                      <option value="mexc_spot" className="bg-[#0c0e14]">
                        MEXC Spot ({dispSym}USDT)
                      </option>
                      <option value="bybit" className="bg-[#0c0e14]">
                        Bybit Perp ({dispSym}USDT.P)
                      </option>
                      <option value="binance" className="bg-[#0c0e14]">
                        Binance Perp ({dispSym}USDT.P)
                      </option>
                    </select>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Compact Single-Line Microstructure Telemetry Strip */}
          {selectedRow && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800/90 bg-[#07090e] px-2.5 py-1.5 font-mono text-[11px]">
              <div className="flex items-center gap-1.5">
                <span className="font-sans text-[10px] text-zinc-500">OI:</span>
                <span className="font-semibold text-violet-300">
                  {selectedRow.oiUsd ? `$${formatNumber(selectedRow.oiUsd)}` : "—"}
                </span>
                {selectedRow.oiToMcapPct ? (
                  <span className="text-[10px] text-amber-300/90" title="OI / Market Cap %">
                    ({selectedRow.oiToMcapPct.toFixed(1)}% MC)
                  </span>
                ) : null}
              </div>

              <div className="h-3 w-px bg-zinc-800" />

              <div className="flex items-center gap-1.5">
                <span className="font-sans text-[10px] text-zinc-500">Fund/h:</span>
                <span className={`font-semibold ${colorForSigned((f1h ?? 0) * 100)}`}>
                  {f1h !== null ? formatFundingPerHour(f1h) : "—"}
                </span>
                <span className="text-zinc-600">/</span>
                <span className="font-sans text-[10px] text-zinc-500">Basis:</span>
                <span className={`font-semibold ${colorForSigned(selectedRow.basisPct)}`}>
                  {selectedRow.basisPct !== null && selectedRow.basisPct !== undefined
                    ? `${selectedRow.basisPct >= 0 ? "+" : ""}${selectedRow.basisPct.toFixed(2)}%`
                    : "—"}
                </span>
              </div>

              <div className="h-3 w-px bg-zinc-800" />

              <div className="flex items-center gap-1.5">
                <span className="font-sans text-[10px] text-zinc-500">24h Vol:</span>
                <span className="font-semibold text-zinc-200">${formatNumber(selectedRow.volume["1d"])}</span>
                {selectedRow.rvol !== null && (
                  <span
                    className={`rounded px-1 py-0.2 text-[10px] font-bold ${
                      selectedRow.rvol >= 2 ? "bg-amber-500/20 text-amber-300" : "bg-cyan-500/15 text-cyan-300"
                    }`}
                  >
                    {selectedRow.rvol.toFixed(2)}x RVOL
                  </span>
                )}
              </div>

              <div className="h-3 w-px bg-zinc-800" />

              <div className="flex items-center gap-1.5">
                <span className="font-sans text-[10px] text-zinc-500">15m:</span>
                <span className={`font-semibold ${colorForSigned(chg15m)}`}>{formatPercent(chg15m)}</span>
              </div>

              <div className="h-3 w-px bg-zinc-800" />

              <div className="flex items-center gap-1.5">
                <span className="font-sans text-[10px] text-zinc-500">24h Range:</span>
                <div className="h-1.5 w-14 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-rose-500 via-amber-400 to-emerald-400"
                    style={{ width: `${Math.max(4, Math.min(100, selectedRow.rangePos24h ?? 50))}%` }}
                  />
                </div>
                <span className="text-[10px] font-semibold text-zinc-200">
                  {selectedRow.rangePos24h !== null && selectedRow.rangePos24h !== undefined
                    ? `${selectedRow.rangePos24h.toFixed(0)}%`
                    : "—"}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Chart Canvas: Live % Crosshair Chart (Default) or Classic TradingView Embed */}
        <div
          className={`${chartHeightClass} w-full bg-[#07090e] transition-all`}
          style={dropdownChartHeightPx ? { height: `${dropdownChartHeightPx}px` } : undefined}
        >
          {chartEngine === "pro" ? (
            <PerpChart
              exchange={exchange}
              symbol={selectedSymbol}
              displaySymbol={dispSym}
              interval={tvInterval}
              chartStyle={tvStyle === "8" ? "8" : tvStyle === "3" ? "3" : "1"}
              livePrice={selectedRow?.price ?? null}
              priceScale={selectedRow?.priceScale}
              studies={tvStudies}
              onToggleStudy={toggleTvStudy}
            />
          ) : (
            <iframe
              key={`${exchange}:${selectedSymbol}:${tv?.prefix}:${tv?.symbol}:${tvInterval}:${tvStyle}:${tvShowDrawingTools}:${Array.from(tvStudies).join(",")}`}
              title={`TradingView ${selectedSymbol}`}
              src={chartSrc}
              className="h-full w-full border-0"
              allow="clipboard-write; fullscreen"
            />
          )}
        </div>

        {/* Collapsible Multi-Timeframe Horizon Matrix for Selected Coin */}
        {selectedRow && (
          <div className="border-t border-[#191d28] bg-[#0a0c12]">
            <div className="flex items-center justify-between px-3 py-1.5 text-[10px] text-zinc-400">
              <button
                type="button"
                onClick={() => setShowChartMatrix((v) => !v)}
                className="flex items-center gap-1.5 font-semibold uppercase tracking-wider text-zinc-300 hover:text-cyan-300"
              >
                <span>{showChartMatrix ? "▼" : "▲"}</span>
                <span>Multi-Timeframe Orderflow Matrix ({dispSym})</span>
                <span className="font-normal text-zinc-500">
                  {showChartMatrix ? "(Click to collapse & expand chart)" : "(Click to expand 5m–1d metrics)"}
                </span>
              </button>
              {selectedRow.sectors && selectedRow.sectors.length > 0 && (
                <div className="flex gap-1">
                  {selectedRow.sectors.slice(0, 4).map((sec) => (
                    <span key={sec} className="rounded bg-zinc-800/90 px-1.5 py-0.5 text-[9px] uppercase text-zinc-400">
                      {sec}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {showChartMatrix && (
              <div className="overflow-x-auto border-t border-zinc-800/70 px-2 pb-2 pt-1">
                <table className="w-full font-mono text-[11px] tabular-nums">
                  <thead>
                    <tr className="border-b border-zinc-800/80 text-right font-sans text-[10px] text-zinc-500">
                      <th className="py-1 text-left font-semibold uppercase">Metric</th>
                      {TIMEFRAMES.map((tf) => (
                        <th key={tf} className="px-1.5 py-1 font-semibold uppercase text-zinc-400">
                          {tf}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-900/60">
                    <tr>
                      <td className="py-1 text-left font-sans text-zinc-400">Chg %</td>
                      {TIMEFRAMES.map((tf) => {
                        const v = selectedRow.changePct[tf];
                        const k = `changePct:${tf}`;
                        return (
                          <td
                            key={tf}
                            onClick={() => handleSort(k)}
                            title={`Click to sort table by Chg % ${tf} (${sortBy === k && sortDir === "desc" ? "Ascending" : "Descending"})`}
                            className={`cursor-pointer px-1.5 py-1 text-right font-medium hover:bg-zinc-800/60 ${colorForSigned(v)} ${heatBgForPct(v)} ${
                              sortBy === k ? "underline decoration-cyan-400" : ""
                            }`}
                          >
                            {formatPercent(v)}
                          </td>
                        );
                      })}
                    </tr>
                    <tr>
                      <td className="py-1 text-left font-sans text-zinc-400">OI Chg %</td>
                      {TIMEFRAMES.map((tf) => {
                        const v = selectedRow.oiChangePct[tf];
                        const k = `oiChangePct:${tf}`;
                        return (
                          <td
                            key={tf}
                            onClick={() => handleSort(k)}
                            title={`Click to sort table by OI Chg % ${tf} (${sortBy === k && sortDir === "desc" ? "Ascending" : "Descending"})`}
                            className={`cursor-pointer px-1.5 py-1 text-right font-medium hover:bg-zinc-800/60 ${colorForSigned(v)} ${heatBgForPct(v)} ${
                              sortBy === k ? "underline decoration-cyan-400" : ""
                            }`}
                          >
                            {formatPercent(v)}
                          </td>
                        );
                      })}
                    </tr>
                    <tr>
                      <td className="py-1 text-left font-sans text-zinc-400">VDelta $</td>
                      {TIMEFRAMES.map((tf) => {
                        const v = selectedRow.cvd[tf];
                        const k = `cvd:${tf}`;
                        return (
                          <td
                            key={tf}
                            onClick={() => handleSort(k)}
                            title={`Click to sort table by VDelta $ ${tf} (${sortBy === k && sortDir === "desc" ? "Ascending" : "Descending"})`}
                            className={`cursor-pointer px-1.5 py-1 text-right hover:bg-zinc-800/60 ${colorForSigned(v)} ${
                              sortBy === k ? "underline decoration-cyan-400" : ""
                            }`}
                          >
                            {v === null ? "-" : `${v >= 0 ? "+" : ""}$${formatNumber(v, 1)}`}
                          </td>
                        );
                      })}
                    </tr>
                    <tr>
                      <td className="py-1 text-left font-sans text-zinc-400">Vol $</td>
                      {TIMEFRAMES.map((tf) => {
                        const v = selectedRow.volume[tf];
                        const k = `volume:${tf}`;
                        return (
                          <td
                            key={tf}
                            onClick={() => handleSort(k)}
                            title={`Click to sort table by Vol $ ${tf} (${sortBy === k && sortDir === "desc" ? "Ascending" : "Descending"})`}
                            className={`cursor-pointer px-1.5 py-1 text-right text-zinc-300 hover:bg-zinc-800/60 ${
                              sortBy === k ? "underline decoration-cyan-400" : ""
                            }`}
                          >
                            {v === null ? "-" : `$${formatNumber(v, 1)}`}
                          </td>
                        );
                      })}
                    </tr>
                    <tr>
                      <td className="py-1 text-left font-sans text-zinc-400">Volatility</td>
                      {TIMEFRAMES.map((tf) => {
                        const v = selectedRow.volatility[tf];
                        const k = `volatility:${tf}`;
                        return (
                          <td
                            key={tf}
                            onClick={() => handleSort(k)}
                            title={`Click to sort table by Volatility ${tf} (${sortBy === k && sortDir === "desc" ? "Ascending" : "Descending"})`}
                            className={`cursor-pointer px-1.5 py-1 text-right text-zinc-400 hover:bg-zinc-800/60 ${
                              sortBy === k ? "underline decoration-cyan-400" : ""
                            }`}
                          >
                            {v === null ? "-" : v < 0.1 && v > 0 ? `${v.toFixed(3)}%` : `${v.toFixed(2)}%`}
                          </td>
                        );
                      })}
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="min-h-screen w-full max-w-[100vw] overflow-x-hidden bg-[#07080c] text-zinc-200">
      <div className="w-full max-w-full px-2.5 py-2 sm:px-3.5">
        {/* Top Terminal Bar */}
        <header className="sticky top-0 z-40 rounded-xl border border-[#1a2030] bg-gradient-to-b from-[#0e111a]/98 to-[#0a0c12]/98 px-3 py-2 shadow-[0_8px_30px_rgba(0,0,0,0.55)] backdrop-blur-md">
          {/* TIER 1: Brand & Live Status (Left) | Exchange Switcher (Center) | Navigation & Chart Dock (Right) */}
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            {/* Brand + Status + Telemetry */}
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#232a3d] bg-[#111522] shadow-inner">
                <ExchangeBadgeIcon exchange={exchange} size="md" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-[15px] font-bold tracking-tight text-zinc-100">
                    {EXCHANGE_LABEL[exchange]} <span className="font-semibold text-zinc-400">Screener</span>
                  </h1>
                  <button
                    onClick={() => setWsEnabled((v) => !v)}
                    className={`inline-flex h-5 items-center gap-1.5 rounded-full border px-2 text-[10px] font-semibold tracking-wide transition-colors ${
                      wsConnected
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 shadow-[0_0_10px_rgba(16,185,129,0.15)]"
                        : "border-zinc-700/80 bg-zinc-800/60 text-zinc-400"
                    }`}
                    title={`Toggle real-time ${EXCHANGE_LABEL[exchange]} WebSocket stream`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        wsConnected ? "animate-pulse bg-emerald-400" : "bg-zinc-500"
                      }`}
                    />
                    {wsConnected ? "WS LIVE" : wsEnabled ? "CONNECTING" : "PAUSED"}
                  </button>
                  <button
                    onClick={() => void fetchScreenerData(selectedSymbol ? [selectedSymbol] : [])}
                    disabled={refreshing}
                    className="inline-flex h-5 items-center gap-1 rounded-full border border-[#232a3b] bg-[#121622] px-2 text-[10px] font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:text-white disabled:opacity-50"
                    title="Force refresh kline & ticker metrics"
                  >
                    <span className={refreshing ? "animate-spin" : ""}>↻</span>
                    <span>{refreshing ? "Syncing" : "Sync"}</span>
                  </button>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10.5px] text-zinc-500">
                  <span>
                    <strong className="font-semibold text-zinc-300">{rows.length}</strong>
                    <span className="text-zinc-600">/</span>
                    {data?.totalContracts ?? data?.rows.length ?? 0} pairs
                  </span>
                  <span className="text-zinc-700">•</span>
                  <span>{data?.klineSymbolsCount ?? 0} multi-TF</span>
                  {data?.oiHistoryMinutes ? (
                    <>
                      <span className="text-zinc-700">•</span>
                      <span>OI {data.oiHistoryMinutes}m</span>
                    </>
                  ) : null}
                  <span className="text-zinc-700">•</span>
                  <span className="font-mono text-[10px] text-zinc-400">
                    {mounted && data ? new Date(data.asOf).toLocaleTimeString() : "--:--:--"}
                  </span>
                  {quality === "fast" && (
                    <span className="rounded bg-cyan-500/10 px-1.5 py-px text-[9.5px] font-medium text-cyan-300">
                      enriching...
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Center: Orion Exchange Switcher */}
            <div className="flex items-center gap-1 rounded-xl border border-[#22283a] bg-[#07090e] p-1 shadow-[inset_0_1px_3px_rgba(0,0,0,0.7)]">
              {(["mexc", "bybit", "binance", "hyperliquid"] as ExchangeId[]).map((ex) => {
                const isActive = exchange === ex;
                const activeStyle =
                  ex === "mexc"
                    ? "border-[#2998ff]/50 bg-gradient-to-b from-[#162542] to-[#0e172a] text-white shadow-[0_0_12px_rgba(41,152,255,0.25)]"
                    : ex === "bybit"
                      ? "border-[#f7a600]/50 bg-gradient-to-b from-[#2b2110] to-[#17120a] text-white shadow-[0_0_12px_rgba(247,166,0,0.2)]"
                      : ex === "binance"
                        ? "border-[#f0b90b]/50 bg-gradient-to-b from-[#29220e] to-[#171308] text-white shadow-[0_0_12px_rgba(240,185,11,0.2)]"
                        : "border-[#50e3c2]/50 bg-gradient-to-b from-[#0e2b25] to-[#081916] text-white shadow-[0_0_12px_rgba(80,227,194,0.22)]";
                return (
                  <Link
                    key={ex}
                    href={exchangePath(ex)}
                    className={`inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold tracking-tight transition-all ${
                      isActive
                        ? activeStyle
                        : "border-transparent text-zinc-400 hover:bg-[#111520] hover:text-zinc-100"
                    }`}
                  >
                    <ExchangeBadgeIcon exchange={ex} />
                    <span>{EXCHANGE_LABEL[ex]}</span>
                  </Link>
                );
              })}
            </div>

            {/* Right: Grouped Page Views + Chart Layout Switcher */}
            <div className="flex flex-wrap items-center gap-1.5">
              <nav className="flex items-center gap-0.5 rounded-lg border border-[#1e2434] bg-[#07090e] p-0.5 text-[11px]">
                <Link
                  href="/screener/performers"
                  className="inline-flex h-6 items-center rounded-md px-2 font-medium text-zinc-300 transition-colors hover:bg-[#141926] hover:text-white"
                >
                  Performers
                </Link>
                <Link
                  href={exchangeSpaghettiPath(exchange, "price")}
                  className="inline-flex h-6 items-center rounded-md px-2 font-medium text-zinc-300 transition-colors hover:bg-[#141926] hover:text-white"
                >
                  Price Spag
                </Link>
                <Link
                  href={exchangeSpaghettiPath(exchange, "volume")}
                  className="inline-flex h-6 items-center rounded-md px-2 font-medium text-zinc-300 transition-colors hover:bg-[#141926] hover:text-white"
                >
                  Vol Spag
                </Link>
                <Link
                  href="/screener/watchlist"
                  className="inline-flex h-6 items-center gap-1 rounded-md px-2 font-medium text-zinc-300 transition-colors hover:bg-[#141926] hover:text-amber-300"
                >
                  <span className="text-amber-400">★</span>
                  <span>Watchlist</span>
                  <span className="rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">{watchlistKeys.size}</span>
                </Link>
                <Link
                  href="/screener/journal"
                  className="inline-flex h-6 items-center rounded-md px-2 font-medium text-zinc-300 transition-colors hover:bg-[#141926] hover:text-white"
                >
                  Journal
                </Link>
              </nav>

              {/* Layout Dock Switcher */}
              <div
                className="flex items-center rounded-lg border border-[#1e2434] bg-[#07090e] p-0.5"
                title="Choose how clicking a ticker opens the chart"
              >
                <span className="px-1.5 text-[9.5px] font-bold uppercase tracking-wider text-zinc-500">Chart</span>
                {(
                  [
                    { id: "dropdown", label: "▾ Dropdown", tip: "Open chart inline as a dropdown directly under the clicked ticker row" },
                    { id: "top", label: "⬒ Top", tip: "Open chart in a full-width collapsible drawer above the table" },
                    { id: "right", label: "◨ Sidebar", tip: "Open chart in a right-hand split sidebar" },
                    { id: "hidden", label: "✕ Off", tip: "Close chart and keep table only" },
                  ] as { id: DockMode; label: string; tip: string }[]
                ).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    title={m.tip}
                    onClick={() => {
                      if (m.id === "hidden") {
                        setSelectedSymbol(null);
                      }
                      setDockMode(m.id);
                    }}
                    className={`h-6 rounded-md px-2 text-[11px] font-medium transition-all ${
                      dockMode === m.id
                        ? "border border-cyan-500/40 bg-cyan-500/15 text-cyan-200 shadow-[0_0_8px_rgba(6,182,212,0.15)]"
                        : "border border-transparent text-zinc-500 hover:text-zinc-200"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              {selectedSymbol && (
                <button
                  type="button"
                  onClick={() => setSelectedSymbol(null)}
                  className="inline-flex h-7 items-center gap-1 rounded-lg border border-rose-500/50 bg-rose-500/15 px-2.5 text-[11px] font-semibold text-rose-200 shadow-[0_0_10px_rgba(244,63,94,0.2)] hover:bg-rose-500/30"
                  title="Close open chart (Esc)"
                >
                  <span>✕ {toDisplaySymbol(exchange, selectedSymbol)}</span>
                </button>
              )}
            </div>
          </div>

          {/* TIER 2: Search, Exclusions & Asset/Watch Filters (Left) | Sort, Scope, Filters, Columns & Alerts (Right) */}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-[#181d2a] pt-2">
            {/* Left: Unified Search Capsule + Asset/Watchlist Toggles */}
            <div className="flex flex-wrap items-center gap-1.5">
              {/* Unified Search & Exclude Bar */}
              <div className="flex h-7 items-center rounded-lg border border-[#202637] bg-[#07090e] px-2 focus-within:border-cyan-500/60">
                <svg className="mr-1.5 h-3.5 w-3.5 shrink-0 text-zinc-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
                <div className="relative flex items-center">
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search symbols..."
                    className="w-32 bg-transparent text-xs text-zinc-100 outline-none placeholder:text-zinc-500 sm:w-36"
                  />
                  {query && (
                    <button
                      onClick={() => setQuery("")}
                      className="ml-1 text-xs text-zinc-500 hover:text-zinc-200"
                      title="Clear search"
                    >
                      ×
                    </button>
                  )}
                </div>
                <span className="mx-2 h-3.5 w-px bg-[#1e2434]" />
                <span className="mr-1 text-[10px] font-medium text-zinc-500">Hide:</span>
                <input
                  value={excludedSymbolsInput}
                  onChange={(e) => setExcludedSymbolsInput(e.target.value)}
                  placeholder="BTC,ETH"
                  className="w-20 bg-transparent text-xs text-zinc-200 outline-none placeholder:text-zinc-600"
                  title="Comma-separated symbols to hide"
                />
                <span className="mx-2 h-3.5 w-px bg-[#1e2434]" />
                <span className="mr-1 text-[10px] font-medium text-zinc-500">Excl:</span>
                <input
                  value={excludedKeywordsInput}
                  onChange={(e) => setExcludedKeywordsInput(e.target.value)}
                  placeholder="1000"
                  className="w-14 bg-transparent text-xs text-zinc-200 outline-none placeholder:text-zinc-600"
                  title="Exclude symbols matching substring"
                />
              </div>

              {/* 1-Click Turn Off US Stocks & TradFi Toggles */}
              {usStockCount > 0 && (
                <button
                  type="button"
                  onClick={() => setHideUsStocks((v) => !v)}
                  className={`inline-flex h-7 items-center gap-1 rounded-lg border px-2.5 text-[11px] font-semibold transition-all ${
                    hideUsStocks
                      ? "border-rose-400/70 bg-rose-500/15 text-rose-200 shadow-[0_0_8px_rgba(244,63,94,0.15)]"
                      : "border-[#202637] bg-[#101420] text-zinc-300 hover:border-rose-400/50 hover:text-rose-200"
                  }`}
                  title="Turn OFF US Stocks, Stock Indices & ETFs from the screener"
                >
                  <span>{hideUsStocks ? "🚫 US Stocks: OFF" : "🇺🇸 Hide US Stocks"}</span>
                  <span className="text-[10px] opacity-70">({usStockCount})</span>
                </button>
              )}

              {tradFiCount > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setHideAllTradFi((v) => {
                      const next = !v;
                      if (next) setHideUsStocks(true);
                      return next;
                    });
                  }}
                  className={`inline-flex h-7 items-center gap-1 rounded-lg border px-2.5 text-[11px] font-semibold transition-all ${
                    hideAllTradFi
                      ? "border-emerald-400/70 bg-emerald-500/15 text-emerald-200 shadow-[0_0_8px_rgba(16,185,129,0.15)]"
                      : "border-[#202637] bg-[#101420] text-zinc-300 hover:border-emerald-400/50 hover:text-emerald-200"
                  }`}
                  title="Pure Crypto Only — Turn OFF all Stocks, Indices, ETFs, Forex, Commodities & Metals"
                >
                  <span>{hideAllTradFi ? "⚡ Pure Crypto Only" : "🚫 Hide All TradFi"}</span>
                  <span className="text-[10px] opacity-70">({tradFiCount})</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => setWatchOnly((v) => !v)}
                className={`inline-flex h-7 items-center gap-1 rounded-lg border px-2.5 text-[11px] font-semibold transition-all ${
                  watchOnly
                    ? "border-amber-400/70 bg-amber-500/15 text-amber-200 shadow-[0_0_8px_rgba(251,191,36,0.15)]"
                    : "border-[#202637] bg-[#101420] text-zinc-300 hover:border-amber-400/50 hover:text-amber-200"
                }`}
                title="Show only your starred / watched contracts"
              >
                <span className="text-amber-400">★</span>
                <span>Watch Only</span>
              </button>

              <button
                type="button"
                onClick={() => setPinWatchedFirst((v) => !v)}
                className={`inline-flex h-7 items-center gap-1 rounded-lg border px-2.5 text-[11px] font-semibold transition-all ${
                  pinWatchedFirst
                    ? "border-amber-400/70 bg-amber-500/15 text-amber-200 shadow-[0_0_8px_rgba(251,191,36,0.15)]"
                    : "border-[#202637] bg-[#101420] text-zinc-300 hover:border-amber-400/50 hover:text-amber-200"
                }`}
                title="Pin starred / watched contracts to the top of the table while keeping active sort order"
              >
                <span>📌</span>
                <span>Pin Starred</span>
              </button>

              {availableSectors.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowCategoryBar((v) => !v)}
                  className={`inline-flex h-7 items-center gap-1 rounded-lg border px-2.5 text-[11px] font-medium transition-colors ${
                    showCategoryBar || excludedSectors.size > 0 || selectedSector !== "all"
                      ? "border-cyan-500/50 bg-cyan-500/15 text-cyan-200"
                      : "border-[#202637] bg-[#101420] text-zinc-400 hover:text-zinc-200"
                  }`}
                  title="Show or hide the Categories / Sectors filter bar"
                >
                  <span>🏷️ Categories</span>
                  {excludedSectors.size > 0 && (
                    <span className="rounded bg-rose-500/30 px-1 text-[10px] font-bold text-rose-200">
                      -{excludedSectors.size}
                    </span>
                  )}
                </button>
              )}

              {activeFilterCount > 0 && (
                <button
                  onClick={clearAllFilters}
                  className="inline-flex h-7 items-center gap-1 rounded-lg border border-rose-500/40 bg-rose-500/15 px-2.5 text-[11px] font-semibold text-rose-200 hover:bg-rose-500/25"
                >
                  <span>↺ Reset ({activeFilterCount})</span>
                </button>
              )}
            </div>

            {/* Right: Sort, Scope, Filters, Columns, Alerts */}
            <div className="flex flex-wrap items-center gap-1.5">
              {/* Quick Sort Field + Explicit Ascending / Descending Toggle */}
              <div className="flex h-7 items-center rounded-lg border border-[#202637] bg-[#07090e] p-0.5 text-[11px]">
                <span className="px-1.5 text-[9.5px] font-bold uppercase tracking-wider text-zinc-500">Sort</span>
                <select
                  value={sortBy}
                  onChange={(e) => handleSort(e.target.value, e.target.value === "symbol" ? "asc" : sortDir)}
                  className="h-6 rounded-md bg-[#111522] px-1.5 text-[11px] font-semibold text-cyan-200 outline-none"
                  title="Choose column to sort by"
                >
                  <option value="symbol">Symbol (A-Z)</option>
                  {FILTER_FIELD_OPTIONS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => handleSort(sortBy, "desc")}
                  className={`ml-0.5 h-6 rounded-md px-1.5 text-[10px] font-bold transition-colors ${
                    sortDir === "desc"
                      ? "border border-cyan-500/50 bg-cyan-500/20 text-cyan-200"
                      : "text-zinc-500 hover:text-zinc-200"
                  }`}
                  title="Sort Descending (High → Low / Top Gainers)"
                >
                  ▼ Desc
                </button>
                <button
                  type="button"
                  onClick={() => handleSort(sortBy, "asc")}
                  className={`h-6 rounded-md px-1.5 text-[10px] font-bold transition-colors ${
                    sortDir === "asc"
                      ? "border border-amber-500/50 bg-amber-500/20 text-amber-200"
                      : "text-zinc-500 hover:text-zinc-200"
                  }`}
                  title="Sort Ascending (Low → High / Top Losers)"
                >
                  ▲ Asc
                </button>
              </div>

              <button
                onClick={() => setScopeMode((m) => (m === "active" ? "all" : "active"))}
                className={`h-7 rounded-lg border px-2.5 text-[11px] font-semibold transition-colors ${
                  scopeMode === "all"
                    ? "border-purple-500/50 bg-purple-500/15 text-purple-200"
                    : "border-[#202637] bg-[#101420] text-zinc-400 hover:text-zinc-200"
                }`}
                title="Switch between Active coins vs All exchange contracts"
              >
                {scopeMode === "all" ? `All (${data?.rows.length ?? 0})` : `Active (${rows.length})`}
              </button>

              {/* Orion Filter Button (Funnel Icon) */}
              <button
                onClick={() => setShowFilters((v) => !v)}
                className={`inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium transition-colors ${
                  showFilters || effectiveManualFilters.length > 0
                    ? "border-cyan-500/50 bg-cyan-500/15 text-cyan-200"
                    : "border-[#202637] bg-[#101420] text-zinc-300 hover:border-zinc-600 hover:text-white"
                }`}
                title="Custom Filter Builder & Preset Thresholds"
              >
                <svg className="h-3.5 w-3.5 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                </svg>
                <span>Filters{effectiveManualFilters.length > 0 ? ` (${effectiveManualFilters.length})` : ""}</span>
              </button>

              {/* Orion Column Visibility Button (||| Icon) */}
              <button
                onClick={() => setShowColumns(true)}
                className={`inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium transition-colors ${
                  showColumns
                    ? "border-cyan-500/50 bg-cyan-500/15 text-cyan-200"
                    : "border-[#202637] bg-[#101420] text-zinc-300 hover:border-zinc-600 hover:text-white"
                }`}
                title="Column Visibility (|||)"
              >
                <svg className="h-3.5 w-3.5 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 3v18M6 3v18M18 3v18" />
                </svg>
                <span>Columns ({visibleColumns.length + (showSparkline ? 1 : 0)})</span>
              </button>

              {/* Orion Real-Time Alerts Button (🔔 Icon) + Quick Mute Toggle */}
              <div className="inline-flex h-7 items-center overflow-hidden rounded-lg border border-[#202637] bg-[#101420]">
                <button
                  type="button"
                  onClick={() => setShowAlerts(true)}
                  className={`relative inline-flex h-full items-center gap-1 px-2.5 text-[11px] font-medium transition-colors ${
                    showAlerts || alertEvents.length > 0
                      ? "bg-amber-500/15 text-amber-300"
                      : "text-zinc-300 hover:text-white"
                  }`}
                  title="Open Real-Time Condition Alerts Drawer"
                >
                  <span>🔔</span>
                  <span>Alerts</span>
                  {alertEvents.length > 0 && (
                    <span className="ml-0.5 rounded-full bg-amber-500/30 px-1.5 text-[10px] font-bold text-amber-200">
                      {alertEvents.length}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setSoundEnabled((v) => !v)}
                  className={`inline-flex h-full items-center border-l border-[#202637] px-2 text-[11px] font-semibold transition-colors ${
                    soundEnabled
                      ? "bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30"
                      : "bg-[#090b10] text-zinc-500 hover:text-zinc-300"
                  }`}
                  title={soundEnabled ? "Alert sound is ON — Click to mute" : "Alert sound is OFF (Muted by default) — Click to enable sound"}
                >
                  {soundEnabled ? "🔊" : "🔇"}
                </button>
              </div>
            </div>
          </div>

          {/* TIER 3: Quick Alpha Scanners (Left) | Live Exchange Market Pulse Strip (Right) */}
          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 border-t border-[#181d2a]/80 pt-1.5">
            {/* Left: Quick Scanner Presets */}
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-1 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                <span className="text-cyan-400">⚡</span> Scanners:
              </span>
              {(
                [
                  { id: "highVolume", label: "High Volume" },
                  { id: "oiSpike", label: "OI Spike" },
                  { id: "bigMovers", label: "Big Movers" },
                  { id: "highFunding", label: "High Funding" },
                  { id: "pumpAlert", label: "🔥 Pump" },
                  { id: "shortSqueeze", label: "🧲 Squeeze" },
                  ...(exchange === "mexc"
                    ? ([
                        { id: "zeroFee", label: "🆓 0-Fee" },
                        { id: "newHot", label: "🆕 New/Hot" },
                      ] as const)
                    : []),
                ] as { id: PresetId; label: string }[]
              ).map((p) => (
                <button
                  key={p.id}
                  onClick={() => togglePreset(p.id)}
                  className={`h-6 rounded-md border px-2.5 text-[11px] font-medium transition-all ${
                    enabledPresets[p.id]
                      ? "border-cyan-400/70 bg-cyan-500/20 text-cyan-100 shadow-[0_0_10px_rgba(34,211,238,0.18)]"
                      : "border-[#1c2232] bg-[#0b0e16] text-zinc-400 hover:border-zinc-700 hover:bg-[#121622] hover:text-zinc-200"
                  }`}
                >
                  {p.label}
                </button>
              ))}

              {/* User Saved Filter Presets */}
              {savedFilterPresets.map((sp) => (
                <div key={sp.id} className="inline-flex h-6 items-center rounded-md border border-purple-500/40 bg-purple-500/10">
                  <button
                    onClick={() => applySavedFilterPreset(sp)}
                    className="px-2 text-[11px] font-medium text-purple-200 hover:text-white"
                    title="Apply saved filter preset"
                  >
                    ★ {sp.name}
                  </button>
                  <button
                    onClick={() => deleteSavedFilterPreset(sp.id)}
                    className="pr-1.5 text-[11px] text-purple-400 hover:text-rose-300"
                    title="Delete preset"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            {/* Right: Live Exchange Market Pulse & Breadth Strip */}
            {marketPulse && (
              <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
                <div className="flex h-6 items-center gap-1.5 rounded-md border border-[#1c2232] bg-[#080a10] px-2">
                  <span className="font-sans text-[10px] font-medium text-zinc-500">24h Vol</span>
                  <span className="font-semibold text-zinc-200">${formatNumber(marketPulse.totalVol24h)}</span>
                </div>
                <div className="flex h-6 items-center gap-1.5 rounded-md border border-[#1c2232] bg-[#080a10] px-2">
                  <span className="font-sans text-[10px] font-medium text-zinc-500">Total OI</span>
                  <span className="font-semibold text-violet-300">${formatNumber(marketPulse.totalOiUsd)}</span>
                </div>
                <div
                  className="flex h-6 items-center gap-1.5 rounded-md border border-[#1c2232] bg-[#080a10] px-2"
                  title={`${marketPulse.bullCount} advancing vs ${marketPulse.bearCount} declining contracts (24h)`}
                >
                  <span className="font-sans text-[10px] font-medium text-zinc-500">Breadth</span>
                  <div className="flex h-1.5 w-12 overflow-hidden rounded-full bg-rose-500/40">
                    <div
                      className="h-full bg-emerald-400"
                      style={{ width: `${marketPulse.bullPct}%` }}
                    />
                  </div>
                  <span className="text-[10px] font-semibold text-emerald-400">{marketPulse.bullCount}↑</span>
                  <span className="text-[10px] font-semibold text-rose-400">{marketPulse.bearCount}↓</span>
                </div>
                {marketPulse.top5mGainer && (
                  <button
                    type="button"
                    onClick={() => setSelectedSymbol(marketPulse.top5mGainer!.symbol)}
                    className="flex h-6 items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 text-[10px] transition-colors hover:border-emerald-400/60 hover:bg-emerald-500/15"
                    title="Click to open chart for Top 5m Gainer"
                  >
                    <span className="font-sans text-zinc-400">5m Top:</span>
                    <span className="font-sans font-bold text-zinc-100">
                      {toDisplaySymbol(exchange, marketPulse.top5mGainer.symbol)}
                    </span>
                    <span className="font-bold text-[#3ee0a1]">
                      {formatPercent(marketPulse.top5mGainer.changePct["5m"])}
                    </span>
                  </button>
                )}
                {marketPulse.top15mOiSpike && (
                  <button
                    type="button"
                    onClick={() => setSelectedSymbol(marketPulse.top15mOiSpike!.symbol)}
                    className="flex h-6 items-center gap-1 rounded-md border border-violet-500/30 bg-violet-500/10 px-2 text-[10px] transition-colors hover:border-violet-400/60 hover:bg-violet-500/15"
                    title="Click to open chart for Top 15m OI Spike"
                  >
                    <span className="font-sans text-zinc-400">15m OI:</span>
                    <span className="font-sans font-bold text-zinc-100">
                      {toDisplaySymbol(exchange, marketPulse.top15mOiSpike.symbol)}
                    </span>
                    <span className="font-bold text-violet-300">
                      {formatPercent(marketPulse.top15mOiSpike.oiChangePct["15m"])}
                    </span>
                  </button>
                )}
              </div>
            )}
          </div>

          {/* TIER 3.5: Always-Visible Inline Quick Manual Filter Bar (Type 1k, 50k, 10m, 1b for Volume, MCAP, OI, Trades, etc.) */}
          <div
            data-testid="quick-filter-bar"
            className="mt-1.5 flex flex-wrap items-center justify-between gap-2 border-t border-[#181d2a]/80 pt-1.5 text-[11px]"
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-cyan-400">
                <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                </svg>
                Quick Filter:
              </span>

              {/* Quick 1-Click Metric Selector Pills */}
              <div className="flex flex-wrap items-center gap-1">
                {(
                  [
                    { field: "volume:1d", label: "Vol 24h" },
                    { field: "volume:1h", label: "Vol 1h" },
                    { field: "volume:15m", label: "Vol 15m" },
                    { field: "volume:5m", label: "Vol 5m" },
                    { field: "mcap", label: "MCAP $" },
                    { field: "oiUsd", label: "OI $" },
                    { field: "trades:15m", label: "Trades 15m" },
                    { field: "changePct:15m", label: "CHG 15m%" },
                    { field: "oiChangePct:15m", label: "OI 15m%" },
                    { field: "rvol", label: "RVOL" },
                    { field: "price", label: "Price $" },
                  ] as { field: NumericField; label: string }[]
                ).map((m) => (
                  <button
                    key={m.field}
                    type="button"
                    onClick={() => setBuilderField(m.field)}
                    className={`h-6 rounded-md border px-2 text-[10.5px] font-medium transition-all ${
                      builderField === m.field
                        ? "border-cyan-500/60 bg-cyan-500/20 text-cyan-100 shadow-[0_0_8px_rgba(34,211,238,0.15)]"
                        : "border-[#1c2232] bg-[#0a0d14] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                    }`}
                    title={`Select ${m.label} for manual filtering`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              {/* Manual Filter Form: Metric Dropdown + Operator + Shorthand Input (1k, 50k, 10m) + Add Button */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  addManualFilter();
                }}
                className="flex flex-wrap items-center gap-1"
              >
                <select
                  aria-label="Filter Metric"
                  data-testid="quick-filter-field"
                  value={builderField}
                  onChange={(e) => setBuilderField(e.target.value as NumericField)}
                  className="h-6.5 rounded-md border border-[#22293a] bg-[#0d111a] px-2 text-[11px] font-medium text-zinc-100 outline-none focus:border-cyan-500/60"
                >
                  {renderGroupedFieldOptions(FILTER_FIELD_OPTIONS)}
                </select>

                <select
                  aria-label="Filter Operator"
                  data-testid="quick-filter-op"
                  value={builderOp}
                  onChange={(e) => setBuilderOp(e.target.value as CompareOp)}
                  className="h-6.5 rounded-md border border-[#22293a] bg-[#0d111a] px-1.5 font-mono text-[11px] font-semibold text-cyan-300 outline-none focus:border-cyan-500/60"
                >
                  <option value=">">&gt;</option>
                  <option value=">=">&gt;=</option>
                  <option value="<">&lt;</option>
                  <option value="<=">&lt;=</option>
                  <option value="=">=</option>
                  <option value="between">Between</option>
                  <option value="abs_gt">|x| &gt;</option>
                </select>

                <div className="relative flex items-center">
                  <input
                    type="text"
                    inputMode="text"
                    aria-label="Filter Threshold Value"
                    data-testid="quick-filter-input"
                    value={builderValue}
                    onChange={(e) => setBuilderValue(e.target.value)}
                    placeholder="e.g. 1k, 50k, 10m..."
                    className="h-6.5 w-32 rounded-md border border-[#22293a] bg-[#090c14] px-2 pr-6 font-mono text-[11px] text-zinc-100 placeholder:font-sans placeholder:text-zinc-500 outline-none focus:border-cyan-400"
                  />
                  {builderValue && (
                    <button
                      type="button"
                      onClick={() => {
                        setBuilderValue("");
                        setBuilderValue2("");
                      }}
                      className="absolute right-1.5 text-[11px] text-zinc-500 hover:text-zinc-200"
                      title="Clear input"
                    >
                      ×
                    </button>
                  )}
                </div>

                {needsSecondDraftInput && (
                  <>
                    <span className="text-[10px] text-zinc-500">to</span>
                    <input
                      type="text"
                      inputMode="text"
                      aria-label="Filter Max Threshold Value"
                      data-testid="quick-filter-input-max"
                      value={builderValue2}
                      onChange={(e) => setBuilderValue2(e.target.value)}
                      placeholder="max (e.g. 50m)"
                      className="h-6.5 w-28 rounded-md border border-[#22293a] bg-[#090c14] px-2 font-mono text-[11px] text-zinc-100 placeholder:font-sans placeholder:text-zinc-500 outline-none focus:border-cyan-400"
                    />
                  </>
                )}

                <button
                  type="submit"
                  data-testid="quick-filter-add"
                  disabled={!liveDraftFilter}
                  className="h-6.5 rounded-md border border-cyan-500/50 bg-cyan-500/20 px-2.5 text-[11px] font-semibold text-cyan-200 transition-colors hover:bg-cyan-500/30 disabled:cursor-not-allowed disabled:opacity-40"
                  title="Lock this filter rule so you can stack multiple filters"
                >
                  + Add Filter
                </button>
              </form>

              {/* Contextual 1-Click Shorthand Threshold Buttons */}
              <div className="flex flex-wrap items-center gap-1">
                {(builderField === "mcap" || builderField === "oiUsd" || builderField.startsWith("volume:")
                  ? ["1k", "10k", "50k", "100k", "1m", "10m", "50m"]
                  : builderField.startsWith("trades:")
                    ? ["100", "500", "1k", "5k", "10k"]
                    : builderField === "rvol"
                      ? ["1.5", "2", "3", "5"]
                      : builderField === "fundingRate1h"
                        ? ["0.01", "0.05", "0.1", "-0.05"]
                        : builderField === "price"
                          ? ["0.1", "1", "10", "100", "1k"]
                          : ["1", "2", "5", "10", "-5"]
                ).map((presetStr) => {
                  const parsed = parseFilterInput(presetStr);
                  if (!parsed) return null;
                  const targetOp: CompareOp = parsed.value < 0 ? "<" : ">";
                  const isRuleActive = manualFilters.some(
                    (f) => f.field === builderField && f.op === targetOp && f.value === parsed.value,
                  );
                  return (
                    <button
                      key={presetStr}
                      type="button"
                      onClick={() => {
                        applyQuickManualRule(builderField, targetOp, presetStr);
                      }}
                      className={`h-6 rounded border px-1.5 font-mono text-[10px] font-semibold transition-all ${
                        isRuleActive
                          ? "border-cyan-400/70 bg-cyan-500/25 text-cyan-100"
                          : "border-[#1c2232] bg-[#0a0d14] text-zinc-400 hover:border-cyan-500/40 hover:text-cyan-200"
                      }`}
                      title={`Filter ${formatFilterFieldLabel(builderField)} ${targetOp} ${formatFilterThreshold(builderField, parsed.value)}`}
                    >
                      {targetOp}
                      {presetStr.toUpperCase()}
                    </button>
                  );
                })}
              </div>

              {/* Live Draft Filter Feedback Badge */}
              {liveDraftFilter && (
                <span
                  data-testid="quick-filter-live-preview"
                  className="inline-flex h-6 items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-2 font-mono text-[10.5px] font-semibold text-emerald-200"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  <span>
                    Live: {formatFilterRuleSummary(liveDraftFilter.field, liveDraftFilter.op, liveDraftFilter.value, liveDraftFilter.value2)} ({rows.length} matches)
                  </span>
                </span>
              )}
              {builderValue.trim().length > 0 && !liveDraftFilter && (
                <span className="inline-flex h-6 items-center rounded-md border border-rose-500/40 bg-rose-500/15 px-2 text-[10.5px] text-rose-300">
                  Enter a number like 1k, 50k, 10m, 2.5
                </span>
              )}
            </div>

            {/* Right / Active Filter Chips Row */}
            {manualFilters.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5" data-testid="active-manual-filter-chips">
                {manualFilters.map((f) => (
                  <div
                    key={f.id}
                    className="inline-flex h-6 items-center gap-1 rounded-md border border-cyan-500/45 bg-cyan-500/15 pl-2 pr-1 font-mono text-[10.5px] font-semibold text-cyan-100 shadow-[0_0_8px_rgba(34,211,238,0.12)]"
                  >
                    <button
                      type="button"
                      onClick={() => editManualFilter(f)}
                      className="hover:text-white"
                      title="Click to edit this filter rule"
                    >
                      {formatFilterRuleSummary(f.field, f.op, f.value, f.value2)}
                    </button>
                    <button
                      type="button"
                      onClick={() => setManualFilters((prev) => prev.filter((x) => x.id !== f.id))}
                      className="ml-0.5 rounded px-1 text-cyan-300 hover:bg-cyan-500/30 hover:text-white"
                      title="Remove filter"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setManualFilters([]);
                    setBuilderValue("");
                    setBuilderValue2("");
                  }}
                  className="h-6 rounded-md border border-rose-500/40 bg-rose-500/15 px-2 text-[10.5px] font-semibold text-rose-200 hover:bg-rose-500/25"
                >
                  Clear All
                </button>
              </div>
            )}
          </div>

          {/* TIER 4: Timeframe Focus Tabs (Left) | Core Column Quick-Toggles (Right) */}
          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 border-t border-[#181d2a]/80 pt-1.5 text-[11px]">
            {/* Left: Segmented Timeframe Focus Tabs */}
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500">TF View:</span>
              <div className="flex flex-wrap items-center gap-0.5 rounded-lg border border-[#1c2232] bg-[#07090e] p-0.5">
                {(
                  [
                    { id: "default", label: "Orion Default" },
                    { id: "5m", label: "5m" },
                    { id: "15m", label: "15m" },
                    { id: "1h", label: "1h" },
                    { id: "4h", label: "4h" },
                    { id: "8h", label: "8h" },
                    { id: "12h", label: "12h" },
                    { id: "1d", label: "1d" },
                    { id: "all", label: "All 77 Cols" },
                  ] as const
                ).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => applyTimeframeFocus(t.id)}
                    className={`h-5.5 rounded-md px-2 py-0.5 text-[11px] font-semibold transition-all ${
                      activeTfFocus === t.id
                        ? "border border-cyan-400/60 bg-cyan-500/20 text-cyan-200 shadow-[0_0_8px_rgba(34,211,238,0.18)]"
                        : "border border-transparent text-zinc-400 hover:bg-[#121622] hover:text-zinc-200"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Right: Orion Core Quick-Toggle Checkboxes */}
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Core Cols:</span>
              <button
                type="button"
                onClick={() => setShowSparkline((v) => !v)}
                className={`inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition-all ${
                  showSparkline
                    ? "border-[#2563eb]/50 bg-[#131826] text-zinc-100"
                    : "border-[#1c2232] bg-[#090b12] text-zinc-500 hover:text-zinc-300"
                }`}
                title="Toggle 24h Trend sparkline column"
              >
                <span
                  className={`flex h-3.5 w-3.5 items-center justify-center rounded-[3px] text-[9px] font-bold ${
                    showSparkline ? "bg-[#2563eb] text-white" : "border border-zinc-700 bg-zinc-900 text-transparent"
                  }`}
                >
                  ✓
                </span>
                <span>24h trend</span>
              </button>

              {(
                [
                  { key: "price", label: "Price" },
                  { key: "oiUsd", label: "OI $" },
                  { key: "fundingRate1h", label: "Funding/h" },
                  { key: "rvol", label: "RVOL" },
                  { key: "mcap", label: "MCAP" },
                  { key: "oiToMcapPct", label: "OI/MCAP" },
                ] as const
              ).map((c) => {
                const isOn = visible.has(c.key);
                return (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => toggleColumn(c.key)}
                    className={`inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition-all ${
                      isOn
                        ? "border-[#2563eb]/50 bg-[#131826] text-zinc-100"
                        : "border-[#1c2232] bg-[#090b12] text-zinc-500 hover:text-zinc-300"
                    }`}
                    title={`Click to ${isOn ? "hide" : "show"} ${c.label} column`}
                  >
                    <span
                      className={`flex h-3.5 w-3.5 items-center justify-center rounded-[3px] text-[9px] font-bold ${
                        isOn ? "bg-[#2563eb] text-white" : "border border-zinc-700 bg-zinc-900 text-transparent"
                      }`}
                    >
                      ✓
                    </span>
                    <span>{c.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* TIER 5: Categories / Sectors Bar (Turn OFF individual categories or filter to a single category) */}
          {showCategoryBar && availableSectors.length > 0 && (
            <div className="mt-1.5 flex items-center gap-1 overflow-x-auto border-t border-[#181d2a]/80 pt-1.5 text-[10.5px] scrollbar-none">
              {/* Mode Toggle: Turn Off Categories (Exclude) vs Only Category (Include) */}
              <div className="mr-1 flex shrink-0 items-center rounded-md border border-[#1c2232] bg-[#07090e] p-0.5">
                <button
                  type="button"
                  onClick={() => setSectorFilterMode("exclude")}
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold transition-colors ${
                    sectorFilterMode === "exclude"
                      ? "border border-rose-500/40 bg-rose-500/20 text-rose-200"
                      : "text-zinc-500 hover:text-zinc-300"
                  }`}
                  title="Click any category chip to turn it OFF (exclude it from the table)"
                >
                  🚫 Turn Off
                </button>
                <button
                  type="button"
                  onClick={() => setSectorFilterMode("include")}
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold transition-colors ${
                    sectorFilterMode === "include"
                      ? "border border-cyan-500/40 bg-cyan-500/20 text-cyan-200"
                      : "text-zinc-500 hover:text-zinc-300"
                  }`}
                  title="Click a category chip to show ONLY that category"
                >
                  🎯 Only
                </button>
              </div>

              <button
                type="button"
                onClick={() => {
                  setSelectedSector("all");
                  setExcludedSectors(new Set());
                  setHideUsStocks(false);
                  setHideAllTradFi(false);
                }}
                className={`shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                  selectedSector === "all" && excludedSectors.size === 0 && !hideUsStocks && !hideAllTradFi
                    ? "border-zinc-600/80 bg-zinc-700/60 text-zinc-100"
                    : "border-[#1c2232] bg-[#0c0f18] text-zinc-400 hover:text-zinc-200"
                }`}
                title="Reset all category filters and show everything"
              >
                All On
              </button>

              {availableSectors.map(({ sector, count }) => {
                const isExcluded =
                  excludedSectors.has(sector) ||
                  (hideUsStocks && US_STOCK_SECTORS.has(sector)) ||
                  (hideAllTradFi && TRADFI_SECTORS.has(sector));
                const isSelectedOnly = selectedSector === sector;

                return (
                  <button
                    key={sector}
                    type="button"
                    onClick={() => {
                      if (sectorFilterMode === "exclude") {
                        setSelectedSector("all");
                        if (hideUsStocks && US_STOCK_SECTORS.has(sector)) setHideUsStocks(false);
                        if (hideAllTradFi && TRADFI_SECTORS.has(sector)) setHideAllTradFi(false);
                        toggleExcludedSector(sector);
                      } else {
                        setSelectedSector((prev) => (prev === sector ? "all" : sector));
                      }
                    }}
                    title={
                      sectorFilterMode === "exclude"
                        ? isExcluded
                          ? `Category '${sector}' is OFF — Click to turn back ON`
                          : `Click to turn OFF '${sector}' (${count} contracts)`
                        : `Click to show ONLY '${sector}' (${count} contracts)`
                    }
                    className={`shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-tight whitespace-nowrap transition-all ${
                      isExcluded
                        ? "border-rose-500/40 bg-rose-500/15 text-rose-300 line-through opacity-80 hover:opacity-100"
                        : isSelectedOnly
                          ? "border-cyan-500/50 bg-cyan-500/20 text-cyan-200"
                          : "border-[#1a2030] bg-[#0b0e17] text-zinc-400 hover:border-zinc-700 hover:bg-[#131826] hover:text-zinc-200"
                    }`}
                  >
                    {isExcluded ? `✕ ${sector}` : sector}{" "}
                    <span className="ml-0.5 font-normal text-zinc-500">({count})</span>
                  </button>
                );
              })}

              <button
                type="button"
                onClick={() => setShowCategoryBar(false)}
                className="ml-auto shrink-0 rounded-md border border-[#1c2232] bg-[#090b12] px-2 py-0.5 text-[10px] font-medium text-zinc-500 hover:border-zinc-700 hover:text-zinc-300"
                title="Hide categories bar (re-open anytime from the 🏷️ Categories button above)"
              >
                Hide ▴
              </button>
            </div>
          )}
        </header>

        {/* Orion Custom Filter & Scanner Thresholds Modal */}
        {showFilters && (
          <OrionFilterModal
            onClose={() => setShowFilters(false)}
            fieldOptions={FILTER_FIELD_OPTIONS}
            builderField={builderField}
            onChangeBuilderField={(f) => setBuilderField(f as NumericField)}
            builderOp={builderOp}
            onChangeBuilderOp={setBuilderOp}
            builderValue={builderValue}
            onChangeBuilderValue={setBuilderValue}
            builderValue2={builderValue2}
            onChangeBuilderValue2={setBuilderValue2}
            onAddFilter={addManualFilter}
            onApplyQuickRule={(field, op, rawValue) => {
              applyQuickManualRule(field as NumericField, op, rawValue);
            }}
            manualFilters={manualFilters}
            onRemoveFilter={(id) => setManualFilters((prev) => prev.filter((x) => x.id !== id))}
            onEditFilter={(rule) => editManualFilter(rule as ManualFilter)}
            onClearAllFilters={clearAllFilters}
            presetThresholds={presetThresholds}
            onChangePresetThresholds={setPresetThresholds}
            savedFilterPresets={savedFilterPresets}
            newPresetName={newPresetName}
            onChangeNewPresetName={setNewPresetName}
            onSavePreset={saveCurrentFilterPreset}
            onApplySavedPreset={(preset) => applySavedFilterPreset(preset as SavedFilterPreset)}
            onDeleteSavedPreset={deleteSavedFilterPreset}
            previewMatchCount={liveDraftFilter ? rows.length : null}
            activeMatchCount={rows.length}
            totalCount={data?.rows.length ?? 0}
          />
        )}

        {/* Orion Slide-Over Column Visibility Drawer (Screenshot 3 Exact Match) */}
        {showColumns && (
          <OrionColumnVisibilityDrawer
            onClose={() => setShowColumns(false)}
            showSparkline={showSparkline}
            onToggleSparkline={setShowSparkline}
            visible={visible}
            onToggleColumn={toggleColumn}
            coreColumns={CORE_COLUMNS}
            groups={GROUPS}
            groupAllOn={groupAllOn}
            onToggleGroup={(g, on) => toggleGroup(g as GroupKey, on)}
            onApplyPreset={applyColumnPreset}
          />
        )}

        {/* Orion Slide-Over Real-Time Alerts Drawer */}
        {showAlerts && (
          <OrionAlertsDrawer
            exchange={exchange}
            onClose={() => setShowAlerts(false)}
            rules={alertRules}
            events={alertEvents}
            soundEnabled={soundEnabled}
            onToggleSound={() => setSoundEnabled((v) => !v)}
            onToggleRule={(id) =>
              setAlertRules((prev) => prev.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)))
            }
            onDeleteRule={(id) => setAlertRules((prev) => prev.filter((r) => r.id !== id))}
            onAddRule={(rule) =>
              setAlertRules((prev) => [...prev, { ...rule, id: `${Date.now()}-${Math.random().toString(16).slice(2)}` }])
            }
            onClearEvents={() => setAlertEvents([])}
            onSelectSymbol={(sym) => {
              setSelectedSymbol(sym);
              setShowAlerts(false);
            }}
            fieldOptions={FILTER_FIELD_OPTIONS}
          />
        )}

        {/* Main Workspace Body */}
        {!data && loading ? (
          <div className="py-28 text-center text-zinc-400">
            <div className="mx-auto max-w-sm rounded-xl border border-zinc-800/80 bg-[#0c0e14] p-6">
              <div className="text-sm font-semibold text-zinc-200">
                Loading {EXCHANGE_LABEL[exchange]} Perpetual Market Data...
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                Fetching contract specifications, live tickers, and 1m multi-timeframe orderflow klines.
              </p>
            </div>
          </div>
        ) : error ? (
          <div className="mt-3 rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
            Failed to load: {error}
          </div>
        ) : (
          <>
            {warning && (
              <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200">
                {warning}
              </div>
            )}

            {(dockMode === "top" || (dockMode === "right" && chartWidthMode === "max")) && selectedSymbol && (
              <div className="mt-2.5">{renderChartAndInspector()}</div>
            )}

            <div
              className={`mt-2.5 grid gap-2.5 ${
                dockMode === "right" && selectedSymbol && chartWidthMode !== "max"
                  ? chartWidthMode === "half"
                    ? "xl:grid-cols-2"
                    : chartWidthMode === "wide"
                      ? "xl:grid-cols-[1fr_680px] 2xl:grid-cols-[1fr_800px]"
                      : "xl:grid-cols-[1fr_560px] 2xl:grid-cols-[1fr_640px]"
                  : "grid-cols-1"
              }`}
            >
              {/* Virtualized Screener Table */}
              <div className="flex min-w-0 w-full flex-col overflow-hidden rounded-xl border border-[#191d28] bg-[#0c0e14]">
                <div
                  className="w-full overflow-auto"
                  ref={tableBodyRef}
                  style={{
                    height: dockMode === "top" && selectedSymbol ? "calc(100vh - 310px)" : "calc(100vh - 235px)",
                    minHeight: "420px",
                  }}
                >
                  <div className="min-w-max text-[12.5px] tabular-nums">
                    {/* Table Header */}
                    <div className="sticky top-0 z-40 flex border-b border-[#232838] bg-[#0f121a]/95 backdrop-blur-sm shadow-[0_4px_12px_rgba(0,0,0,0.35)]">
                      {visibleColumns.map((col) => {
                        const isSymbol = col.key === "symbol";
                        const isSorted = sortBy === col.key;
                        return (
                          <div key={col.key} className="contents">
                            <div
                              onClick={() => handleSort(col.key)}
                              title={
                                col.type === "core" && col.shortTip
                                  ? `${col.shortTip} — Click to toggle Descending (▼) / Ascending (▲)`
                                  : `Click to sort by ${col.label} (${isSorted && sortDir === "desc" ? "Ascending ▲" : "Descending ▼"})`
                              }
                              className={`group/hdr flex cursor-pointer select-none items-center whitespace-nowrap px-2.5 py-2 font-sans text-[10.5px] font-semibold uppercase tracking-[0.06em] transition-colors ${headerAccentClass(col.key)} ${
                                isSymbol
                                  ? "sticky left-0 z-40 justify-start border-r border-[#232838] bg-[#0f121a] text-left shadow-[6px_0_14px_rgba(0,0,0,0.55)]"
                                  : "justify-end text-right"
                              } ${
                                isSorted
                                  ? "bg-cyan-500/15 text-cyan-100 border-b-2 border-b-cyan-400"
                                  : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-100"
                              }`}
                              style={cellStyle(col.key)}
                            >
                              <span>{col.label}</span>
                              {isSorted ? (
                                <span
                                  className={`ml-1 inline-flex items-center rounded px-1 py-0.2 text-[9px] font-bold ${
                                    sortDir === "desc"
                                      ? "bg-cyan-500/25 text-cyan-300"
                                      : "bg-amber-500/25 text-amber-300"
                                  }`}
                                >
                                  {sortDir === "desc" ? "▼" : "▲"}
                                </span>
                              ) : (
                                <span className="ml-1 inline-block text-[9px] text-zinc-600 opacity-0 group-hover/hdr:opacity-100">
                                  ⇅
                                </span>
                              )}
                            </div>

                            {/* Orion 24H TREND Mini Sparkline Column Header immediately after SYMBOL */}
                            {isSymbol && showSparkline && (
                              <div
                                onClick={() => handleSort("changePct:1d")}
                                title="24h price trend mini-sparkline — Click to sort by 24h Change %"
                                className="cursor-pointer select-none whitespace-nowrap px-2.5 py-2 text-center text-[11px] font-semibold uppercase tracking-wider text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-100"
                                style={{ minWidth: "112px", width: "112px", flex: "0 0 112px" }}
                              >
                                24H TREND
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {/* Virtualized Rows */}
                    <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
                      {(() => {
                        const vItems = rowVirtualizer.getVirtualItems();
                        const orderedItems =
                          dockMode === "dropdown" && selectedSymbol
                            ? [
                                ...vItems.filter((v) => rows[v.index]?.symbol !== selectedSymbol),
                                ...vItems.filter((v) => rows[v.index]?.symbol === selectedSymbol),
                              ]
                            : vItems;
                        return orderedItems.map((virtualRow) => {
                          const row = rows[virtualRow.index];
                          if (!row) return null;
                          const idx = virtualRow.index;
                          const isSelected = selectedSymbol === row.symbol;
                          const isInlineDropdown = dockMode === "dropdown" && isSelected;
                          const flash = priceFlashes[row.symbol];
                          const rowBg = isSelected
                            ? "bg-[#10263a]"
                            : idx % 2 === 0
                              ? "bg-[#0a0c12]"
                              : "bg-[#0e1119]";

                          return (
                            <div
                              key={String(virtualRow.key)}
                              data-index={virtualRow.index}
                              data-inline-dropdown={isInlineDropdown ? "true" : undefined}
                              ref={isInlineDropdown ? rowVirtualizer.measureElement : undefined}
                              className="flex flex-col will-change-transform"
                              style={{
                                position: "absolute",
                                top: 0,
                                left: 0,
                                right: 0,
                                zIndex: isInlineDropdown ? 30 : 1,
                                transform: `translate3d(0, ${virtualRow.start}px, 0)`,
                              }}
                            >
                              <div
                                onClick={() => {
                                  const nextDock = dockMode === "hidden" ? "dropdown" : dockMode;
                                  if (dockMode === "hidden") setDockMode("dropdown");
                                  const opening = selectedSymbol !== row.symbol;
                                  setSelectedSymbol(opening ? row.symbol : null);
                                  if (opening && nextDock === "dropdown" && tableBodyRef.current) {
                                    const targetTop = Math.max(0, idx * 36 - 36);
                                    window.requestAnimationFrame(() => {
                                      tableBodyRef.current?.scrollTo({
                                        top: targetTop,
                                        behavior: "smooth",
                                      });
                                    });
                                  }
                                }}
                                className={`group flex h-9 cursor-pointer items-center border-b ${rowBg} ${
                                  isSelected
                                    ? "border-cyan-500/30 shadow-[inset_3px_0_0_#22d3ee]"
                                    : "border-[#141823]"
                                } hover:bg-[#151b28]`}
                              >
                              {visibleColumns.map((col) => {
                                if (col.type === "core") {
                                  switch (col.key) {
                                    case "symbol": {
                                      const dispSym = toDisplaySymbol(exchange, row.symbol);
                                      const isWatched = watchlistKeys.has(toWatchKey(exchange, row.symbol));
                                      return (
                                        <div key={col.key} className="contents">
                                          <div
                                            className={`sticky left-0 z-20 flex h-full items-center gap-1.5 border-r border-[#1c2130] px-2 font-sans font-semibold text-zinc-100 shadow-[6px_0_14px_rgba(0,0,0,0.45)] ${
                                              isWatched ? "border-l-2 border-l-amber-400" : ""
                                            } ${rowBg} group-hover:bg-[#151b28]`}
                                            style={cellStyle(col.key)}
                                          >
                                            <span className="w-5 shrink-0 text-right text-[10px] font-medium text-zinc-600 tabular-nums">
                                              {idx + 1}
                                            </span>
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
                                              title={isWatched ? "Starred / Pinned in Watchlist (Click to unstar)" : "Click to Star / Add to Watchlist"}
                                              aria-label={isWatched ? `Remove ${dispSym} from watchlist` : `Add ${dispSym} to watchlist`}
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
                                            <TokenAvatar symbol={dispSym} iconUrl={row.iconUrl} />
                                            <span
                                              className={`min-w-0 truncate text-[13px] tracking-tight ${isSelected ? "text-cyan-100" : "text-zinc-50"}`}
                                              title={dispSym}
                                            >
                                              {dispSym}
                                            </span>
                                            {isSelected && (
                                              <span
                                                className="shrink-0 rounded bg-cyan-500/25 px-1 py-0.2 text-[9px] font-bold text-cyan-200"
                                                title="Click row to close chart"
                                              >
                                                ▴
                                              </span>
                                            )}
                                            {row.isZeroFee && (
                                              <span
                                                className="rounded bg-emerald-500/15 px-1 py-0.2 text-[9px] font-bold text-emerald-300"
                                                title="Zero Fee Contract"
                                              >
                                                0%
                                              </span>
                                            )}
                                            {row.isNew && (
                                              <span className="rounded bg-amber-500/20 px-1 py-0.2 text-[9px] font-bold text-amber-300">
                                                NEW
                                              </span>
                                            )}
                                            {!row.isNew && row.isHot && (
                                              <span className="rounded bg-rose-500/20 px-1 py-0.2 text-[9px] font-bold text-rose-300">
                                                HOT
                                              </span>
                                            )}
                                          </div>

                                          {/* Orion 24H TREND Sparkline Cell */}
                                          {showSparkline && (
                                            <div
                                              className="flex h-full items-center justify-center px-2"
                                              style={{ minWidth: "112px", width: "112px", flex: "0 0 112px" }}
                                            >
                                              <Sparkline24h
                                                points={row.sparkline24h}
                                                change24hPct={row.changePct["1d"]}
                                                complete={row.sparklineComplete}
                                              />
                                            </div>
                                          )}
                                        </div>
                                      );
                                    }
                                    case "price":
                                      return (
                                        <div
                                          key={col.key}
                                          className={`flex h-full items-center justify-end px-2.5 text-right font-semibold transition-colors duration-300 ${
                                            flash === "up"
                                              ? "bg-emerald-500/[0.16] text-emerald-200"
                                              : flash === "down"
                                                ? "bg-rose-500/[0.16] text-rose-200"
                                                : "text-zinc-50"
                                          }`}
                                          style={cellStyle(col.key)}
                                        >
                                          <span className="num-dim mr-px">$</span>
                                          {formatPrice(row.price, row.priceScale)}
                                        </div>
                                      );
                                    case "rangePos24h": {
                                      const pos = row.rangePos24h;
                                      return (
                                        <div
                                          key={col.key}
                                          className="flex items-center justify-end gap-1.5 px-2.5"
                                          style={cellStyle(col.key)}
                                        >
                                          {pos !== null && pos !== undefined ? (
                                            <>
                                              <div className="h-1.5 w-10 overflow-hidden rounded-full bg-zinc-800">
                                                <div
                                                  className={`h-full rounded-full ${
                                                    pos >= 80
                                                      ? "bg-emerald-400"
                                                      : pos <= 20
                                                        ? "bg-rose-400"
                                                        : "bg-cyan-400/80"
                                                  }`}
                                                  style={{ width: `${Math.max(4, Math.min(100, pos))}%` }}
                                                />
                                              </div>
                                              <span
                                                className={`w-8 text-right text-[11px] ${
                                                  pos >= 85
                                                    ? "text-emerald-300 font-semibold"
                                                    : pos <= 15
                                                      ? "text-rose-300 font-semibold"
                                                      : "text-zinc-300"
                                                }`}
                                              >
                                                {pos.toFixed(0)}%
                                              </span>
                                            </>
                                          ) : (
                                            <span className="text-zinc-500">-</span>
                                          )}
                                        </div>
                                      );
                                    }
                                    case "oiUsd":
                                      return (
                                        <div key={col.key} className="px-2.5 text-right text-zinc-200" style={cellStyle(col.key)}>
                                          {row.oiUsd === null ? "-" : `$${formatNumber(row.oiUsd)}`}
                                        </div>
                                      );
                                    case "fundingRate1h": {
                                      const f1h = row.fundingRate1h ?? row.funding / (row.fundingIntervalHours || 8);
                                      const f1hPct = f1h * 100;
                                      const extreme = Math.abs(f1hPct) >= 0.01;
                                      return (
                                        <div
                                          key={col.key}
                                          className={`px-2.5 text-right ${colorForSigned(f1hPct)} ${extreme ? "font-bold" : ""}`}
                                          style={cellStyle(col.key)}
                                          title={`Funding Cycle: ${row.fundingIntervalHours ?? 8}h (${formatFunding(row.funding)})`}
                                        >
                                          {formatFundingPerHour(f1h)}
                                        </div>
                                      );
                                    }
                                    case "funding": {
                                      const fPct = row.funding * 100;
                                      const extreme = Math.abs(fPct) >= 0.05;
                                      return (
                                        <div
                                          key={col.key}
                                          className={`px-2.5 text-right ${colorForSigned(fPct)} ${extreme ? "font-bold" : ""}`}
                                          style={cellStyle(col.key)}
                                        >
                                          {formatFunding(row.funding)}
                                        </div>
                                      );
                                    }
                                    case "basisPct":
                                      return (
                                        <div
                                          key={col.key}
                                          className={`px-2.5 text-right ${colorForSigned(row.basisPct)}`}
                                          style={cellStyle(col.key)}
                                        >
                                          {row.basisPct === null || row.basisPct === undefined
                                            ? "-"
                                            : formatPercent(row.basisPct)}
                                        </div>
                                      );
                                    case "rvol": {
                                      const rv = row.rvol;
                                      return (
                                        <div
                                          key={col.key}
                                          className={`flex h-full items-center justify-end px-2.5 text-right ${rvolClass(rv)}`}
                                          style={cellStyle(col.key)}
                                          title="Relative volume vs. average (1.0x = normal)"
                                        >
                                          {rv === null ? "—" : `${rv.toFixed(2)}x`}
                                        </div>
                                      );
                                    }
                                    case "ticks5m":
                                      return (
                                        <div key={col.key} className="px-2.5 text-right text-zinc-300" style={cellStyle(col.key)}>
                                          {row.ticks5m === null ? "-" : formatNumber(row.ticks5m, 0)}
                                        </div>
                                      );
                                    case "mcap":
                                      return (
                                        <div key={col.key} className="px-2.5 text-right text-zinc-300" style={cellStyle(col.key)}>
                                          {row.mcap === null ? "-" : `$${formatNumber(row.mcap)}`}
                                        </div>
                                      );
                                    case "oiToMcapPct":
                                      return (
                                        <div
                                          key={col.key}
                                          className={`px-2.5 text-right ${
                                            (row.oiToMcapPct ?? 0) >= 15 ? "font-semibold text-amber-300" : "text-zinc-300"
                                          }`}
                                          style={cellStyle(col.key)}
                                        >
                                          {row.oiToMcapPct === null || row.oiToMcapPct === undefined
                                            ? "-"
                                            : `${row.oiToMcapPct.toFixed(1)}%`}
                                        </div>
                                      );
                                    case "volToOi":
                                      return (
                                        <div
                                          key={col.key}
                                          className={`px-2.5 text-right ${
                                            (row.volToOi ?? 0) >= 5 ? "font-semibold text-cyan-300" : "text-zinc-300"
                                          }`}
                                          style={cellStyle(col.key)}
                                        >
                                          {row.volToOi === null || row.volToOi === undefined
                                            ? "-"
                                            : `${row.volToOi.toFixed(1)}x`}
                                        </div>
                                      );
                                    case "change7dPct":
                                      return (
                                        <div
                                          key={col.key}
                                          className={`px-2.5 text-right ${colorForSigned(row.change7dPct)}`}
                                          style={cellStyle(col.key)}
                                        >
                                          {formatPercent(row.change7dPct)}
                                        </div>
                                      );
                                    case "change30dPct":
                                      return (
                                        <div
                                          key={col.key}
                                          className={`px-2.5 text-right ${colorForSigned(row.change30dPct)}`}
                                          style={cellStyle(col.key)}
                                        >
                                          {formatPercent(row.change30dPct)}
                                        </div>
                                      );
                                  }
                                }

                                const value = getMetricValue(row, col.group, col.timeframe);
                                const text = renderMetricValue(col.group, value);
                                const isPctGroup = col.group === "changePct" || col.group === "oiChangePct";
                                const heatClass = isPctGroup ? heatBgForPct(value) : "";
                                const color =
                                  col.group === "volume" || col.group === "trades"
                                    ? "text-zinc-200"
                                    : col.group === "volatility"
                                      ? (value ?? 0) >= 0.35
                                        ? "text-amber-300 font-medium"
                                        : "text-zinc-300"
                                      : isPctGroup && isNoisePct(value)
                                        ? "text-zinc-500"
                                        : colorForSigned(value);
                                return (
                                  <div
                                    key={col.key}
                                    className={`flex h-full items-center justify-end whitespace-nowrap px-2.5 text-right ${color} ${heatClass}`}
                                    style={cellStyle(col.key)}
                                  >
                                    {text}
                                  </div>
                                );
                              })}
                            </div>

                            {/* Inline Row Dropdown Chart (expands directly beneath the clicked ticker row and matches 100% of visible table width) */}
                            {isInlineDropdown && (
                              <div
                                className="sticky left-0 z-30 border-b border-cyan-500/30 bg-[#07090f] p-2 shadow-2xl"
                                style={{
                                  width:
                                    tableViewport.width > 0
                                      ? `${tableViewport.width}px`
                                      : "calc(100vw - 28px)",
                                }}
                              >
                                {renderChartAndInspector()}
                              </div>
                            )}
                          </div>
                        );
                      });
                      })()}
                    </div>
                  </div>
                </div>

                {/* Orion-Style Bottom Horizontal Scrollbar Track & Draggable Slider Bar */}
                <div className="sticky bottom-0 z-40 flex items-center gap-2 border-t border-[#1f2637] bg-[#080a10]/95 px-2.5 py-1.5 backdrop-blur-sm select-none">
                  <button
                    type="button"
                    onClick={() => nudgeTableScroll(-420)}
                    className="flex h-5 w-6 shrink-0 items-center justify-center rounded border border-cyan-500/30 bg-cyan-500/10 text-[10px] font-bold text-cyan-300 transition-colors hover:border-cyan-400 hover:bg-cyan-500/20"
                    title="Scroll table left"
                  >
                    ◄
                  </button>

                  {/* Full-Width Interactive Scrollbar Track + Draggable Thumb (Matches Screenshot) */}
                  <div
                    ref={hScrollTrackRef}
                    onMouseDown={(e) => {
                      if (e.target === hScrollThumbRef.current) return;
                      const track = hScrollTrackRef.current;
                      const thumb = hScrollThumbRef.current;
                      const el = tableBodyRef.current;
                      if (!track || !thumb || !el) return;
                      const rect = track.getBoundingClientRect();
                      const clickX = e.clientX - rect.left - thumb.clientWidth / 2;
                      const movable = Math.max(1, track.clientWidth - thumb.clientWidth);
                      const ratio = Math.max(0, Math.min(1, clickX / movable));
                      el.scrollLeft = ratio * Math.max(0, el.scrollWidth - el.clientWidth);
                      syncHorizontalSliderDOM();
                      hDragRef.current = {
                        active: true,
                        startX: e.clientX,
                        startScrollLeft: el.scrollLeft,
                        movablePx: movable,
                      };
                    }}
                    className="relative h-3.5 flex-1 cursor-pointer overflow-hidden rounded-full border border-[#252d42] bg-[#07090e] shadow-inner"
                    title="Click or drag to slide table columns left and right"
                  >
                    <div
                      ref={hScrollThumbRef}
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        const el = tableBodyRef.current;
                        const track = hScrollTrackRef.current;
                        const thumb = hScrollThumbRef.current;
                        if (!el || !track || !thumb) return;
                        hDragRef.current = {
                          active: true,
                          startX: e.clientX,
                          startScrollLeft: el.scrollLeft,
                          movablePx: Math.max(1, track.clientWidth - thumb.clientWidth),
                        };
                      }}
                      className="absolute left-0 top-0 flex h-full w-48 cursor-grab items-center justify-center rounded-full border border-cyan-400/50 bg-gradient-to-r from-cyan-500/40 via-cyan-400/60 to-cyan-500/40 shadow-[0_0_10px_rgba(34,211,238,0.25)] transition-colors hover:from-cyan-400/60 hover:via-cyan-300/80 hover:to-cyan-400/60 active:cursor-grabbing will-change-transform"
                    >
                      <span className="h-1 w-6 rounded-full bg-cyan-100/80" />
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => nudgeTableScroll(420)}
                    className="flex h-5 w-6 shrink-0 items-center justify-center rounded border border-cyan-500/30 bg-cyan-500/10 text-[10px] font-bold text-cyan-300 transition-colors hover:border-cyan-400 hover:bg-cyan-500/20"
                    title="Scroll table right"
                  >
                    ►
                  </button>

                  {/* Compact Precision Range Slider */}
                  <div className="hidden items-center gap-1.5 border-l border-[#1c2232] pl-2 sm:flex">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Slide</span>
                    <input
                      ref={bottomSliderRef}
                      type="range"
                      min={0}
                      max={1000}
                      defaultValue={0}
                      onChange={(e) => setTableScrollRatio(Number(e.target.value))}
                      className="h-1.5 w-28 cursor-ew-resize appearance-none rounded-full bg-zinc-800 accent-cyan-400"
                      aria-label="Slide table horizontally"
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between border-t border-[#191d28] bg-[#0a0c12] px-3 py-1.5 text-[11px] text-zinc-500">
                  <span>
                    Showing <strong className="text-zinc-300">{rows.length}</strong> of{" "}
                    {data?.totalContracts ?? data?.rows.length ?? 0} {EXCHANGE_LABEL[exchange]} contracts
                    {hideAllTradFi ? " (Pure Crypto — TradFi Off)" : hideUsStocks ? " (US Stocks Off)" : ""}
                  </span>
                  <span>
                    Tip: Click any ticker row to {dockMode === "dropdown" ? "drop down" : "open"} its chart (click again or press Esc to close)
                  </span>
                </div>
              </div>

              {/* Right Split Docked Chart & Inspector (Only rendered when a ticker is clicked) */}
              {dockMode === "right" && chartWidthMode !== "max" && selectedSymbol && (
                <div className="sticky top-[135px] h-fit">{renderChartAndInspector()}</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
