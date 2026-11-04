export const TIMEFRAMES = ["5m", "15m", "1h", "4h", "8h", "12h", "1d"] as const;

export type Timeframe = (typeof TIMEFRAMES)[number];

export const BTC_CORR_TIMEFRAMES = ["5m", "15m", "1h", "4h", "8h", "12h", "1d"] as const;
export type BtcCorrTimeframe = (typeof BTC_CORR_TIMEFRAMES)[number];

export const TIMEFRAME_TO_MINUTES: Record<Timeframe, number> = {
  "5m": 5,
  "15m": 15,
  "1h": 60,
  "4h": 240,
  "8h": 480,
  "12h": 720,
  "1d": 1440,
};

export interface MetricByTimeframe {
  [key: string]: number | null;
}

export interface ScreenerRow {
  symbol: string;
  price: number;
  priceScale?: number;
  contractSize?: number;
  oiUsd: number | null;
  funding: number;
  fundingRate1h?: number | null;
  fundingIntervalHours?: number;
  ticks5m: number | null;
  rvol: number | null;
  mcap: number | null;
  basisPct?: number | null;
  spreadBps?: number | null;
  rangePos24h?: number | null;
  high24Price?: number | null;
  low24Price?: number | null;
  oiToMcapPct?: number | null;
  volToOi?: number | null;
  change7dPct?: number | null;
  change30dPct?: number | null;
  maxLeverage?: number | null;
  isZeroFee?: boolean;
  isNew?: boolean;
  isHot?: boolean;
  sectors?: string[];
  hasKlines?: boolean;
  iconUrl?: string | null;
  sparkline24h?: number[];
  sparklineComplete?: boolean;
  changePct: Record<Timeframe, number | null>;
  changeUsd: Record<Timeframe, number | null>;
  volume: Record<Timeframe, number | null>;
  trades: Record<Timeframe, number | null>;
  volatility: Record<Timeframe, number | null>;
  oiChangePct: Record<Timeframe, number | null>;
  oiChangeUsd: Record<Timeframe, number | null>;
  cvd: Record<Timeframe, number | null>;
  volChangePct: Record<Timeframe, number | null>;
  volChangeUsd: Record<Timeframe, number | null>;
  btcCorr: Record<BtcCorrTimeframe, number | null>;
}

export interface ScreenerResponse {
  asOf: number;
  rows: ScreenerRow[];
  totalContracts?: number;
  klineSymbolsCount?: number;
  oiHistoryMinutes?: number;
  quality?: "fast" | "full";
  nextRefreshMs?: number;
}

export function formatNumber(num: number | null | undefined, decimals = 2): string {
  if (num === null || num === undefined || Number.isNaN(num)) return "—";
  const abs = Math.abs(num);
  const sign = num < 0 ? "-" : "";
  if (abs >= 1_000_000_000_000) return `${sign}${(abs / 1_000_000_000_000).toFixed(decimals)}T`;
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(decimals)}B`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(decimals)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(decimals)}K`;
  return `${num.toFixed(decimals)}`;
}

export function formatPrice(price: number, priceScale?: number): string {
  if (!Number.isFinite(price)) return "—";
  if (price === 0) return "0.00";
  if (priceScale !== undefined && Number.isFinite(priceScale) && priceScale >= 0 && priceScale <= 10) {
    return price.toFixed(priceScale);
  }
  const abs = Math.abs(price);
  if (abs >= 100) return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (abs >= 1) return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  if (abs >= 0.01) return price.toFixed(4);
  if (abs >= 0.0001) return price.toFixed(6);
  if (abs >= 0.000001) return price.toFixed(8);
  if (abs > 0) return price.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  return "0.00";
}

export function formatPercent(num: number | null | undefined, decimals = 2): string {
  if (num === null || num === undefined || Number.isNaN(num)) return "—";
  const sign = num >= 0 ? "+" : "";
  return `${sign}${num.toFixed(decimals)}%`;
}

export function formatFunding(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return "—";
  const sign = rate >= 0 ? "+" : "";
  return `${sign}${(rate * 100).toFixed(4)}%`;
}

/**
 * Formats hourly funding rate (`Funding/h`) using Orion Terminal's adaptive precision formula:
 * e.g. `+0.00441%`, `+0.00125%`, `-0.0000580%`, `0.0000%`
 */
export function formatFundingPerHour(ratePerHour: number | null | undefined): string {
  if (ratePerHour === null || ratePerHour === undefined || Number.isNaN(ratePerHour)) return "—";
  const t = 100 * ratePerHour;
  if (t === 0) return "0.0000%";
  const sign = t > 0 ? "+" : "";
  if (Math.abs(t) < 1e-8) return `${t > 0 ? "<+" : ">−"}0.00000001%`;
  const decimals = Math.min(8, Math.max(4, 2 - Math.floor(Math.log10(Math.abs(t)))));
  return `${sign}${t.toFixed(decimals)}%`;
}

export type CompareOp = ">" | ">=" | "<" | "<=" | "=" | "between" | "abs_gt";

export interface ParsedFilterInput {
  value: number;
  value2?: number;
  opOverride?: CompareOp;
}

function parseSingleShorthandNumber(raw: string): number | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  // Strip optional trailing currency labels like "usd", "usdt", "usdc"
  s = s.replace(/\s*(?:usdt|usdc|usd)\s*$/i, "");
  // Strip commas, currency signs ($), percent signs (%), and whitespace
  s = s.replace(/,/g, "").replace(/\$/g, "").replace(/%/g, "").replace(/\s+/g, "");
  // Strip trailing multiplier 'x' or 'X' (e.g., "2.5x" for RVOL)
  if (/[xX]$/.test(s)) {
    s = s.slice(0, -1);
  }
  const match = s.match(
    /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(k|thousand|m(?:il|illion|m)?|b(?:n|il|illion)?|t(?:r|ril|rillion)?)?$/i,
  );
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const suffix = match[2]?.toLowerCase()[0];
  const mult =
    suffix === "k"
      ? 1_000
      : suffix === "m"
        ? 1_000_000
        : suffix === "b"
          ? 1_000_000_000
          : suffix === "t"
            ? 1_000_000_000_000
            : 1;
  const result = base * mult;
  return Number.isFinite(result) ? result : null;
}

/**
 * Parses human-friendly filter inputs including shorthand suffixes (`1k`, `50k`, `2.5m`, `1b`, `1t`),
 * currency/percent symbols (`$100k`, `1,000`, `5%`, `2.5x`), optional comparison prefixes (`> 1k`,
 * `>= 50k`, `< 10m`, `more than 1k`, `under 10m`), and ranges (`1k - 50k`, `1k-50k`, `1k to 50k`).
 */
export function parseFilterInput(rawInput: string): ParsedFilterInput | null {
  if (typeof rawInput !== "string") return null;
  let s = rawInput.trim();
  if (!s) return null;

  // Support range expressions like "1k - 50k", "1k-50k", "1k to 50k", "between 1k and 50k", "from 1k to 50k", "1k..50k", "1k~50k"
  const betweenMatch = s.match(
    /^(?:(?:between|from)\s+)?(.+?)(?:\s+(?:and|to)\s+|\s+-\s+|(?<![eE+\-\s])-(?=\$?\d|\.\d)|\.\.|\s*~\s*)(.+)$/i,
  );
  if (betweenMatch) {
    const v1 = parseSingleShorthandNumber(betweenMatch[1]);
    const v2 = parseSingleShorthandNumber(betweenMatch[2]);
    if (v1 !== null && v2 !== null) {
      return { value: v1, value2: v2, opOverride: "between" };
    }
  }

  let opOverride: CompareOp | undefined;

  if (/^\s*\|x\|\s*>\s*/i.test(s)) {
    opOverride = "abs_gt";
    s = s.replace(/^\s*\|x\|\s*>\s*/i, "");
  } else if (/^(?:>=|=>|≥|at\s+least|min(?:imum)?)\s*/i.test(s)) {
    opOverride = ">=";
    s = s.replace(/^(?:>=|=>|≥|at\s+least|min(?:imum)?)\s*/i, "");
  } else if (/^(?:<=|=<|≤|at\s+most|max(?:imum)?)\s*/i.test(s)) {
    opOverride = "<=";
    s = s.replace(/^(?:<=|=<|≤|at\s+most|max(?:imum)?)\s*/i, "");
  } else if (/^(?:>|more\s+than|greater\s+than|over|above)\s*/i.test(s)) {
    opOverride = ">";
    s = s.replace(/^(?:>|more\s+than|greater\s+than|over|above)\s*/i, "");
  } else if (/^(?:<|less\s+than|under|below)\s*/i.test(s)) {
    opOverride = "<";
    s = s.replace(/^(?:<|less\s+than|under|below)\s*/i, "");
  } else if (/^(?:==?|equals?|is)\s*/i.test(s)) {
    opOverride = "=";
    s = s.replace(/^(?:==?|equals?|is)\s*/i, "");
  }

  const val = parseSingleShorthandNumber(s);
  if (val === null) return null;
  return { value: val, ...(opOverride ? { opOverride } : {}) };
}

export function parseShorthandNumber(rawInput: string): number | null {
  const parsed = parseFilterInput(rawInput);
  return parsed ? parsed.value : null;
}

export function formatFilterFieldLabel(field: string): string {
  if (field.includes(":")) {
    const [group, tf] = field.split(":");
    const tfUp = tf.toUpperCase();
    switch (group) {
      case "volume":
        return `VOL $ (${tfUp})`;
      case "mcap":
        return `MCAP $ (${tfUp})`;
      case "trades":
        return `TRADES (${tfUp})`;
      case "changePct":
        return `CHG % (${tfUp})`;
      case "changeUsd":
        return `CHG $ (${tfUp})`;
      case "oiChangePct":
        return `OI CHG % (${tfUp})`;
      case "oiChangeUsd":
        return `OI CHG $ (${tfUp})`;
      case "volatility":
        return `VLT % (${tfUp})`;
      case "cvd":
        return `VOL Δ $ (${tfUp})`;
      case "volChangePct":
        return `VOL CHG % (${tfUp})`;
      case "volChangeUsd":
        return `VOL CHG $ (${tfUp})`;
      case "btcCorr":
        return `BTC CORR (${tfUp})`;
      default:
        return `${group.toUpperCase()} (${tfUp})`;
    }
  }
  switch (field) {
    case "mcap":
      return "MCAP $";
    case "oiUsd":
      return "OI $";
    case "price":
      return "PRICE $";
    case "rvol":
      return "RVOL";
    case "fundingRate1h":
      return "FUNDING/H %";
    case "funding":
      return "FUNDING %";
    case "basisPct":
      return "BASIS %";
    case "rangePos24h":
      return "24H RANGE %";
    case "oiToMcapPct":
      return "OI/MCAP %";
    case "volToOi":
      return "VOL/OI";
    case "ticks5m":
      return "5M TICKS";
    case "change7dPct":
      return "CHG % (7D)";
    case "change30dPct":
      return "CHG % (30D)";
    default:
      return field.toUpperCase();
  }
}

export function formatFilterThreshold(field: string, val: number): string {
  if (!Number.isFinite(val)) return String(val);
  const isUsdField =
    field === "mcap" ||
    field === "oiUsd" ||
    field.startsWith("volume:") ||
    field.startsWith("changeUsd:") ||
    field.startsWith("oiChangeUsd:") ||
    field.startsWith("volChangeUsd:") ||
    field.startsWith("cvd:");
  if (isUsdField) {
    const sign = val < 0 ? "-" : "";
    return `${sign}$${formatNumber(Math.abs(val), 2).replace(/\.00([KMBT])$/, "$1")}`;
  }
  if (field === "price") {
    const sign = val < 0 ? "-" : "";
    return Math.abs(val) >= 1_000
      ? `${sign}$${formatNumber(Math.abs(val), 2).replace(/\.00([KMBT])$/, "$1")}`
      : `${sign}$${formatPrice(Math.abs(val))}`;
  }
  if (field === "trades" || field.startsWith("trades:") || field === "ticks5m") {
    return Math.abs(val) >= 1_000 ? formatNumber(val, 2).replace(/\.00([KMBT])$/, "$1") : String(val);
  }
  if (field === "rvol" || field === "volToOi") {
    return `${val}x`;
  }
  const isPctField =
    field.startsWith("changePct:") ||
    field.startsWith("oiChangePct:") ||
    field.startsWith("volChangePct:") ||
    field.startsWith("volatility:") ||
    field === "fundingRate1h" ||
    field === "funding" ||
    field === "basisPct" ||
    field === "rangePos24h" ||
    field === "oiToMcapPct" ||
    field === "change7dPct" ||
    field === "change30dPct";
  if (isPctField) {
    return `${val}%`;
  }
  return String(val);
}

export function formatFilterValue(val: number, field = ""): string {
  return formatFilterThreshold(field, val);
}

export function formatExactFilterValue(field: string, val: number): string {
  if (!Number.isFinite(val)) return String(val);
  const isUsdField =
    field === "mcap" ||
    field === "oiUsd" ||
    field === "price" ||
    field.startsWith("volume:") ||
    field.startsWith("changeUsd:") ||
    field.startsWith("oiChangeUsd:") ||
    field.startsWith("volChangeUsd:") ||
    field.startsWith("cvd:");
  const sign = val < 0 ? "-" : "";
  const abs = Math.abs(val);
  const formatted =
    abs >= 1
      ? abs.toLocaleString("en-US", { maximumFractionDigits: 4 })
      : formatPrice(abs);
  if (isUsdField) {
    return `${sign}$${formatted}`;
  }
  if (field === "rvol" || field === "volToOi") {
    return `${sign}${formatted}x`;
  }
  const isPctField =
    field.startsWith("changePct:") ||
    field.startsWith("oiChangePct:") ||
    field.startsWith("volChangePct:") ||
    field.startsWith("volatility:") ||
    field === "fundingRate1h" ||
    field === "funding" ||
    field === "basisPct" ||
    field === "rangePos24h" ||
    field === "oiToMcapPct" ||
    field === "change7dPct" ||
    field === "change30dPct";
  if (isPctField) {
    return `${sign}${formatted}%`;
  }
  return `${sign}${formatted}`;
}

export function formatFilterRuleSummary(
  field: string,
  op: CompareOp,
  value: number,
  value2?: number,
): string {
  const label = formatFilterFieldLabel(field);
  const v1 = formatFilterThreshold(field, value);
  if (op === "between") {
    const v2 = formatFilterThreshold(field, value2 ?? value);
    return `${label} ${v1} – ${v2}`;
  }
  if (op === "abs_gt") {
    return `|${label}| > ${v1}`;
  }
  return `${label} ${op} ${v1}`;
}



