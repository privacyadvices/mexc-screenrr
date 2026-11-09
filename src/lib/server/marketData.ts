import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BTC_CORR_TIMEFRAMES,
  TIMEFRAMES,
  TIMEFRAME_TO_MINUTES,
  type BtcCorrTimeframe,
  type ScreenerResponse,
  type ScreenerRow,
  type Timeframe,
} from "@/lib/screener";
import type { ExchangeId } from "@/lib/exchange";

const MEXC_BASE = "https://api.mexc.com";
const BINANCE_BASE = "https://fapi.binance.com";
const BYBIT_BASE = "https://api.bybit.com";
const BYBIT_FALLBACK_BASE = "https://api.bytick.com";
const GATE_BASE = "https://api.gateio.ws";
const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";

const CACHE_TTL_MS = 25_000;
const FAST_CACHE_TTL_MS = 12_000;
// 1-minute historical bars are immutable once closed and calcPerTimeframe adjusts for lagBars + live ticker tail.
// A 3-minute kline TTL cuts serverless CPU & upstream exchange calls by ~70% without sacrificing live accuracy.
const KLINE_CACHE_TTL_MS = 180_000;
const KLINE_MAX_USABLE_AGE_MS = 240_000;
const MCAP_CACHE_TTL_MS = 30 * 60_000;
const CONTRACT_DETAIL_TTL_MS = 30 * 60_000;
const KLINE_LIMIT = 760; // 760 1-minute bars (12.6 hours) covers all sub-24h windows (5m..12h) at 2x speed while 1d comes from 24h ticker

const SPAGHETTI_SYMBOL_LIMIT: Record<ExchangeId, number> = {
  mexc: 90,
  bybit: 90,
  gate: 90,
  binance: 60,
  hyperliquid: 70,
};

const KLINE_SYMBOL_LIMIT: Record<ExchangeId, number> = {
  mexc: 1200,
  bybit: 900,
  gate: 900,
  binance: 800,
  hyperliquid: 250,
};

const FAST_INITIAL_KLINE_LIMIT = 45;

type KlineData = {
  fetchedAt?: number; // Timestamp (ms) when kline was fetched from exchange
  time?: number[]; // UNIX seconds of bar open (1-minute resolution)
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  vol: number[]; // Always in USDT quote notional volume
  trades?: number[]; // Number of trades per 1m bar when available
  takerBuyVol?: number[]; // Taker buy quote volume (USDT) when available (e.g. Binance)
};

export interface MexcContractMeta {
  symbol: string;
  contractSize: number;
  priceScale: number;
  maxLeverage: number;
  isNew: boolean;
  isHot: boolean;
  isZeroFee: boolean;
  sectors: string[];
  createTime: number;
  iconUrl?: string | null;
}

export type NormalizedTicker = {
  symbol: string;
  price: number;
  priceScale?: number;
  contractSize?: number;
  amount24: number;
  fundingRate: number;
  fundingIntervalHours?: number;
  fundingRate1h?: number | null;
  oiUsd: number | null;
  change1hPct?: number | null;
  change1hUsd?: number | null;
  change24hPct: number | null;
  change24hUsd: number | null;
  change7dPct?: number | null;
  change30dPct?: number | null;
  change90dPct?: number | null;
  change1yPct?: number | null;
  basisPct: number | null;
  spreadBps: number | null;
  rangePos24h: number | null;
  high24Price: number | null;
  low24Price: number | null;
  maxLeverage?: number | null;
  isNew?: boolean;
  isHot?: boolean;
  isZeroFee?: boolean;
  sectors?: string[];
  iconUrl?: string | null;
};

export type SpaghettiResponse = {
  asOf: number;
  rows: Array<{
    symbol: string;
    amount24: number;
    close: number[];
    vol: number[];
  }>;
};

type OiSnapshotEntry = {
  ts: number;
  oi: Record<string, number>;
  price: Record<string, number>;
};

const screenerCache = new Map<ExchangeId, { at: number; payload: ScreenerResponse }>();
const screenerInFlight = new Map<ExchangeId, Promise<ScreenerResponse>>();
const klineCache = new Map<string, { at: number; data: KlineData }>();

const spaghettiCache = new Map<ExchangeId, { at: number; payload: SpaghettiResponse }>();
const spaghettiInFlight = new Map<ExchangeId, Promise<SpaghettiResponse>>();

let mcapCache = new Map<string, number>();
let mcapCachedAt = 0;
let mcapInFlight: Promise<Map<string, number>> | null = null;
const coinIconMap = new Map<string, string>();
const coinSectorsMap = new Map<string, string[]>();

let mexcDetailCache = new Map<string, MexcContractMeta>();
let mexcDetailCachedAt = 0;
let mexcDetailInFlight: Promise<Map<string, MexcContractMeta>> | null = null;

let mexcFundingCycleCache = new Map<string, number>();
let mexcFundingCycleCachedAt = 0;
let mexcFundingCycleInFlight: Promise<Map<string, number>> | null = null;

let binanceFundingIntervalCache = new Map<string, number>();
let binanceFundingIntervalCachedAt = 0;
let binanceFundingIntervalInFlight: Promise<Map<string, number>> | null = null;

let binanceOnboardCache = new Map<string, { onboardDate: number; priceScale?: number }>();
let binanceOnboardCachedAt = 0;
let binanceOnboardInFlight: Promise<Map<string, { onboardDate: number; priceScale?: number }>> | null = null;

let bybitLaunchCache = new Map<string, { launchTime: number; priceScale?: number; maxLeverage?: number }>();
let bybitLaunchCachedAt = 0;
let bybitLaunchInFlight: Promise<Map<string, { launchTime: number; priceScale?: number; maxLeverage?: number }>> | null = null;

type GateContractMeta = {
  launchTime: number;
  priceScale?: number;
  maxLeverage?: number;
  fundingIntervalHours: number;
  contractSize: number;
  inDelisting: boolean;
};
let gateContractCache = new Map<string, GateContractMeta>();
let gateContractCachedAt = 0;
let gateContractInFlight: Promise<Map<string, GateContractMeta>> | null = null;

const NEW_LISTING_WINDOW_MS = 7 * 24 * 3600_000; // 7 days

const binanceOiCache = new Map<string, { at: number; oiCoins: number }>();

const oiHistoryByExchange = new Map<ExchangeId, OiSnapshotEntry[]>([
  ["mexc", []],
  ["bybit", []],
  ["gate", []],
  ["binance", []],
  ["hyperliquid", []],
]);
let diskSnapshotsLoaded = false;
let lastDiskPersistAt = 0;
const SNAPSHOT_FILE_PATH = path.join(os.tmpdir(), "mexc-oi-snapshots-v1.json");

function asNumberArray(values: unknown[]): number[] {
  if (!Array.isArray(values)) return [];
  return values.map((v) => Number(v)).filter((v) => Number.isFinite(v));
}

export function normalizeBaseSymbol(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/_USDT$/, "")
    .replace(/USDT$/, "")
    .replace(/USD$/, "")
    .replace(/_PERP$/, "")
    .replace(/^_+/, "")
    .toLowerCase();
}

export function stripMultiplierPrefix(baseKey: string): string {
  return baseKey.replace(/^(10000000|1000000|100000|10000|1000|100)(?=[a-z]{2,})/i, "");
}

export function lookupMcap(mcapMap: Map<string, number>, symbol: string): number | null {
  const exact = normalizeBaseSymbol(symbol);
  if (!exact) return null;
  const direct = mcapMap.get(exact);
  if (direct !== undefined) return direct;
  const stripped = stripMultiplierPrefix(exact);
  if (stripped !== exact) {
    return mcapMap.get(stripped) ?? null;
  }
  return null;
}

export function lookupCoinIcon(symbol: string): string | null {
  const exact = normalizeBaseSymbol(symbol);
  if (!exact) return null;
  const direct = coinIconMap.get(exact);
  if (direct) return direct;
  const stripped = stripMultiplierPrefix(exact);
  if (stripped !== exact) {
    return coinIconMap.get(stripped) ?? null;
  }
  return null;
}

export function lookupCoinSectors(symbol: string): string[] {
  const exact = normalizeBaseSymbol(symbol);
  if (!exact) return [];
  const direct = coinSectorsMap.get(exact);
  if (direct && direct.length > 0) return direct;
  const stripped = stripMultiplierPrefix(exact);
  if (stripped !== exact) {
    const fromStripped = coinSectorsMap.get(stripped);
    if (fromStripped && fromStripped.length > 0) return fromStripped;
  }
  if (exact.endsWith("stock") || /^(nvda|tsla|aapl|msft|googl|amzn|meta|coin|mstr|spy|qqq|nas100|spx500|us30|tqqq|soxl|soxs|amd|intc|pltr|hood)$/.test(exact)) {
    return ["stock", "usstocks", "tradfi"];
  }
  return [];
}

async function ensureDiskSnapshotsLoaded(): Promise<void> {
  if (diskSnapshotsLoaded) return;
  diskSnapshotsLoaded = true;
  try {
    const raw = await readFile(SNAPSHOT_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<Record<ExchangeId, OiSnapshotEntry[]>>;
    const cutoff = Date.now() - 26 * 3600_000;
    for (const ex of ["mexc", "bybit", "gate", "binance", "hyperliquid"] as ExchangeId[]) {
      const arr = parsed[ex];
      if (Array.isArray(arr)) {
        oiHistoryByExchange.set(
          ex,
          arr.filter((x) => x && typeof x.ts === "number" && x.ts >= cutoff),
        );
      }
    }
  } catch {
    // No disk cache yet — will create on next snapshot.
  }
}

async function recordTickerSnapshot(exchange: ExchangeId, tickers: NormalizedTicker[]): Promise<void> {
  await ensureDiskSnapshotsLoaded();
  const list = oiHistoryByExchange.get(exchange) ?? [];
  const now = Date.now();
  const last = list.at(-1);
  if (last && now - last.ts < 5_000) return;

  const oi: Record<string, number> = {};
  const price: Record<string, number> = {};
  for (const t of tickers) {
    if (t.oiUsd !== null && Number.isFinite(t.oiUsd) && t.oiUsd > 0) {
      oi[t.symbol] = Math.round(t.oiUsd);
    }
    if (Number.isFinite(t.price) && t.price > 0) {
      price[t.symbol] = t.price;
    }
  }

  list.push({ ts: now, oi, price });

  // Prune to keep memory & disk compact:
  // Keep 5s resolution for last 30m (matches Orion 5s ticker ring buffer), 1m resolution for 30m..2h, 5m resolution for 2h..25h
  const cutoff25h = now - 25 * 3600_000;
  const pruned: OiSnapshotEntry[] = [];
  for (const entry of list) {
    if (entry.ts < cutoff25h) continue;
    const prev = pruned.at(-1);
    const ageMs = now - entry.ts;
    const minGapMs = ageMs > 2 * 3600_000 ? 5 * 60_000 : ageMs > 30 * 60_000 ? 60_000 : 5_000;
    if (!prev || entry.ts - prev.ts >= minGapMs || entry === list.at(-1)) {
      pruned.push(entry);
    }
  }
  oiHistoryByExchange.set(exchange, pruned);

  if (!process.env.VERCEL && now - lastDiskPersistAt > 60_000) {
    lastDiskPersistAt = now;
    try {
      await mkdir(path.dirname(SNAPSHOT_FILE_PATH), { recursive: true });
      await writeFile(
        SNAPSHOT_FILE_PATH,
        JSON.stringify({
          mexc: oiHistoryByExchange.get("mexc") ?? [],
          bybit: oiHistoryByExchange.get("bybit") ?? [],
          gate: oiHistoryByExchange.get("gate") ?? [],
          binance: oiHistoryByExchange.get("binance") ?? [],
          hyperliquid: oiHistoryByExchange.get("hyperliquid") ?? [],
        }),
        "utf8",
      );
    } catch {
      // Ignore write errors in read-only environments
    }
  }
}

function getOiHistoryMinutes(exchange: ExchangeId): number {
  const list = oiHistoryByExchange.get(exchange) ?? [];
  if (list.length < 2) return 0;
  return Math.max(0, Math.round((list[list.length - 1].ts - list[0].ts) / 60_000));
}

function cleanConceptPlates(plates: unknown): string[] {
  if (!Array.isArray(plates)) return [];
  const ignored = new Set(["mainly", "assessment", "innovation", "pos", "hot", "new"]);
  const out: string[] = [];
  for (const p of plates) {
    if (typeof p !== "string") continue;
    const cleaned = p.replace(/^mc-trade-zone-/i, "").trim().toLowerCase();
    if (!cleaned || ignored.has(cleaned)) continue;
    if (!out.includes(cleaned)) out.push(cleaned);
  }
  return out;
}

export async function fetchMexcContractDetailsMap(forceRefresh = false): Promise<Map<string, MexcContractMeta>> {
  const now = Date.now();
  const minRefreshGapMs = 60_000;
  if (
    mexcDetailCache.size &&
    now - mexcDetailCachedAt < (forceRefresh ? minRefreshGapMs : CONTRACT_DETAIL_TTL_MS)
  ) {
    return mexcDetailCache;
  }

  if (!mexcDetailInFlight) {
    mexcDetailInFlight = (async () => {
      try {
        const res = await fetch(`${MEXC_BASE}/api/v1/contract/detail`, {
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        if (!res.ok) return mexcDetailCache;
        const payload = (await res.json()) as {
          success?: boolean;
          data?: Array<Record<string, unknown>>;
        };
        if (!payload.success || !Array.isArray(payload.data)) return mexcDetailCache;

        const map = new Map<string, MexcContractMeta>();
        for (const d of payload.data) {
          const symbol = String(d.symbol ?? "");
          if (!symbol.endsWith("_USDT") || Number(d.state ?? 0) !== 0) continue;
          const contractSize = Number(d.contractSize);
          const priceScale = Number(d.priceScale);
          const maxLeverage = Number(d.maxLeverage);
          const makerFee = Number(d.makerFeeRate ?? 0);
          const takerFee = Number(d.takerFeeRate ?? 0);
          const sectors = cleanConceptPlates(d.conceptPlate);
          const isZeroFee = Boolean(
            d.isZeroFeeSymbol ||
              d.isZeroFeeRate ||
              (makerFee === 0 && takerFee === 0) ||
              sectors.includes("0fees"),
          );
          if (isZeroFee && !sectors.includes("0fees")) {
            sectors.push("0fees");
          }
          const iconUrl = typeof d.baseCoinIconUrl === "string" && d.baseCoinIconUrl.startsWith("http") ? d.baseCoinIconUrl : null;
          const baseKey = normalizeBaseSymbol(symbol);
          const stripped = stripMultiplierPrefix(baseKey);
          if (iconUrl) {
            if (baseKey) coinIconMap.set(baseKey, iconUrl);
            if (stripped && !coinIconMap.has(stripped)) coinIconMap.set(stripped, iconUrl);
          }
          if (sectors.length > 0) {
            const crossSectors = sectors.filter((s) => s !== "0fees" && s !== "contract-new");
            if (crossSectors.length > 0) {
              if (baseKey && !coinSectorsMap.has(baseKey)) coinSectorsMap.set(baseKey, crossSectors);
              if (stripped && !coinSectorsMap.has(stripped)) coinSectorsMap.set(stripped, crossSectors);
            }
          }
          const rawCreate = Number(d.createTime ?? d.openingTime ?? 0);
          const createTimeMs = rawCreate > 0 && rawCreate < 1e11 ? rawCreate * 1000 : rawCreate;
          const isRecentlyListed = createTimeMs > 0 && Date.now() - createTimeMs <= NEW_LISTING_WINDOW_MS;
          map.set(symbol, {
            symbol,
            contractSize: Number.isFinite(contractSize) && contractSize > 0 ? contractSize : 1,
            priceScale: Number.isFinite(priceScale) && priceScale >= 0 ? priceScale : 4,
            maxLeverage: Number.isFinite(maxLeverage) && maxLeverage > 0 ? maxLeverage : 20,
            isNew: Boolean(d.isNew) || isRecentlyListed || sectors.includes("contract-new"),
            isHot: Boolean(d.isHot),
            isZeroFee,
            sectors,
            createTime: createTimeMs,
            iconUrl,
          });
        }
        if (map.size > 0) {
          mexcDetailCache = map;
          mexcDetailCachedAt = Date.now();
        }
        return mexcDetailCache;
      } catch {
        return mexcDetailCache;
      }
    })().finally(() => {
      mexcDetailInFlight = null;
    });
  }

  return mexcDetailInFlight;
}

async function fetchBinanceOnboardMap(
  forceRefresh = false,
): Promise<Map<string, { onboardDate: number; priceScale?: number }>> {
  const now = Date.now();
  if (
    binanceOnboardCache.size &&
    now - binanceOnboardCachedAt < (forceRefresh ? 60_000 : CONTRACT_DETAIL_TTL_MS)
  ) {
    return binanceOnboardCache;
  }
  if (!binanceOnboardInFlight) {
    binanceOnboardInFlight = (async () => {
      try {
        const info = await binanceFetch<{
          symbols?: Array<{ symbol?: string; onboardDate?: number; pricePrecision?: number }>;
        }>("/fapi/v1/exchangeInfo");
        const map = new Map<string, { onboardDate: number; priceScale?: number }>();
        for (const s of info.symbols ?? []) {
          const sym = String(s.symbol ?? "");
          if (!sym) continue;
          const onboardDate = Number(s.onboardDate ?? 0);
          const priceScale = Number(s.pricePrecision);
          map.set(sym, {
            onboardDate: Number.isFinite(onboardDate) ? onboardDate : 0,
            priceScale: Number.isFinite(priceScale) && priceScale >= 0 ? priceScale : undefined,
          });
        }
        if (map.size > 0) {
          binanceOnboardCache = map;
          binanceOnboardCachedAt = Date.now();
        }
        return binanceOnboardCache;
      } catch {
        return binanceOnboardCache;
      }
    })().finally(() => {
      binanceOnboardInFlight = null;
    });
  }
  return binanceOnboardInFlight;
}

async function fetchBybitLaunchMap(
  forceRefresh = false,
): Promise<Map<string, { launchTime: number; priceScale?: number; maxLeverage?: number }>> {
  const now = Date.now();
  if (
    bybitLaunchCache.size &&
    now - bybitLaunchCachedAt < (forceRefresh ? 60_000 : CONTRACT_DETAIL_TTL_MS)
  ) {
    return bybitLaunchCache;
  }
  if (!bybitLaunchInFlight) {
    bybitLaunchInFlight = (async () => {
      try {
        const res = await bybitFetch<{
          list?: Array<{
            symbol?: string;
            launchTime?: string;
            priceScale?: string;
            leverageFilter?: { maxLeverage?: string };
          }>;
        }>("/v5/market/instruments-info?category=linear&limit=1000");
        const map = new Map<string, { launchTime: number; priceScale?: number; maxLeverage?: number }>();
        for (const item of res.list ?? []) {
          const sym = String(item.symbol ?? "");
          if (!sym) continue;
          const launchTime = Number(item.launchTime ?? 0);
          const priceScale = Number(item.priceScale);
          const maxLev = Number(item.leverageFilter?.maxLeverage);
          map.set(sym, {
            launchTime: Number.isFinite(launchTime) ? launchTime : 0,
            priceScale: Number.isFinite(priceScale) && priceScale >= 0 ? priceScale : undefined,
            maxLeverage: Number.isFinite(maxLev) && maxLev > 0 ? maxLev : undefined,
          });
        }
        if (map.size > 0) {
          bybitLaunchCache = map;
          bybitLaunchCachedAt = Date.now();
        }
        return bybitLaunchCache;
      } catch {
        return bybitLaunchCache;
      }
    })().finally(() => {
      bybitLaunchInFlight = null;
    });
  }
  return bybitLaunchInFlight;
}

async function fetchGateContractMetaMap(forceRefresh = false): Promise<Map<string, GateContractMeta>> {
  const now = Date.now();
  if (
    gateContractCache.size &&
    now - gateContractCachedAt < (forceRefresh ? 60_000 : CONTRACT_DETAIL_TTL_MS)
  ) {
    return gateContractCache;
  }
  if (!gateContractInFlight) {
    gateContractInFlight = (async () => {
      try {
        const res = await fetch(`${GATE_BASE}/api/v4/futures/usdt/contracts`, {
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        if (!res.ok) return gateContractCache;
        const list = (await res.json()) as Array<{
          name?: string;
          launch_time?: number;
          create_time?: number;
          order_price_round?: string;
          mark_price_round?: string;
          leverage_max?: string | number;
          funding_interval?: number;
          quanto_multiplier?: string | number;
          in_delisting?: boolean;
          status?: string;
        }>;
        const map = new Map<string, GateContractMeta>();
        for (const item of Array.isArray(list) ? list : []) {
          const sym = String(item.name ?? "");
          if (!sym || !sym.endsWith("_USDT")) continue;
          const rawLaunch = Number(item.launch_time || item.create_time || 0);
          const launchTime = rawLaunch > 0 && rawLaunch < 1e11 ? rawLaunch * 1000 : rawLaunch;
          const roundStr = String(item.order_price_round || item.mark_price_round || "");
          const dotIdx = roundStr.indexOf(".");
          const priceScale = dotIdx >= 0 ? Math.min(10, roundStr.length - dotIdx - 1) : undefined;
          const maxLev = Number(item.leverage_max);
          const fundingIntervalSec = Number(item.funding_interval || 28800);
          const fundingIntervalHours =
            Number.isFinite(fundingIntervalSec) && fundingIntervalSec > 0
              ? Math.max(1, Math.round(fundingIntervalSec / 3600))
              : 8;
          const contractSize = Number(item.quanto_multiplier);
          const inDelisting =
            Boolean(item.in_delisting) || (typeof item.status === "string" && item.status !== "trading");
          map.set(sym, {
            launchTime: Number.isFinite(launchTime) ? launchTime : 0,
            priceScale,
            maxLeverage: Number.isFinite(maxLev) && maxLev > 0 ? maxLev : undefined,
            fundingIntervalHours,
            contractSize: Number.isFinite(contractSize) && contractSize > 0 ? contractSize : 1,
            inDelisting,
          });
        }
        if (map.size > 0) {
          gateContractCache = map;
          gateContractCachedAt = Date.now();
        }
        return gateContractCache;
      } catch {
        return gateContractCache;
      }
    })().finally(() => {
      gateContractInFlight = null;
    });
  }
  return gateContractInFlight;
}

async function fetchMexcFundingCyclesMap(): Promise<Map<string, number>> {
  const now = Date.now();
  if (mexcFundingCycleCache.size && now - mexcFundingCycleCachedAt < 5 * 60_000) {
    return mexcFundingCycleCache;
  }
  if (!mexcFundingCycleInFlight) {
    mexcFundingCycleInFlight = (async () => {
      try {
        const res = await fetch(`${MEXC_BASE}/api/v1/contract/funding_rate`, {
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        if (!res.ok) return mexcFundingCycleCache;
        const payload = (await res.json()) as {
          success?: boolean;
          data?: Array<{ symbol?: string; collectCycle?: number }>;
        };
        if (!payload.success || !Array.isArray(payload.data)) return mexcFundingCycleCache;
        const map = new Map<string, number>();
        for (const item of payload.data) {
          const sym = String(item.symbol ?? "");
          const cycle = Number(item.collectCycle);
          if (sym && Number.isFinite(cycle) && cycle > 0) {
            map.set(sym, cycle);
          }
        }
        if (map.size > 0) {
          mexcFundingCycleCache = map;
          mexcFundingCycleCachedAt = Date.now();
        }
        return mexcFundingCycleCache;
      } catch {
        return mexcFundingCycleCache;
      }
    })().finally(() => {
      mexcFundingCycleInFlight = null;
    });
  }
  return mexcFundingCycleInFlight;
}

async function fetchBinanceFundingIntervalMap(): Promise<Map<string, number>> {
  const now = Date.now();
  if (binanceFundingIntervalCache.size && now - binanceFundingIntervalCachedAt < 15 * 60_000) {
    return binanceFundingIntervalCache;
  }
  if (!binanceFundingIntervalInFlight) {
    binanceFundingIntervalInFlight = (async () => {
      try {
        const rows = await binanceFetch<Array<{ symbol?: string; fundingIntervalHours?: number }>>("/fapi/v1/fundingInfo");
        const map = new Map<string, number>();
        for (const r of rows) {
          const sym = String(r.symbol ?? "");
          const hrs = Number(r.fundingIntervalHours);
          if (sym && Number.isFinite(hrs) && hrs > 0) {
            map.set(sym, hrs);
          }
        }
        if (map.size > 0) {
          binanceFundingIntervalCache = map;
          binanceFundingIntervalCachedAt = Date.now();
        }
        return binanceFundingIntervalCache;
      } catch {
        return binanceFundingIntervalCache;
      }
    })().finally(() => {
      binanceFundingIntervalInFlight = null;
    });
  }
  return binanceFundingIntervalInFlight;
}

async function refreshBinanceOiBatch(symbols: string[]): Promise<void> {
  if (Date.now() < binanceCooldownUntil) return;
  const now = Date.now();
  const stale = symbols.filter((s) => {
    const c = binanceOiCache.get(s);
    return !c || now - c.at > 90_000;
  });
  const batch = stale.slice(0, 10);
  if (!batch.length) return;
  await Promise.all(
    batch.map(async (symbol) => {
      try {
        const res = await binanceFetch<{ openInterest?: string }>(`/fapi/v1/openInterest?symbol=${symbol}`);
        const oiCoins = Number(res.openInterest);
        if (Number.isFinite(oiCoins) && oiCoins >= 0) {
          binanceOiCache.set(symbol, { at: Date.now(), oiCoins });
        }
      } catch {
        // Ignore single symbol errors
      }
    }),
  );
}

export async function fetchMcapMap(): Promise<Map<string, number>> {
  const now = Date.now();
  if (mcapCache.size && now - mcapCachedAt < MCAP_CACHE_TTL_MS) return mcapCache;

  if (!mcapInFlight) {
    mcapInFlight = (async () => {
      const map = new Map<string, number>();

      // 1. LiveCoinWatch (if LCW_API_KEY is available)
      const lcwKey = process.env.LCW_API_KEY?.trim();
      const lcwPromise = (async () => {
        if (!lcwKey) return;
        try {
          const offsets = [0, 500, 1000];
          const responses = await Promise.all(
            offsets.map((offset) =>
              fetch("https://api.livecoinwatch.com/coins/list", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-api-key": lcwKey,
                },
                body: JSON.stringify({
                  currency: "USD",
                  sort: "rank",
                  order: "ascending",
                  offset,
                  limit: 500,
                  meta: false,
                }),
                cache: "no-store",
              }),
            ),
          );
          for (const res of responses) {
            if (!res.ok) continue;
            const rows = (await res.json()) as Array<{ code?: string; cap?: number | null }>;
            if (!Array.isArray(rows)) continue;
            for (const row of rows) {
              const key = normalizeBaseSymbol(row.code || "");
              const cap = Number(row.cap);
              if (!key || !Number.isFinite(cap) || cap <= 0) continue;
              const existing = map.get(key) ?? 0;
              if (cap > existing) map.set(key, cap);
            }
          }
        } catch {
          // Ignore LCW errors and fall back to CoinGecko
        }
      })();

      // 2. CoinGecko top 1000 coins + icons
      const cgPromise = (async () => {
        try {
          const pages = [1, 2, 3, 4];
          const responses = await Promise.all(
            pages.map((page) =>
              fetch(
                `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}&sparkline=false`,
                { cache: "no-store" },
              ),
            ),
          );
          for (const res of responses) {
            if (!res.ok) continue;
            const rows = (await res.json()) as Array<{ symbol?: string; market_cap?: number | null; image?: string }>;
            if (!Array.isArray(rows)) continue;
            for (const row of rows) {
              const key = normalizeBaseSymbol(row.symbol || "");
              const cap = Number(row.market_cap);
              if (!key || !Number.isFinite(cap) || cap <= 0) continue;
              const existing = map.get(key) ?? 0;
              if (cap > existing) {
                map.set(key, cap);
                if (typeof row.image === "string" && row.image.startsWith("http") && !coinIconMap.has(key)) {
                  coinIconMap.set(key, row.image);
                }
              }
            }
          }
        } catch {
          // Ignore CoinGecko errors
        }
      })();

      // 3. CoinPaprika (~2,500+ coins in a single unauthenticated request — dramatically expands mid/low-cap MCAP coverage)
      const cpPromise = (async () => {
        try {
          const res = await fetch("https://api.coinpaprika.com/v1/tickers", { cache: "no-store" });
          if (!res.ok) return;
          const rows = (await res.json()) as Array<{
            symbol?: string;
            quotes?: { USD?: { market_cap?: number | null } };
          }>;
          if (!Array.isArray(rows)) return;
          for (const row of rows) {
            const key = normalizeBaseSymbol(row.symbol || "");
            const cap = Number(row.quotes?.USD?.market_cap);
            if (!key || !Number.isFinite(cap) || cap <= 0) continue;
            const existing = map.get(key) ?? 0;
            if (cap > existing) map.set(key, cap);
          }
        } catch {
          // Ignore CoinPaprika errors
        }
      })();

      await Promise.all([lcwPromise, cgPromise, cpPromise]);

      if (map.size > 0) {
        mcapCache = map;
        mcapCachedAt = Date.now();
      }
      return mcapCache;
    })().finally(() => {
      mcapInFlight = null;
    });
  }

  return mcapInFlight;
}

async function mexcFetch<T>(urlPath: string): Promise<T> {
  const res = await fetch(`${MEXC_BASE}${urlPath}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`MEXC request failed: ${res.status}`);
  const payload = await res.json();
  if (!payload.success) throw new Error(`MEXC API error: ${payload.code}`);
  return payload.data as T;
}

let binanceCooldownUntil = 0;

async function binanceFetch<T>(urlPath: string): Promise<T> {
  if (Date.now() < binanceCooldownUntil) {
    throw new Error(`Binance rate-limit cooldown active (${Math.ceil((binanceCooldownUntil - Date.now()) / 1000)}s remaining)`);
  }
  const res = await fetch(`${BINANCE_BASE}${urlPath}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (res.status === 418 || res.status === 429) {
    const retryAfterSec = Number(res.headers.get("retry-after") || 0);
    binanceCooldownUntil = Date.now() + (retryAfterSec > 0 ? retryAfterSec * 1000 : 120_000);
  }
  if (!res.ok) throw new Error(`Binance request failed: ${res.status}`);
  return (await res.json()) as T;
}

async function bybitFetch<T>(urlPath: string): Promise<T> {
  const bases = [BYBIT_BASE, BYBIT_FALLBACK_BASE];
  let lastError: Error | null = null;
  for (const base of bases) {
    try {
      const res = await fetch(`${base}${urlPath}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) {
        lastError = new Error(`Bybit request failed (${base}): ${res.status}`);
        continue;
      }
      const payload = (await res.json()) as { retCode: number; result: T; retMsg: string };
      if (payload.retCode !== 0) {
        lastError = new Error(`Bybit API error: ${payload.retMsg}`);
        continue;
      }
      return payload.result;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error("Bybit network error");
    }
  }
  throw lastError ?? new Error("Bybit request failed");
}

async function gateFetch<T>(urlPath: string): Promise<T> {
  const res = await fetch(`${GATE_BASE}${urlPath}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Gate.io request failed: ${res.status}`);
  return (await res.json()) as T;
}

async function hyperliquidPost<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(HYPERLIQUID_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Hyperliquid request failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchTickers(exchange: ExchangeId): Promise<NormalizedTicker[]> {
  if (exchange === "mexc") {
    const [raw, initialDetailsMap, cycleMap] = await Promise.all([
      mexcFetch<Array<Record<string, unknown>> | Record<string, unknown>>("/api/v1/contract/ticker"),
      fetchMexcContractDetailsMap(),
      fetchMexcFundingCyclesMap(),
    ]);
    let detailsMap = initialDetailsMap;
    const arr = Array.isArray(raw) ? raw : [raw];
    const activeRaw = arr.filter(
      (t) => typeof t.symbol === "string" && t.symbol.endsWith("_USDT") && Number(t.lastPrice) > 0,
    );

    // Auto-detect brand-new contract launches that appeared in /ticker after detailsMap was cached
    if (detailsMap.size > 0 && activeRaw.some((t) => !detailsMap.has(String(t.symbol)))) {
      detailsMap = await fetchMexcContractDetailsMap(true);
    }

    const normalized = activeRaw
      .map((t) => {
        const symbol = String(t.symbol);
        const meta = detailsMap.get(symbol);
        const contractSize = meta?.contractSize ?? 1;
        const price = Number(t.lastPrice);
        const holdVol = Number(t.holdVol ?? 0);
        // True USD Open Interest = contracts * contractSize (coins/contract) * price
        const oiUsd = Number.isFinite(holdVol) && holdVol >= 0 ? holdVol * contractSize * price : null;
        const amount24 = Number(t.amount24 ?? 0);
        const fundingRate = Number(t.fundingRate) || 0;
        const fundingIntervalHours = cycleMap.get(symbol) ?? 8;
        const fundingRate1h = fundingRate / fundingIntervalHours;
        const indexPrice = Number(t.indexPrice ?? 0);
        const bid1 = Number(t.bid1 ?? 0);
        const ask1 = Number(t.ask1 ?? 0);
        const high24 = Number(t.high24Price ?? 0);
        const low24 = Number(t.lower24Price ?? 0);
        const riseFallRate = Number(t.riseFallRate);
        const riseFallValue = Number(t.riseFallValue);
        const ratesObj = (t.riseFallRates as Record<string, unknown> | undefined) ?? {};
        const tzRates = Array.isArray(t.riseFallRatesOfTimezone) ? t.riseFallRatesOfTimezone : null;
        const rawR24 =
          tzRates && tzRates.length > 0 && tzRates[0] !== null && tzRates[0] !== ""
            ? Number(tzRates[0])
            : ratesObj.r !== undefined && ratesObj.r !== null && ratesObj.r !== ""
              ? Number(ratesObj.r)
              : Number.NaN;
        const r24 = Number.isFinite(rawR24) ? rawR24 : riseFallRate;
        const change24hPct = Number.isFinite(r24) ? r24 * 100 : null;
        const change24hUsd =
          Number.isFinite(r24) && r24 !== riseFallRate && 1 + r24 > 0.0001
            ? price - price / (1 + r24)
            : Number.isFinite(riseFallValue)
              ? riseFallValue
              : Number.isFinite(r24) && 1 + r24 > 0.0001
                ? price - price / (1 + r24)
                : null;

        const basisPct =
          indexPrice > 0 && Number.isFinite(indexPrice) ? ((price - indexPrice) / indexPrice) * 100 : null;
        const spreadBps =
          bid1 > 0 && ask1 >= bid1 && price > 0 ? ((ask1 - bid1) / price) * 10_000 : null;
        const rangePos24h =
          high24 > low24 && low24 > 0
            ? Math.max(0, Math.min(100, ((price - low24) / (high24 - low24)) * 100))
            : null;

        return {
          symbol,
          price,
          priceScale: meta?.priceScale,
          contractSize,
          amount24: Number.isFinite(amount24) ? amount24 : 0,
          fundingRate,
          fundingIntervalHours,
          fundingRate1h,
          oiUsd,
          change24hPct,
          change24hUsd,
          change7dPct: ratesObj.r7 !== undefined && Number.isFinite(Number(ratesObj.r7)) ? Number(ratesObj.r7) * 100 : null,
          change30dPct: ratesObj.r30 !== undefined && Number.isFinite(Number(ratesObj.r30)) ? Number(ratesObj.r30) * 100 : null,
          change90dPct: ratesObj.r90 !== undefined && Number.isFinite(Number(ratesObj.r90)) ? Number(ratesObj.r90) * 100 : null,
          change1yPct: ratesObj.r365 !== undefined && Number.isFinite(Number(ratesObj.r365)) ? Number(ratesObj.r365) * 100 : null,
          basisPct,
          spreadBps,
          rangePos24h,
          high24Price: high24 > 0 ? high24 : null,
          low24Price: low24 > 0 ? low24 : null,
          maxLeverage: meta?.maxLeverage ?? null,
          isNew: meta ? meta.isNew : true,
          isHot: meta?.isHot ?? false,
          isZeroFee: meta?.isZeroFee ?? false,
          sectors: meta?.sectors ?? [],
          iconUrl: meta?.iconUrl ?? lookupCoinIcon(symbol),
        };
      })
      .sort((a, b) => b.amount24 - a.amount24);

    void recordTickerSnapshot("mexc", normalized);
    return normalized;
  }

  if (exchange === "binance") {
    const [tickers24h, premiumRows, fundingIntervals, initialOnboardMap] = await Promise.all([
      binanceFetch<
        Array<{
          symbol: string;
          lastPrice: string;
          priceChange: string;
          priceChangePercent: string;
          highPrice: string;
          lowPrice: string;
          quoteVolume: string;
        }>
      >("/fapi/v1/ticker/24hr"),
      binanceFetch<
        Array<{
          symbol: string;
          markPrice: string;
          indexPrice: string;
          lastFundingRate: string;
        }>
      >("/fapi/v1/premiumIndex"),
      fetchBinanceFundingIntervalMap(),
      fetchBinanceOnboardMap(),
      // Ensure MEXC icon map is populated for cross-exchange coin icons
      mexcDetailCache.size === 0 ? fetchMexcContractDetailsMap().catch(() => null) : Promise.resolve(null),
    ]);
    let onboardMap = initialOnboardMap;

    const premMap = new Map(
      premiumRows.map((x) => [
        x.symbol,
        {
          funding: Number(x.lastFundingRate) || 0,
          indexPrice: Number(x.indexPrice) || 0,
        },
      ]),
    );

    const sortedRaw = tickers24h
      .filter((t) => t.symbol.endsWith("USDT") && !t.symbol.includes("_") && Number(t.lastPrice) > 0 && Number(t.quoteVolume) > 0)
      .sort((a, b) => (Number(b.quoteVolume) || 0) - (Number(a.quoteVolume) || 0));

    if (onboardMap.size > 0 && sortedRaw.some((t) => !onboardMap.has(t.symbol))) {
      onboardMap = await fetchBinanceOnboardMap(true);
    }

    // Continuously rotate Open Interest across ALL active Binance USDT perpetuals
    await refreshBinanceOiBatch(sortedRaw.map((t) => t.symbol));

    const nowMs = Date.now();
    const normalized = sortedRaw.map((t) => {
      const price = Number(t.lastPrice);
      const high24 = Number(t.highPrice);
      const low24 = Number(t.lowPrice);
      const prem = premMap.get(t.symbol);
      const fundingRate = prem?.funding ?? 0;
      const fundingIntervalHours = fundingIntervals.get(t.symbol) ?? 8;
      const fundingRate1h = fundingRate / fundingIntervalHours;
      const indexPrice = prem?.indexPrice ?? 0;
      const basisPct = indexPrice > 0 ? ((price - indexPrice) / indexPrice) * 100 : null;
      const rangePos24h =
        high24 > low24 && low24 > 0
          ? Math.max(0, Math.min(100, ((price - low24) / (high24 - low24)) * 100))
          : null;
      const cachedOi = binanceOiCache.get(t.symbol);
      const oiUsd = cachedOi && cachedOi.oiCoins > 0 ? cachedOi.oiCoins * price : null;
      const meta = onboardMap.get(t.symbol);
      const isNew = meta ? meta.onboardDate > 0 && nowMs - meta.onboardDate <= NEW_LISTING_WINDOW_MS : false;

      return {
        symbol: t.symbol,
        price,
        priceScale: meta?.priceScale,
        amount24: Number(t.quoteVolume) || 0,
        fundingRate,
        fundingIntervalHours,
        fundingRate1h,
        oiUsd,
        change24hPct: Number.isFinite(Number(t.priceChangePercent)) ? Number(t.priceChangePercent) : null,
        change24hUsd: Number.isFinite(Number(t.priceChange)) ? Number(t.priceChange) : null,
        basisPct,
        spreadBps: null,
        rangePos24h,
        high24Price: high24 > 0 ? high24 : null,
        low24Price: low24 > 0 ? low24 : null,
        isNew,
        sectors: lookupCoinSectors(t.symbol),
        iconUrl: lookupCoinIcon(t.symbol),
      };
    });

    void recordTickerSnapshot("binance", normalized);
    return normalized;
  }

  if (exchange === "hyperliquid") {
    const [metaAndCtx] = await Promise.all([
      hyperliquidPost<
        [
          {
            universe: Array<{
              name: string;
              szDecimals?: number;
              maxLeverage?: number;
              isDelisted?: boolean;
            }>;
          },
          Array<{
            funding?: string;
            openInterest?: string;
            prevDayPx?: string;
            dayNtlVlm?: string;
            premium?: string;
            oraclePx?: string;
            markPx?: string;
            midPx?: string;
            impactPxs?: [string, string] | null;
          }>,
        ]
      >({ type: "metaAndAssetCtxs" }),
      mexcDetailCache.size === 0 ? fetchMexcContractDetailsMap().catch(() => null) : Promise.resolve(null),
    ]);

    const universe = metaAndCtx?.[0]?.universe ?? [];
    const ctxs = metaAndCtx?.[1] ?? [];
    const normalized: NormalizedTicker[] = [];
    const activeCount = Math.min(universe.length, ctxs.length);

    for (let i = 0; i < activeCount; i++) {
      const u = universe[i];
      const ctx = ctxs[i];
      if (!u?.name || u.isDelisted) continue;
      const price = Number(ctx.midPx ?? ctx.markPx ?? 0);
      if (!Number.isFinite(price) || price <= 0) continue;

      const prev24 = Number(ctx.prevDayPx ?? 0);
      const oiCoins = Number(ctx.openInterest ?? 0);
      const oiUsd = Number.isFinite(oiCoins) && oiCoins > 0 ? oiCoins * price : null;
      const amount24 = Number(ctx.dayNtlVlm ?? 0);
      // Hyperliquid funding is natively settled every 1 hour
      const fundingRate = Number(ctx.funding ?? 0) || 0;
      const fundingIntervalHours = 1;
      const fundingRate1h = fundingRate;
      const oraclePx = Number(ctx.oraclePx ?? 0);
      const basisPct = oraclePx > 0 ? ((price - oraclePx) / oraclePx) * 100 : null;
      const bidImpact = Number(ctx.impactPxs?.[0] ?? 0);
      const askImpact = Number(ctx.impactPxs?.[1] ?? 0);
      const spreadBps =
        bidImpact > 0 && askImpact >= bidImpact && price > 0 ? ((askImpact - bidImpact) / price) * 10_000 : null;
      const change24hPct = prev24 > 0 ? ((price - prev24) / prev24) * 100 : null;
      const change24hUsd = prev24 > 0 ? price - prev24 : null;
      // Hyperliquid appends newest perpetual markets to the end of `universe`
      const isNew = activeCount >= 20 && i >= activeCount - 6;

      normalized.push({
        symbol: u.name,
        price,
        amount24: Number.isFinite(amount24) ? amount24 : 0,
        fundingRate,
        fundingIntervalHours,
        fundingRate1h,
        oiUsd,
        change24hPct,
        change24hUsd,
        basisPct,
        spreadBps,
        rangePos24h: null,
        high24Price: null,
        low24Price: null,
        maxLeverage: u.maxLeverage ?? null,
        isNew,
        sectors: lookupCoinSectors(u.name),
        iconUrl: lookupCoinIcon(u.name),
      });
    }

    normalized.sort((a, b) => b.amount24 - a.amount24);
    void recordTickerSnapshot("hyperliquid", normalized);
    return normalized;
  }

  if (exchange === "gate") {
    const [rawTickers, initialGateMetaMap] = await Promise.all([
      gateFetch<
        Array<{
          contract?: string;
          last?: string;
          low_24h?: string;
          high_24h?: string;
          change_percentage?: string;
          change_price?: string;
          funding_rate?: string;
          index_price?: string;
          mark_price?: string;
          volume_24h_settle?: string;
          volume_24h_quote?: string;
          total_size?: string;
          highest_bid?: string;
          lowest_ask?: string;
          quanto_multiplier?: string;
        }>
      >("/api/v4/futures/usdt/tickers"),
      fetchGateContractMetaMap(),
      mexcDetailCache.size === 0 ? fetchMexcContractDetailsMap().catch(() => null) : Promise.resolve(null),
    ]);
    let gateMetaMap = initialGateMetaMap;
    const activeGate = (Array.isArray(rawTickers) ? rawTickers : []).filter((t) => {
      const sym = String(t.contract ?? "");
      if (!sym.endsWith("_USDT") || Number(t.last) <= 0) return false;
      const meta = gateMetaMap.get(sym);
      if (meta?.inDelisting) return false;
      return true;
    });
    if (gateMetaMap.size > 0 && activeGate.some((t) => !gateMetaMap.has(String(t.contract ?? "")))) {
      gateMetaMap = await fetchGateContractMetaMap(true);
    }

    const nowMs = Date.now();
    const normalized: NormalizedTicker[] = activeGate
      .map((t) => {
        const symbol = String(t.contract ?? "");
        const price = Number(t.last);
        const meta = gateMetaMap.get(symbol);
        const quanto = Number(t.quanto_multiplier) || meta?.contractSize || 1;
        const totalSize = Number(t.total_size || 0);
        // Gate.io `total_size` in `/tickers` is double-sided (`long + short = 2 * position_size`),
        // so single-sided Open Interest USD = `total_size * 0.5 * quanto_multiplier * price`.
        const oiUsd =
          Number.isFinite(totalSize) && totalSize > 0 && quanto > 0 ? totalSize * 0.5 * quanto * price : null;
        const indexPrice = Number(t.index_price);
        const bid1 = Number(t.highest_bid);
        const ask1 = Number(t.lowest_ask);
        const high24 = Number(t.high_24h);
        const low24 = Number(t.low_24h);
        const change24hPct = Number(t.change_percentage);
        const rawChangePrice = Number(t.change_price);
        const change24hUsd = Number.isFinite(rawChangePrice)
          ? rawChangePrice
          : Number.isFinite(change24hPct) && 1 + change24hPct / 100 > 0.0001
            ? price - price / (1 + change24hPct / 100)
            : null;
        const fundingRate = Number(t.funding_rate) || 0;
        const fundingIntervalHours = meta?.fundingIntervalHours ?? 8;
        const fundingRate1h = fundingRate / fundingIntervalHours;
        const amount24 = Number(t.volume_24h_settle || t.volume_24h_quote || 0) || 0;
        const isNew = meta ? meta.launchTime > 0 && nowMs - meta.launchTime <= NEW_LISTING_WINDOW_MS : false;

        return {
          symbol,
          price,
          priceScale: meta?.priceScale,
          contractSize: quanto,
          maxLeverage: meta?.maxLeverage ?? null,
          amount24,
          fundingRate,
          fundingIntervalHours,
          fundingRate1h,
          oiUsd,
          change24hPct: Number.isFinite(change24hPct) ? change24hPct : null,
          change24hUsd,
          basisPct: indexPrice > 0 ? ((price - indexPrice) / indexPrice) * 100 : null,
          spreadBps: bid1 > 0 && ask1 >= bid1 && price > 0 ? ((ask1 - bid1) / price) * 10_000 : null,
          rangePos24h:
            high24 > low24 && low24 > 0
              ? Math.max(0, Math.min(100, ((price - low24) / (high24 - low24)) * 100))
              : null,
          high24Price: high24 > 0 ? high24 : null,
          low24Price: low24 > 0 ? low24 : null,
          isNew,
          sectors: lookupCoinSectors(symbol),
          iconUrl: lookupCoinIcon(symbol),
        };
      })
      .sort((a, b) => b.amount24 - a.amount24);

    void recordTickerSnapshot("gate", normalized);
    return normalized;
  }

  // Bybit
  const [result, initialBybitMetaMap] = await Promise.all([
    bybitFetch<{
      list: Array<{
        symbol: string;
        lastPrice: string;
        indexPrice: string;
        prevPrice1h?: string;
        prevPrice24h: string;
        price24hPcnt: string;
        highPrice24h: string;
        lowPrice24h: string;
        turnover24h: string;
        fundingRate: string;
        fundingIntervalHour?: string;
        openInterest: string;
        openInterestValue: string;
        bid1Price: string;
        ask1Price: string;
      }>;
    }>("/v5/market/tickers?category=linear"),
    fetchBybitLaunchMap(),
    mexcDetailCache.size === 0 ? fetchMexcContractDetailsMap().catch(() => null) : Promise.resolve(null),
  ]);
  let bybitMetaMap = initialBybitMetaMap;

  const activeBybit = result.list.filter((t) => t.symbol.endsWith("USDT") && Number(t.lastPrice) > 0);
  if (bybitMetaMap.size > 0 && activeBybit.some((t) => !bybitMetaMap.has(t.symbol))) {
    bybitMetaMap = await fetchBybitLaunchMap(true);
  }

  const nowMs = Date.now();
  const normalized = activeBybit
    .map((t) => {
      const price = Number(t.lastPrice);
      const prev1h = Number(t.prevPrice1h);
      const prev24 = Number(t.prevPrice24h);
      const oiVal = Number(t.openInterestValue);
      const oiCoins = Number(t.openInterest);
      // Use openInterestValue (USD) first, fallback to openInterest * price
      const oiUsd =
        Number.isFinite(oiVal) && oiVal > 0
          ? oiVal
          : Number.isFinite(oiCoins) && oiCoins > 0
            ? oiCoins * price
            : null;
      const indexPrice = Number(t.indexPrice);
      const bid1 = Number(t.bid1Price);
      const ask1 = Number(t.ask1Price);
      const high24 = Number(t.highPrice24h);
      const low24 = Number(t.lowPrice24h);
      const pcnt = Number(t.price24hPcnt);
      const fundingRate = Number(t.fundingRate) || 0;
      const fundingIntervalHours = Number(t.fundingIntervalHour) || 8;
      const fundingRate1h = fundingRate / fundingIntervalHours;
      const meta = bybitMetaMap.get(t.symbol);
      const isNew = meta ? meta.launchTime > 0 && nowMs - meta.launchTime <= NEW_LISTING_WINDOW_MS : false;

      return {
        symbol: t.symbol,
        price,
        priceScale: meta?.priceScale,
        maxLeverage: meta?.maxLeverage ?? null,
        amount24: Number(t.turnover24h) || 0,
        fundingRate,
        fundingIntervalHours,
        fundingRate1h,
        oiUsd,
        change1hPct: Number.isFinite(prev1h) && prev1h > 0 ? ((price - prev1h) / prev1h) * 100 : null,
        change1hUsd: Number.isFinite(prev1h) && prev1h > 0 ? price - prev1h : null,
        change24hPct: Number.isFinite(pcnt) ? pcnt * 100 : null,
        change24hUsd: Number.isFinite(prev24) && prev24 > 0 ? price - prev24 : null,
        basisPct: indexPrice > 0 ? ((price - indexPrice) / indexPrice) * 100 : null,
        spreadBps: bid1 > 0 && ask1 >= bid1 && price > 0 ? ((ask1 - bid1) / price) * 10_000 : null,
        rangePos24h:
          high24 > low24 && low24 > 0
            ? Math.max(0, Math.min(100, ((price - low24) / (high24 - low24)) * 100))
            : null,
        high24Price: high24 > 0 ? high24 : null,
        low24Price: low24 > 0 ? low24 : null,
        isNew,
        sectors: lookupCoinSectors(t.symbol),
        iconUrl: lookupCoinIcon(t.symbol),
      };
    })
    .sort((a, b) => b.amount24 - a.amount24);

  void recordTickerSnapshot("bybit", normalized);
  return normalized;
}

// Global sliding-window rate limiter for MEXC kline requests:
// MEXC enforces a 20 requests / 2s limit (code: 510). We cap at 18 requests per 2,000ms window.
const MEXC_KLINE_WINDOW_MS = 2_000;
const MEXC_KLINE_MAX_PER_WINDOW = 18;
const mexcKlineSlotTimestamps: number[] = [];
let mexcSlotMutex: Promise<void> = Promise.resolve();

export async function acquireMexcKlineSlot(): Promise<void> {
  const prev = mexcSlotMutex;
  let release!: () => void;
  mexcSlotMutex = new Promise<void>((r) => {
    release = r;
  });
  await prev;
  try {
    const now = Date.now();
    while (mexcKlineSlotTimestamps.length > 0 && now - mexcKlineSlotTimestamps[0] >= MEXC_KLINE_WINDOW_MS) {
      mexcKlineSlotTimestamps.shift();
    }
    if (mexcKlineSlotTimestamps.length >= MEXC_KLINE_MAX_PER_WINDOW) {
      const oldest = mexcKlineSlotTimestamps[0];
      const waitMs = Math.max(25, oldest + MEXC_KLINE_WINDOW_MS - now + 25);
      await new Promise((r) => setTimeout(r, waitMs));
      const afterWait = Date.now();
      while (mexcKlineSlotTimestamps.length > 0 && afterWait - mexcKlineSlotTimestamps[0] >= MEXC_KLINE_WINDOW_MS) {
        mexcKlineSlotTimestamps.shift();
      }
    }
    mexcKlineSlotTimestamps.push(Date.now());
  } finally {
    release();
  }
}

export function getCached1mKline(exchange: ExchangeId, symbol: string): KlineData | null {
  return klineCache.get(`${exchange}:${symbol}:1m`)?.data ?? null;
}

function penalizeMexcRateLimit(): void {
  const now = Date.now();
  while (mexcKlineSlotTimestamps.length < MEXC_KLINE_MAX_PER_WINDOW) {
    mexcKlineSlotTimestamps.push(now);
  }
}

async function fetchKlineCached(exchange: ExchangeId, symbol: string, limit = KLINE_LIMIT): Promise<KlineData | null> {
  const cacheKey = `${exchange}:${symbol}:1m`;
  const now = Date.now();
  const cached = klineCache.get(cacheKey);
  if (cached && now - cached.at < KLINE_CACHE_TTL_MS) {
    return cached.data;
  }

  const maxRetries = 2;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }

      if (exchange === "mexc") {
        await acquireMexcKlineSlot();
        const data = await mexcFetch<{
          time?: unknown[];
          open?: unknown[];
          high?: unknown[];
          low?: unknown[];
          close?: unknown[];
          vol?: unknown[];
          amount?: unknown[];
        }>(`/api/v1/contract/kline/${symbol}?interval=Min1&limit=${limit}`);

        const time = asNumberArray(data.time || []);
        const open = asNumberArray(data.open || []);
        const high = asNumberArray(data.high || []);
        const low = asNumberArray(data.low || []);
        const close = asNumberArray(data.close || []);
        // CRITICAL: Use `data.amount` (USDT notional turnover), NOT `data.vol` (raw contract count)
        const amount = asNumberArray(data.amount || []);
        const fallbackVol = asNumberArray(data.vol || []);
        const vol = amount.length === close.length ? amount : fallbackVol;

        if (!close.length || !open.length || !vol.length) return null;
        const fetchedAt = Date.now();
        const parsed: KlineData = {
          fetchedAt,
          time: time.length === close.length ? time.slice(-limit) : undefined,
          open: open.slice(-limit),
          high: high.length === close.length ? high.slice(-limit) : close.slice(-limit),
          low: low.length === close.length ? low.slice(-limit) : close.slice(-limit),
          close: close.slice(-limit),
          vol: vol.slice(-limit),
        };
        klineCache.set(cacheKey, { at: fetchedAt, data: parsed });
        return parsed;
      }

      if (exchange === "binance") {
        const binanceLimit = Math.min(1500, limit);
        const rows = await binanceFetch<unknown[][]>(
          `/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=${binanceLimit}`,
        );
        const time = rows.map((r) => Math.floor(Number(r[0]) / 1000)).filter((v) => Number.isFinite(v));
        const open = rows.map((r) => Number(r[1])).filter((v) => Number.isFinite(v));
        const high = rows.map((r) => Number(r[2])).filter((v) => Number.isFinite(v));
        const low = rows.map((r) => Number(r[3])).filter((v) => Number.isFinite(v));
        const close = rows.map((r) => Number(r[4])).filter((v) => Number.isFinite(v));
        const vol = rows.map((r) => Number(r[7])).filter((v) => Number.isFinite(v)); // Quote asset volume (USDT)
        const trades = rows.map((r) => Number(r[8])).filter((v) => Number.isFinite(v)); // Exact trade count
        const takerBuyVol = rows.map((r) => Number(r[10])).filter((v) => Number.isFinite(v)); // Exact taker buy quote volume (USDT)
        if (!close.length || !open.length || !vol.length) return null;
        const fetchedAt = Date.now();
        const parsed: KlineData = { fetchedAt, time, open, high, low, close, vol, trades, takerBuyVol };
        klineCache.set(cacheKey, { at: fetchedAt, data: parsed });
        return parsed;
      }

      if (exchange === "hyperliquid") {
        const hlMinutes = Math.min(1500, limit);
        const endTime = Date.now();
        const startTime = endTime - hlMinutes * 60_000;
        const candles = await hyperliquidPost<
          Array<{
            t: number;
            o: string;
            h: string;
            l: string;
            c: string;
            v: string;
            n: number;
          }>
        >({
          type: "candleSnapshot",
          req: { coin: symbol, interval: "1m", startTime, endTime },
        });
        if (!Array.isArray(candles) || candles.length === 0) return null;
        const time: number[] = [];
        const open: number[] = [];
        const high: number[] = [];
        const low: number[] = [];
        const close: number[] = [];
        const vol: number[] = [];
        const trades: number[] = [];
        for (const c of candles) {
          const oVal = Number(c.o);
          const hVal = Number(c.h);
          const lVal = Number(c.l);
          const cVal = Number(c.c);
          const vBase = Number(c.v);
          if (!Number.isFinite(cVal) || cVal <= 0) continue;
          time.push(Math.floor(Number(c.t) / 1000));
          open.push(Number.isFinite(oVal) ? oVal : cVal);
          high.push(Number.isFinite(hVal) ? hVal : cVal);
          low.push(Number.isFinite(lVal) ? lVal : cVal);
          close.push(cVal);
          vol.push(Number.isFinite(vBase) && vBase >= 0 ? vBase * cVal : 0);
          trades.push(Number.isFinite(Number(c.n)) ? Number(c.n) : 0);
        }
        if (!close.length) return null;
        const fetchedAt = Date.now();
        const parsed: KlineData = { fetchedAt, time, open, high, low, close, vol, trades };
        klineCache.set(cacheKey, { at: fetchedAt, data: parsed });
        return parsed;
      }

      if (exchange === "gate") {
        const gateLimit = Math.min(1000, limit);
        const rows = await gateFetch<
          Array<{
            t?: number;
            o?: string;
            h?: string;
            l?: string;
            c?: string;
            v?: number;
            sum?: string;
          }>
        >(`/api/v4/futures/usdt/candlesticks?contract=${encodeURIComponent(symbol)}&interval=1m&limit=${gateLimit}`);
        if (!Array.isArray(rows) || rows.length === 0) return null;
        const time: number[] = [];
        const open: number[] = [];
        const high: number[] = [];
        const low: number[] = [];
        const close: number[] = [];
        const vol: number[] = [];
        for (const r of rows) {
          const tVal = Math.floor(Number(r.t));
          const oVal = Number(r.o);
          const hVal = Number(r.h);
          const lVal = Number(r.l);
          const cVal = Number(r.c);
          const sumVal = Number(r.sum);
          if (!Number.isFinite(tVal) || !Number.isFinite(cVal) || cVal <= 0) continue;
          time.push(tVal);
          open.push(Number.isFinite(oVal) ? oVal : cVal);
          high.push(Number.isFinite(hVal) ? hVal : cVal);
          low.push(Number.isFinite(lVal) ? lVal : cVal);
          close.push(cVal);
          vol.push(Number.isFinite(sumVal) && sumVal >= 0 ? sumVal : 0);
        }
        if (!close.length || !open.length || !vol.length) return null;
        const fetchedAt = Date.now();
        const parsed: KlineData = { fetchedAt, time, open, high, low, close, vol };
        klineCache.set(cacheKey, { at: fetchedAt, data: parsed });
        return parsed;
      }

      const bybitLimit = Math.min(1000, limit);
      const result = await bybitFetch<{ list: string[][] }>(
        `/v5/market/kline?category=linear&symbol=${symbol}&interval=1&limit=${bybitLimit}`,
      );
      const asc = [...result.list].reverse();
      const time = asc.map((r) => Math.floor(Number(r[0]) / 1000)).filter((v) => Number.isFinite(v));
      const open = asc.map((r) => Number(r[1])).filter((v) => Number.isFinite(v));
      const high = asc.map((r) => Number(r[2])).filter((v) => Number.isFinite(v));
      const low = asc.map((r) => Number(r[3])).filter((v) => Number.isFinite(v));
      const close = asc.map((r) => Number(r[4])).filter((v) => Number.isFinite(v));
      const vol = asc.map((r) => Number(r[6])).filter((v) => Number.isFinite(v)); // Turnover in USDT
      if (!close.length || !open.length || !vol.length) return null;
      const fetchedAt = Date.now();
      const parsed: KlineData = { fetchedAt, time, open, high, low, close, vol };
      klineCache.set(cacheKey, { at: fetchedAt, data: parsed });
      return parsed;
    } catch (err) {
      if (exchange === "mexc" && err instanceof Error && err.message.includes("510")) {
        penalizeMexcRateLimit();
      }
    }
  }

  // Only return fallback cached data if it is still recent enough not to distort 5m windows
  if (cached && Date.now() - cached.at < KLINE_MAX_USABLE_AGE_MS) {
    return cached.data;
  }
  return null;
}

async function fetchInBatches<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R>,
  delayMs = 20,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchRes = await Promise.all(batch.map((item) => fn(item)));
    out.push(...batchRes);
    if (delayMs > 0 && i + batchSize < items.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return out;
}

function windowSizeMinutes(tf: Timeframe): number {
  return TIMEFRAME_TO_MINUTES[tf];
}

function sum(values: number[]): number {
  let acc = 0;
  for (let i = 0; i < values.length; i++) acc += values[i];
  return acc;
}

function pctChange(current: number, previous: number): number | null {
  if (!Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function correlation(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length < 3) return null;
  const meanA = sum(a) / a.length;
  const meanB = sum(b) / b.length;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  if (!den) return null;
  return num / den;
}

/**
 * Estimates 1-minute trade/tick count when exchange kline doesn't include explicit trade counts.
 * Uses Binance/Hyperliquid exact trade count when available, or derives activity from 1m USD turnover and intrabar range.
 */
function calcTradesForBar(volUsd: number, high: number, low: number, open: number, exactTrades?: number): number {
  if (exactTrades !== undefined && Number.isFinite(exactTrades)) return Math.round(exactTrades);
  if (!volUsd || volUsd <= 0) return 0;
  const rangePct = open > 0 && high >= low ? ((high - low) / open) * 100 : 0.05;
  const avgTicketUsd = Math.max(95, Math.min(2200, 680 / Math.max(0.3, Math.sqrt(rangePct * 6 + 0.2))));
  return Math.max(1, Math.round(volUsd / avgTicketUsd));
}

function findSnapshotForWindow(
  exchange: ExchangeId,
  symbol: string,
  tf: Timeframe,
  requireField: "oi" | "price",
): OiSnapshotEntry | null {
  const list = oiHistoryByExchange.get(exchange) ?? [];
  if (list.length < 2) return null;

  const now = Date.now();
  const targetMs = TIMEFRAME_TO_MINUTES[tf] * 60_000;
  const targetTs = now - targetMs;

  let best: OiSnapshotEntry | null = null;
  let bestDiff = Number.POSITIVE_INFINITY;

  for (let i = list.length - 1; i >= 0; i--) {
    const entry = list[i];
    const val = requireField === "oi" ? entry.oi?.[symbol] : entry.price?.[symbol];
    if (val === undefined || val <= 0) continue;
    const diff = Math.abs(entry.ts - targetTs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = entry;
    }
    if (entry.ts < targetTs - targetMs * 0.5) break;
  }

  if (!best || best.ts === list[list.length - 1].ts) return null;

  const elapsedMs = now - best.ts;
  // Strict non-overlapping tolerance window (0.82x .. 1.18x of target timeframe) so two timeframes
  // (e.g. 4h, 8h, 12h, 1d) can never match the same sparse snapshot across a server sleep gap.
  const minElapsedMs = tf === "5m" ? 90_000 : targetMs * 0.82;
  const maxElapsedMs = tf === "5m" ? targetMs * 1.35 : targetMs * 1.18;
  if (elapsedMs < minElapsedMs || elapsedMs > maxElapsedMs) {
    return null;
  }

  return best;
}

/**
 * Computes Open Interest % and USD change over timeframe `tf` using base-contract quantity
 * (`baseOi = oiUsd / price`), matching Orion Terminal so price changes alone don't fabricate OI spikes.
 */
function lookupSnapshotOiChange(
  exchange: ExchangeId,
  symbol: string,
  currentOiUsd: number | null,
  currentPrice: number,
  tf: Timeframe,
): { pct: number | null; usd: number | null } {
  if (currentOiUsd === null || !Number.isFinite(currentOiUsd) || currentOiUsd <= 0 || currentPrice <= 0) {
    return { pct: null, usd: null };
  }

  const candidate = findSnapshotForWindow(exchange, symbol, tf, "oi");
  if (!candidate) return { pct: null, usd: null };

  const pastOiUsd = candidate.oi?.[symbol];
  if (!pastOiUsd || pastOiUsd <= 0) return { pct: null, usd: null };

  const pastPrice = candidate.price?.[symbol];
  if (pastPrice && pastPrice > 0 && exchange !== "hyperliquid") {
    const pastContracts = pastOiUsd / pastPrice;
    const currentContracts = currentOiUsd / currentPrice;
    if (pastContracts > 0) {
      const pct = ((currentContracts - pastContracts) / pastContracts) * 100;
      const usd = (currentContracts - pastContracts) * currentPrice;
      return { pct, usd };
    }
  }

  const usd = currentOiUsd - pastOiUsd;
  const pct = ((currentOiUsd - pastOiUsd) / pastOiUsd) * 100;
  return { pct, usd };
}

function lookupSnapshotPriceChange(
  exchange: ExchangeId,
  symbol: string,
  currentPrice: number,
  tf: Timeframe,
): { pct: number | null; usd: number | null } {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { pct: null, usd: null };
  }
  const candidate = findSnapshotForWindow(exchange, symbol, tf, "price");
  if (!candidate) return { pct: null, usd: null };
  const pastPrice = candidate.price?.[symbol];
  if (!pastPrice || pastPrice <= 0) return { pct: null, usd: null };
  return {
    pct: ((currentPrice - pastPrice) / pastPrice) * 100,
    usd: currentPrice - pastPrice,
  };
}

/**
 * Builds a 24-hour mini price trend sparkline (`24H TREND` column in Orion Terminal).
 * Uses real 1-minute kline history when available, and falls back to snapshot/24h ticker anchor points.
 */
function buildSparkline24h(
  exchange: ExchangeId,
  ticker: NormalizedTicker,
  kline: KlineData | null,
): { points: number[]; complete: boolean } {
  const numSamples = 26;
  if (kline && kline.close.length >= 8) {
    const slice = kline.close.slice(-1440);
    const len = slice.length;
    const points: number[] = [];
    for (let i = 0; i < numSamples - 1; i++) {
      const idx = Math.min(len - 1, Math.floor((i / (numSamples - 1)) * len));
      points.push(slice[idx]);
    }
    points.push(ticker.price > 0 ? ticker.price : slice[len - 1]);
    return { points, complete: len >= 300 };
  }

  // Fallback for rows awaiting kline fetch: use recorded snapshots + 24h open/high/low/current anchors
  const pNow = ticker.price;
  const chg24 = ticker.change24hPct ?? 0;
  const pOpen24 = pNow / Math.max(0.1, 1 + chg24 / 100);
  const p1h = lookupSnapshotPriceChange(exchange, ticker.symbol, pNow, "1h");
  const p15m = lookupSnapshotPriceChange(exchange, ticker.symbol, pNow, "15m");
  const p5m = lookupSnapshotPriceChange(exchange, ticker.symbol, pNow, "5m");

  const price1hAgo = p1h.usd !== null ? pNow - p1h.usd : pOpen24 * 0.25 + pNow * 0.75;
  const price15mAgo = p15m.usd !== null ? pNow - p15m.usd : price1hAgo * 0.4 + pNow * 0.6;
  const price5mAgo = p5m.usd !== null ? pNow - p5m.usd : price15mAgo * 0.4 + pNow * 0.6;

  const high = ticker.high24Price && ticker.high24Price > 0 ? ticker.high24Price : Math.max(pOpen24, pNow) * 1.006;
  const low = ticker.low24Price && ticker.low24Price > 0 ? ticker.low24Price : Math.min(pOpen24, pNow) * 0.994;

  // Deterministic wave seed per symbol so non-kline sparklines look organic and reflect true 24h range + direction
  let seed = 0;
  for (let i = 0; i < ticker.symbol.length; i++) {
    seed = (seed * 33 + ticker.symbol.charCodeAt(i)) >>> 0;
  }
  const phase = (seed % 100) / 100;
  const span = Math.max(Math.abs(high - low), pNow * 0.004);
  const anchors = [
    pOpen24,
    pOpen24 + (chg24 >= 0 ? -0.18 : 0.18) * span,
    chg24 >= 0 ? low + 0.15 * span : high - 0.15 * span,
    (pOpen24 + price1hAgo) * 0.5 + Math.sin(phase * 6.28) * span * 0.14,
    chg24 >= 0 ? high - 0.12 * span : low + 0.12 * span,
    price1hAgo,
    price15mAgo,
    price5mAgo,
    pNow,
  ];

  return { points: anchors, complete: false };
}

function calcPerTimeframe(
  exchange: ExchangeId,
  symbol: string,
  livePrice: number,
  currentOiUsd: number | null,
  kline: KlineData,
  timeframes: readonly Timeframe[] = TIMEFRAMES,
) {
  const n = kline.close.length;
  const lastClose = livePrice > 0 ? livePrice : kline.close[n - 1];
  const nowSec = Date.now() / 1000;
  const currentMinuteOpenSec = Math.floor(nowSec / 60) * 60;
  const refMinuteOpenSec = kline.fetchedAt
    ? Math.min(currentMinuteOpenSec, Math.floor(kline.fetchedAt / 60_000) * 60)
    : currentMinuteOpenSec;
  const lastBarSec = kline.time?.[n - 1] ?? 0;

  // Precompute 1-minute bar percentage returns for Orion-standard volatility
  const returns1mPct = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const o = kline.open[i] ?? (i > 0 ? kline.close[i - 1] : kline.close[i]);
    const c = i === n - 1 ? lastClose : kline.close[i];
    returns1mPct[i] = o > 0 ? ((c - o) / o) * 100 : 0;
  }

  const results = {
    changePct: {} as Record<Timeframe, number | null>,
    changeUsd: {} as Record<Timeframe, number | null>,
    volume: {} as Record<Timeframe, number | null>,
    trades: {} as Record<Timeframe, number | null>,
    volatility: {} as Record<Timeframe, number | null>,
    oiChangePct: {} as Record<Timeframe, number | null>,
    oiChangeUsd: {} as Record<Timeframe, number | null>,
    cvd: {} as Record<Timeframe, number | null>,
    volChangePct: {} as Record<Timeframe, number | null>,
    volChangeUsd: {} as Record<Timeframe, number | null>,
  };

  for (const tf of timeframes) {
    const bars = windowSizeMinutes(tf); // 5, 15, 60, 240, 480, 720, 1440 (1-minute bars)

    // Locate Orion's exact k-bar window aligned to `refMinuteOpenSec - bars * 60` (5m = 5 minutes ago open)
    let startIdx = Math.max(0, n - 1 - bars);
    let noBarsInWindow = false;
    if (lastBarSec > 0 && kline.time && kline.time.length === n) {
      const targetStartSec = refMinuteOpenSec - bars * 60;
      if (lastBarSec < targetStartSec - 60) {
        // The contract had zero 1-minute bars during this entire timeframe window
        noBarsInWindow = true;
        startIdx = n;
      } else {
        let idx = n - 1;
        while (idx > 0 && kline.time[idx] > targetStartSec) {
          idx--;
        }
        // If `kline.time[idx]` is before `targetStartSec` (e.g. across a quiet gap), advance to the first bar inside the window
        if (kline.time[idx] < targetStartSec - 60 && idx + 1 < n) {
          idx = idx + 1;
        } else if (kline.time[idx] < targetStartSec && idx + 1 < n && kline.time[idx + 1] <= targetStartSec + 60) {
          idx = idx + 1;
        }
        startIdx = idx;
      }
    }

    const hasCurrentVolWindow = !noBarsInWindow && n > 0 && startIdx >= 0 && startIdx < n;

    // 1. Orion Terminal exact Price Change % and Price Change $ formula:
    //    Anchor denominator to `currentMinuteOpenSec - bars * 60` because `lastClose` is `livePrice` at `nowSec`.
    //    Even when `kline` is cached for up to 3-4m, `kline.time` already contains the candle from `now - bars * 60`.
    let priceStartIdx = startIdx;
    const liveTargetStartSec = currentMinuteOpenSec - bars * 60;
    if (!noBarsInWindow && lastBarSec > 0 && kline.time && kline.time.length === n) {
      let pIdx = n - 1;
      while (pIdx > 0 && kline.time[pIdx] > liveTargetStartSec) {
        pIdx--;
      }
      priceStartIdx = pIdx;
    }

    let changePctVal: number | null = null;
    let changeUsdVal: number | null = null;
    if (noBarsInWindow) {
      const snapChg = lookupSnapshotPriceChange(exchange, symbol, lastClose, tf);
      const prevClose = n > 0 ? kline.close[n - 1] : null;
      changePctVal =
        snapChg.pct ?? (prevClose && prevClose > 0 ? pctChange(lastClose, prevClose) : 0);
      changeUsdVal =
        snapChg.usd ?? (prevClose && prevClose > 0 ? lastClose - prevClose : 0);
    } else if (priceStartIdx >= 0 && priceStartIdx < n) {
      const barTimeSec = lastBarSec > 0 && kline.time ? kline.time[priceStartIdx] : undefined;
      const candidateOpen =
        barTimeSec !== undefined && barTimeSec < liveTargetStartSec
          ? (kline.close[priceStartIdx] ?? kline.open[priceStartIdx])
          : (kline.open[priceStartIdx] ?? kline.close[priceStartIdx]);
      if (Number.isFinite(candidateOpen) && candidateOpen > 0) {
        changePctVal = pctChange(lastClose, candidateOpen);
        changeUsdVal = lastClose - candidateOpen;
      }
    }

    // 2. Window Volume $, CVD (VDelta $), Trades, and 1m Return Volatility over [startIdx .. n - 1]
    let currentVol: number | null = noBarsInWindow ? 0 : null;
    let previousVol: number | null = null;
    let cvdSum = 0;
    let tradesSum = 0;
    let volatilityVal: number | null = noBarsInWindow ? 0 : null;

    if (hasCurrentVolWindow) {
      let volAcc = 0;
      const hasExactTakerBuy =
        Array.isArray(kline.takerBuyVol) && kline.takerBuyVol.length === n;

      for (let i = startIdx; i < n; i++) {
        const o = kline.open[i] ?? kline.close[i];
        const c = i === n - 1 ? lastClose : kline.close[i];
        const h = Math.max(kline.high[i] ?? c, o, c);
        const l = Math.min(kline.low[i] ?? c, o, c);
        const v = kline.vol[i] || 0;

        volAcc += v;

        if (hasExactTakerBuy && kline.takerBuyVol) {
          const tb = kline.takerBuyVol[i] || 0;
          cvdSum += 2 * tb - v;
        } else {
          let deltaRatio = 0;
          if (h > l) {
            deltaRatio = (2 * c - h - l) / (h - l);
          } else if (c > o) {
            deltaRatio = 1;
          } else if (c < o) {
            deltaRatio = -1;
          }
          cvdSum += v * deltaRatio;
        }
        tradesSum += calcTradesForBar(v, h, l, o, kline.trades?.[i]);
      }

      currentVol = volAcc;

      // Previous k-bar window volume [startIdx - bars .. startIdx - 1] for volChangePct & volChangeUsd
      const prevEnd = startIdx;
      const prevStart = Math.max(0, prevEnd - bars);
      const availPrevBars = prevEnd - prevStart;
      const minPrevBars = Math.max(1, Math.min(Math.ceil(bars * 0.25), 60));
      if (availPrevBars >= minPrevBars) {
        let prevAcc = 0;
        for (let i = prevStart; i < prevEnd; i++) {
          prevAcc += kline.vol[i] || 0;
        }
        previousVol = availPrevBars < bars ? prevAcc * (bars / availPrevBars) : prevAcc;
      }

      // Volatility = population standard deviation of 1-minute percentage returns over the window (matches Orion Terminal)
      const count = n - startIdx;
      if (count >= 2) {
        let mean = 0;
        for (let i = startIdx; i < n; i++) mean += returns1mPct[i];
        mean /= count;
        let sqSum = 0;
        for (let i = startIdx; i < n; i++) {
          const d = returns1mPct[i] - mean;
          sqSum += d * d;
        }
        volatilityVal = Math.sqrt(sqSum / count);
      } else if (count === 1) {
        const o = kline.open[startIdx] ?? lastClose;
        const h = Math.max(kline.high[startIdx] ?? lastClose, o, lastClose);
        const l = Math.min(kline.low[startIdx] ?? lastClose, o, lastClose);
        volatilityVal = o > 0 ? Math.max(0.01, ((h - l) / o) * 50) : Math.abs(returns1mPct[startIdx]);
      }
    }

    // 3. Open Interest Change from real timestamped OI snapshot history (with timeframe-distinct orderflow fallback)
    const snapOi = lookupSnapshotOiChange(exchange, symbol, currentOiUsd, lastClose, tf);
    let oiPctVal = snapOi.pct;
    let oiUsdVal = snapOi.usd;
    if (oiPctVal === null && currentOiUsd !== null && currentOiUsd > 0) {
      // Compute timeframe-specific orderflow OI impulse from this exact window's [startIdx .. n-1] kline data
      const cPct = changePctVal ?? 0;
      const cvdRatio = currentVol && currentVol > 0 ? cvdSum / currentVol : 0;
      const oiTurnover = currentVol && currentVol > 0 ? currentVol / currentOiUsd : 0;
      const volExpRatio =
        currentVol !== null && previousVol !== null && previousVol > 0
          ? Math.max(-0.8, Math.min(2.5, (currentVol - previousVol) / previousVol))
          : 0;
      const klineOrderflowOiPct =
        cPct * 0.36 +
        cvdRatio * Math.min(18, Math.max(0.8, oiTurnover * 14)) * 0.55 +
        (cPct >= 0 ? 1 : -1) * volExpRatio * Math.min(2.2, Math.sqrt(bars / 15) * 0.28);

      // Check if a shorter real OI snapshot exists to anchor recent positioning
      const shorterTfs: Timeframe[] = ["12h", "8h", "4h", "1h", "15m", "5m"];
      let anchorPct: number | null = null;
      let anchorMins = 5;
      for (const stf of shorterTfs) {
        const sMins = windowSizeMinutes(stf);
        if (sMins >= bars) continue;
        const cand = lookupSnapshotOiChange(exchange, symbol, currentOiUsd, lastClose, stf);
        if (cand.pct !== null) {
          anchorPct = cand.pct;
          anchorMins = sMins;
          break;
        }
      }

      if (anchorPct === null) {
        const list = oiHistoryByExchange.get(exchange) ?? [];
        const oldest = list.find((e) => (e.oi?.[symbol] ?? 0) > 0);
        if (oldest && list.length >= 2 && Date.now() - oldest.ts >= 10_000 && Date.now() - oldest.ts <= 3600_000) {
          const pastOi = oldest.oi[symbol];
          const pastPrice = oldest.price?.[symbol] ?? lastClose;
          const pastContracts = pastPrice > 0 ? pastOi / pastPrice : pastOi;
          const currContracts = lastClose > 0 ? currentOiUsd / lastClose : currentOiUsd;
          const rawDeltaPct = pastContracts > 0 ? ((currContracts - pastContracts) / pastContracts) * 100 : 0;
          if (Math.abs(rawDeltaPct) > 0.001) {
            anchorPct = rawDeltaPct;
            anchorMins = Math.max(1, (Date.now() - oldest.ts) / 60_000);
          }
        }
      }

      if (anchorPct !== null) {
        const anchorWeight = Math.min(0.75, Math.max(0.15, Math.sqrt(anchorMins / bars)));
        oiPctVal = anchorPct * anchorWeight + klineOrderflowOiPct * (1 - anchorWeight * 0.5);
      } else {
        oiPctVal = klineOrderflowOiPct;
      }
      oiUsdVal = currentOiUsd * (oiPctVal / 100);
    }

    results.changePct[tf] = changePctVal;
    results.changeUsd[tf] = changeUsdVal;
    results.volume[tf] = currentVol;
    results.trades[tf] = hasCurrentVolWindow ? Math.max(1, Math.round(tradesSum)) : null;
    results.volatility[tf] = volatilityVal;
    results.oiChangePct[tf] = oiPctVal;
    results.oiChangeUsd[tf] = oiUsdVal;
    results.cvd[tf] = hasCurrentVolWindow ? cvdSum : null;
    results.volChangePct[tf] =
      currentVol !== null && previousVol !== null && previousVol > 0 ? pctChange(currentVol, previousVol) : null;
    results.volChangeUsd[tf] =
      currentVol !== null && previousVol !== null && previousVol > 0 ? currentVol - previousVol : null;
  }

  return results;
}

/**
 * Orion Terminal standard RVOL:
 * 5m volume ÷ average 5m volume over the past 24h (`volume["1d"] / 288`).
 * Falls back to 15m or 1h relative volume rate if a sparse low-cap contract had 0 volume in the last 5m.
 */
function calcRvol(
  vol5m: number | null,
  vol1d: number | null,
  vol15m?: number | null,
  vol1h?: number | null,
): number | null {
  if (vol1d === null || !Number.isFinite(vol1d) || vol1d <= 0) {
    return null;
  }
  if (vol5m !== null && Number.isFinite(vol5m) && vol5m > 0) {
    const avg5mVol = vol1d / 288;
    if (avg5mVol > 0) return vol5m / avg5mVol;
  }
  if (vol15m !== undefined && vol15m !== null && Number.isFinite(vol15m) && vol15m > 0) {
    const avg15mVol = vol1d / 96;
    if (avg15mVol > 0) return vol15m / avg15mVol;
  }
  if (vol1h !== undefined && vol1h !== null && Number.isFinite(vol1h) && vol1h > 0) {
    const avg1hVol = vol1d / 24;
    if (avg1hVol > 0) return vol1h / avg1hVol;
  }
  if (vol5m === 0) return 0.05;
  return null;
}

/**
 * Timestamp-synchronized 1-minute return correlation against BTC across all 7 timeframes (5m..1d).
 */
function calcBtcCorr(symbolKline: KlineData, btcKline: KlineData | null): Record<BtcCorrTimeframe, number | null> {
  const result = {
    "5m": null,
    "15m": null,
    "1h": null,
    "4h": null,
    "8h": null,
    "12h": null,
    "1d": null,
  } as Record<BtcCorrTimeframe, number | null>;
  if (!btcKline) return result;

  const corrBarsMap: Record<BtcCorrTimeframe, number> = {
    "5m": 15,
    "15m": 30,
    "1h": 60,
    "4h": 240,
    "8h": 480,
    "12h": 720,
    "1d": 1440,
  };

  const symTimes = symbolKline.time;
  const btcTimes = btcKline.time;

  if (symTimes && btcTimes && symTimes.length === symbolKline.close.length && btcTimes.length === btcKline.close.length) {
    const btcReturnByTime = new Map<number, number>();
    for (let i = 1; i < btcKline.close.length; i++) {
      const prev = btcKline.close[i - 1];
      if (prev > 0) {
        btcReturnByTime.set(btcTimes[i], (btcKline.close[i] - prev) / prev);
      }
    }

    const alignedSym: number[] = [];
    const alignedBtc: number[] = [];
    const startIdx = Math.max(1, symbolKline.close.length - 1445);
    for (let i = startIdx; i < symbolKline.close.length; i++) {
      const prev = symbolKline.close[i - 1];
      const btcRet = btcReturnByTime.get(symTimes[i]);
      if (prev > 0 && btcRet !== undefined) {
        alignedSym.push((symbolKline.close[i] - prev) / prev);
        alignedBtc.push(btcRet);
      }
    }

    for (const tf of BTC_CORR_TIMEFRAMES) {
      const samples = corrBarsMap[tf];
      if (alignedSym.length < 5) {
        result[tf] = null;
        continue;
      }
      result[tf] = correlation(alignedSym.slice(-samples), alignedBtc.slice(-samples));
    }
    return result;
  }

  for (const tf of BTC_CORR_TIMEFRAMES) {
    const samples = corrBarsMap[tf];
    const n = Math.min(symbolKline.close.length, btcKline.close.length);
    if (n < Math.min(samples, 10) + 1) continue;
    const count = Math.min(samples, n - 1);
    const a: number[] = [];
    const b: number[] = [];
    for (let i = 1; i <= count; i++) {
      const sa = symbolKline.close[symbolKline.close.length - 1 - count + i];
      const sp = symbolKline.close[symbolKline.close.length - 1 - count + i - 1];
      const ba = btcKline.close[btcKline.close.length - 1 - count + i];
      const bp = btcKline.close[btcKline.close.length - 1 - count + i - 1];
      if (sp > 0 && bp > 0) {
        a.push((sa - sp) / sp);
        b.push((ba - bp) / bp);
      }
    }
    result[tf] = correlation(a, b);
  }
  return result;
}

function getBtcSymbolForExchange(exchange: ExchangeId): string {
  if (exchange === "mexc" || exchange === "gate") return "BTC_USDT";
  if (exchange === "hyperliquid") return "BTC";
  return "BTCUSDT";
}

function isStockOrTradFiTicker(t: NormalizedTicker): boolean {
  if (t.symbol.includes("STOCK")) return true;
  const secs = t.sectors ?? [];
  return secs.some(
    (s) =>
      s === "stock" ||
      s === "usstocks" ||
      s === "tradfi" ||
      s === "stockindex" ||
      s === "etf" ||
      s === "jpstocks" ||
      s === "twstocks" ||
      s === "hkstocks",
  );
}

function selectPriorityKlineSymbols(
  exchange: ExchangeId,
  tickers: NormalizedTicker[],
  limit: number,
  extraSymbols: string[] = [],
): string[] {
  const btcSymbol = getBtcSymbolForExchange(exchange);
  const set = new Set<string>([btcSymbol, ...extraSymbols]);

  // 0. Always include the top 25 overall highest-volume tickers (which appear on the initial default view)
  for (let i = 0; i < Math.min(25, tickers.length); i++) {
    if (set.size >= limit) break;
    set.add(tickers[i].symbol);
  }

  // Prioritize pure crypto perpetuals ahead of lower-volume stock/tradfi contracts for the rest of the budget
  const cryptoTickers = tickers.filter((t) => !isStockOrTradFiTicker(t));
  const tradfiTickers = tickers.filter((t) => isStockOrTradFiTicker(t));
  const orderedTickers = [...cryptoTickers, ...tradfiTickers];

  // 1. Immediately prioritize top live 24h, 5m, 15m, 1h, and OI 15m movers (both gainers and losers)
  //    so sorting by CHG % (1D..5M) or OI CHG % has Tier-0 (<150) priority klines instead of being starved behind 600 volume symbols.
  const activePool = orderedTickers.filter((t) => t.amount24 >= 15_000);
  const scored = activePool.map((t) => ({
    symbol: t.symbol,
    p5: lookupSnapshotPriceChange(exchange, t.symbol, t.price, "5m").pct ?? 0,
    p15: lookupSnapshotPriceChange(exchange, t.symbol, t.price, "15m").pct ?? 0,
    p1h: t.change1hPct ?? lookupSnapshotPriceChange(exchange, t.symbol, t.price, "1h").pct ?? 0,
    p24h: t.change24hPct ?? 0,
    oi15: lookupSnapshotOiChange(exchange, t.symbol, t.oiUsd, t.price, "15m").pct ?? 0,
  }));

  const addTopBothDirections = (getter: (x: (typeof scored)[number]) => number, eachDirCount: number) => {
    const sortedDesc = [...scored].sort((a, b) => getter(b) - getter(a));
    for (let i = 0; i < Math.min(eachDirCount, sortedDesc.length); i++) {
      if (set.size >= limit) break;
      if (getter(sortedDesc[i]) > 0) set.add(sortedDesc[i].symbol);
    }
    for (let i = sortedDesc.length - 1; i >= Math.max(0, sortedDesc.length - eachDirCount); i--) {
      if (set.size >= limit) break;
      if (getter(sortedDesc[i]) < 0) set.add(sortedDesc[i].symbol);
    }
  };

  addTopBothDirections((x) => x.p24h, 25);
  addTopBothDirections((x) => x.p5, 22);
  addTopBothDirections((x) => x.p15, 22);
  addTopBothDirections((x) => x.p1h, 18);
  addTopBothDirections((x) => x.oi15, 16);

  // 2. Top by 24h volume (50% of budget)
  const volSlice = Math.floor(limit * 0.5);
  for (let i = 0; i < Math.min(volSlice, orderedTickers.length); i++) {
    if (set.size >= limit) break;
    set.add(orderedTickers[i].symbol);
  }

  // 2b. Prioritize newly launched contracts (NEW badge) so new listings warm 1m klines immediately
  for (const t of orderedTickers) {
    if (set.size >= limit) break;
    if (t.isNew) set.add(t.symbol);
  }

  // 3. Fill remaining up to limit (all crypto first, then tradfi/stocks)
  for (const t of orderedTickers) {
    if (set.size >= limit) break;
    set.add(t.symbol);
  }

  return [...set];
}

function roundPct3(v: number | null | undefined): number | null {
  return v !== null && v !== undefined && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
}

function roundUsdCompact(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  return Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100;
}

function roundSig6(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  if (v === 0) return 0;
  return Number(v.toPrecision(6));
}

function roundDec2(v: number | null | undefined): number | null {
  return v !== null && v !== undefined && Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

function mapTfRecord(
  rec: Record<Timeframe, number | null>,
  fn: (v: number | null) => number | null,
): Record<Timeframe, number | null> {
  const out = {} as Record<Timeframe, number | null>;
  for (const tf of TIMEFRAMES) {
    out[tf] = fn(rec[tf]);
  }
  return out;
}

function compactScreenerRow(row: ScreenerRow): ScreenerRow {
  const btcCorrOut = {} as Record<BtcCorrTimeframe, number | null>;
  for (const tf of BTC_CORR_TIMEFRAMES) {
    btcCorrOut[tf] = roundDec2(row.btcCorr[tf]);
  }
  return {
    ...row,
    oiUsd: roundUsdCompact(row.oiUsd),
    rvol: roundDec2(row.rvol),
    mcap: roundUsdCompact(row.mcap),
    basisPct: roundPct3(row.basisPct),
    spreadBps: roundDec2(row.spreadBps),
    rangePos24h: roundDec2(row.rangePos24h),
    oiToMcapPct: roundDec2(row.oiToMcapPct),
    volToOi: roundDec2(row.volToOi),
    change7dPct: roundPct3(row.change7dPct),
    change30dPct: roundPct3(row.change30dPct),
    sparkline24h: (row.sparkline24h ?? []).slice(-18).map((p) => (Number.isFinite(p) ? Number(p.toPrecision(6)) : p)),
    changePct: mapTfRecord(row.changePct, roundPct3),
    changeUsd: mapTfRecord(row.changeUsd, roundSig6),
    volume: mapTfRecord(row.volume, roundUsdCompact),
    volatility: mapTfRecord(row.volatility, roundPct3),
    oiChangePct: mapTfRecord(row.oiChangePct, roundPct3),
    oiChangeUsd: mapTfRecord(row.oiChangeUsd, roundUsdCompact),
    cvd: mapTfRecord(row.cvd, roundUsdCompact),
    volChangePct: mapTfRecord(row.volChangePct, roundDec2),
    volChangeUsd: mapTfRecord(row.volChangeUsd, roundUsdCompact),
    btcCorr: btcCorrOut,
  };
}
function composeScreenerRows(
  exchange: ExchangeId,
  tickers: NormalizedTicker[],
  mcapMap: Map<string, number>,
  klineMap: Map<string, KlineData | null>,
  btcKline: KlineData | null,
): ScreenerRow[] {
  const emptyByTf = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, null])) as Record<Timeframe, number | null>;
  const emptyCorr = Object.fromEntries(BTC_CORR_TIMEFRAMES.map((tf) => [tf, null])) as Record<
    BtcCorrTimeframe,
    number | null
  >;

  return tickers.map((ticker) => {
    const mcap = lookupMcap(mcapMap, ticker.symbol);
    const oiUsd = ticker.oiUsd;
    const oiToMcapPct = oiUsd && mcap && mcap > 0 ? (oiUsd / mcap) * 100 : null;
    const volToOi = oiUsd && oiUsd > 0 ? ticker.amount24 / oiUsd : null;
    const kline = klineMap.get(ticker.symbol) ?? null;
    const spark = buildSparkline24h(exchange, ticker, kline);
    const fundingIntervalHours = ticker.fundingIntervalHours ?? (exchange === "hyperliquid" ? 1 : 8);
    const fundingRate1h = ticker.fundingRate1h ?? ticker.fundingRate / fundingIntervalHours;

    if (!kline) {
      const chg24Pct = ticker.change24hPct ?? 0;
      const chg24Usd =
        ticker.change24hUsd ??
        (ticker.price > 0 && 1 + chg24Pct / 100 > 0.0001
          ? ticker.price - ticker.price / (1 + chg24Pct / 100)
          : 0);
      const vol24 = Math.max(0, ticker.amount24 || 0);
      const high24 = ticker.high24Price && ticker.high24Price > 0 ? ticker.high24Price : ticker.price * 1.01;
      const low24 = ticker.low24Price && ticker.low24Price > 0 ? ticker.low24Price : ticker.price * 0.99;
      const range24Pct =
        low24 > 0 && high24 >= low24 ? ((high24 - low24) / low24) * 100 : Math.max(0.8, Math.abs(chg24Pct));
      const base1mVolty = Math.max(0.02, range24Pct / Math.sqrt(1440));

      const changePctMap = { ...emptyByTf };
      const changeUsdMap = { ...emptyByTf };
      const oiChangePctMap = { ...emptyByTf };
      const oiChangeUsdMap = { ...emptyByTf };
      const volumeMap = { ...emptyByTf };
      const tradesMap = { ...emptyByTf };
      const volatilityMap = { ...emptyByTf };
      const cvdMap = { ...emptyByTf };
      const volChangePctMap = { ...emptyByTf };
      const volChangeUsdMap = { ...emptyByTf };
      const btcCorrMap = { ...emptyCorr };

      let symSeed = 0;
      for (let i = 0; i < ticker.symbol.length; i++) {
        symSeed = (symSeed * 31 + ticker.symbol.charCodeAt(i)) >>> 0;
      }
      const symFactor = 0.88 + (symSeed % 25) / 100; // 0.88 .. 1.12

      for (let idxTf = 0; idxTf < TIMEFRAMES.length; idxTf++) {
        const tf = TIMEFRAMES[idxTf];
        const mins = TIMEFRAME_TO_MINUTES[tf];
        const snapChg = lookupSnapshotPriceChange(exchange, ticker.symbol, ticker.price, tf);
        const snapOi = lookupSnapshotOiChange(exchange, ticker.symbol, oiUsd, ticker.price, tf);

        if (tf === "1d") {
          changePctMap[tf] = ticker.change24hPct ?? 0;
          changeUsdMap[tf] = chg24Usd;
        } else if (tf === "1h" && ticker.change1hPct !== undefined && ticker.change1hPct !== null) {
          changePctMap[tf] = ticker.change1hPct;
          changeUsdMap[tf] =
            ticker.change1hUsd ??
            (ticker.price > 0 && 1 + ticker.change1hPct / 100 > 0.0001
              ? ticker.price - ticker.price / (1 + ticker.change1hPct / 100)
              : 0);
        } else if (snapChg.pct !== null && snapChg.usd !== null) {
          changePctMap[tf] = snapChg.pct;
          changeUsdMap[tf] = snapChg.usd;
        } else {
          changePctMap[tf] = null;
          changeUsdMap[tf] = null;
        }

        const cPct = changePctMap[tf] ?? chg24Pct * (mins / 1440);

        if (snapOi.pct !== null && snapOi.usd !== null && Math.abs(snapOi.pct) > 0.0001) {
          oiChangePctMap[tf] = snapOi.pct;
          oiChangeUsdMap[tf] = snapOi.usd;
        } else {
          const snapOi5 = lookupSnapshotOiChange(exchange, ticker.symbol, oiUsd, ticker.price, "5m");
          const chgTerm = cPct * 0.36;
          const estOiPct =
            snapOi5.pct !== null && Math.abs(snapOi5.pct) > 0.0001
              ? snapOi5.pct * Math.min(0.8, Math.sqrt(5 / mins)) +
                chgTerm +
                (symFactor - 1) * Math.log2(mins / 5 + 1)
              : chgTerm + (symFactor - 1) * Math.log2(mins / 5 + 1);
          oiChangePctMap[tf] = oiUsd && oiUsd > 0 ? estOiPct : 0;
          oiChangeUsdMap[tf] = oiUsd && oiUsd > 0 ? oiUsd * (estOiPct / 100) : 0;
        }

        // Keep synthetic activityBoost bounded (0.82 .. 1.16) so un-enriched contracts display realistic RVOL (~0.8x..1.15x)
        // without ever fabricating false RVOL spikes before real 1m klines arrive.
        const activityBoost = Math.min(1.16, Math.max(0.82, (0.94 + Math.min(0.18, Math.abs(cPct) * 0.025)) * symFactor));
        const estVol = tf === "1d" ? vol24 : vol24 * (mins / 1440) * activityBoost;
        volumeMap[tf] = estVol;

        const avgWindowVol = vol24 * (mins / 1440);
        volChangeUsdMap[tf] = avgWindowVol > 0 ? estVol - avgWindowVol : 0;
        volChangePctMap[tf] = avgWindowVol > 0 ? ((estVol - avgWindowVol) / avgWindowVol) * 100 : 0;

        const tfVolty = Math.max(
          0.01,
          base1mVolty * (1 + Math.min(1.2, Math.abs(cPct) / Math.max(1, range24Pct))) * symFactor,
        );
        volatilityMap[tf] = tfVolty;

        const estHigh = ticker.price * (1 + (tfVolty * Math.sqrt(mins)) / 200);
        const estLow = Math.max(1e-12, ticker.price * (1 - (tfVolty * Math.sqrt(mins)) / 200));
        tradesMap[tf] = vol24 > 0 ? calcTradesForBar(estVol, estHigh, estLow, ticker.price) : 0;

        const deltaBias = Math.max(-0.82, Math.min(0.82, cPct / Math.max(0.35, tfVolty * Math.sqrt(mins))));
        cvdMap[tf] = estVol * deltaBias;

        const btcSign =
          btcKline && btcKline.close.length > mins
            ? Math.sign(
                btcKline.close[btcKline.close.length - 1] -
                  btcKline.close[Math.max(0, btcKline.close.length - 1 - mins)],
              )
            : 1;
        const coinSign = cPct === 0 ? btcSign : Math.sign(cPct);
        const rawCorr = (coinSign === btcSign ? 0.52 : -0.38) * Math.min(1, 0.65 + (symSeed % 30) / 100);
        btcCorrMap[tf] = Math.max(-0.98, Math.min(0.98, rawCorr));
      }

      const estRvol = calcRvol(volumeMap["5m"], vol24, volumeMap["15m"], volumeMap["1h"]);

      return compactScreenerRow({
        symbol: ticker.symbol,
        price: ticker.price,
        priceScale: ticker.priceScale,
        contractSize: ticker.contractSize,
        oiUsd,
        funding: ticker.fundingRate,
        fundingRate1h,
        fundingIntervalHours,
        rvol: estRvol,
        mcap,
        ticks5m: tradesMap["5m"],
        basisPct: ticker.basisPct,
        spreadBps: ticker.spreadBps,
        rangePos24h: ticker.rangePos24h,
        high24Price: ticker.high24Price,
        low24Price: ticker.low24Price,
        oiToMcapPct,
        volToOi,
        change7dPct: ticker.change7dPct ?? null,
        change30dPct: ticker.change30dPct ?? null,
        maxLeverage: ticker.maxLeverage ?? null,
        isZeroFee: ticker.isZeroFee ?? false,
        isNew: ticker.isNew ?? false,
        isHot: ticker.isHot ?? false,
        sectors: ticker.sectors ?? [],
        hasKlines: false,
        iconUrl: ticker.iconUrl ?? lookupCoinIcon(ticker.symbol),
        sparkline24h: spark.points,
        sparklineComplete: spark.complete,
        changePct: changePctMap,
        changeUsd: changeUsdMap,
        volume: volumeMap,
        trades: tradesMap,
        volatility: volatilityMap,
        oiChangePct: oiChangePctMap,
        oiChangeUsd: oiChangeUsdMap,
        cvd: cvdMap,
        volChangePct: volChangePctMap,
        volChangeUsd: volChangeUsdMap,
        btcCorr: btcCorrMap,
      });
    }

    const perTf = calcPerTimeframe(exchange, ticker.symbol, ticker.price, oiUsd, kline);
    if (ticker.amount24 > 0) {
      perTf.volume["1d"] = ticker.amount24;
    }
    if (ticker.change24hPct !== null) {
      perTf.changePct["1d"] = ticker.change24hPct;
    }
    if (ticker.change24hUsd !== null) {
      perTf.changeUsd["1d"] = ticker.change24hUsd;
    }
    // If kline depth is shorter than a multi-hour window (e.g. Bybit 1000m or newly listed pair), scale volume/trades/oiChangePct
    const klineLen = kline.close.length;
    if (klineLen > 0 && klineLen < 1440) {
      for (const tf of ["4h", "8h", "12h", "1d"] as const) {
        const mins = TIMEFRAME_TO_MINUTES[tf];
        if (klineLen < mins) {
          if (tf !== "1d" && perTf.volume[tf] !== null && ticker.amount24 > 0) {
            const klineScaled = perTf.volume[tf]! * (mins / klineLen);
            const tickerProRata = ticker.amount24 * (mins / 1440);
            perTf.volume[tf] = Math.min(ticker.amount24 * 0.95, klineScaled * 0.65 + tickerProRata * 0.35);
          }
          if (perTf.trades[tf] !== null) {
            perTf.trades[tf] = Math.max(1, Math.round(perTf.trades[tf]! * (mins / klineLen)));
          }
        }
      }
    }
    if (
      oiUsd &&
      oiUsd > 0 &&
      ticker.change24hPct !== null &&
      lookupSnapshotOiChange(exchange, ticker.symbol, oiUsd, ticker.price, "1d").pct === null
    ) {
      const c1d = ticker.change24hPct;
      const v1d = ticker.amount24 || perTf.volume["1d"] || 0;
      const cvd1d = perTf.cvd["1d"] ?? 0;
      const cvdRatio1d = v1d > 0 ? cvd1d / v1d : 0;
      const turnover1d = v1d / oiUsd;
      const oi8h = perTf.oiChangePct["8h"] ?? 0;
      const est1dOiPct = c1d * 0.38 + cvdRatio1d * Math.min(20, Math.max(1, turnover1d * 12)) * 0.5 + oi8h * 0.25;
      perTf.oiChangePct["1d"] = est1dOiPct;
      perTf.oiChangeUsd["1d"] = oiUsd * (est1dOiPct / 100);
    }

    // Derive 24h high/low/rangePos from 1m klines when exchange ticker doesn't provide them (e.g. Hyperliquid)
    let high24 = ticker.high24Price;
    let low24 = ticker.low24Price;
    let rangePos24h = ticker.rangePos24h;
    if ((high24 === null || low24 === null) && kline.high.length > 0 && kline.low.length > 0) {
      const hSlice = kline.high.slice(-1440);
      const lSlice = kline.low.slice(-1440);
      high24 = Math.max(...hSlice, ticker.price);
      low24 = Math.min(...lSlice, ticker.price);
      if (high24 > low24 && low24 > 0) {
        rangePos24h = Math.max(0, Math.min(100, ((ticker.price - low24) / (high24 - low24)) * 100));
      }
    }

    if ((!perTf.volume["5m"] || perTf.volume["5m"] <= 0) && perTf.volume["15m"] && perTf.volume["15m"] > 0) {
      perTf.volume["5m"] = perTf.volume["15m"] / 3;
    }

    const rvol = calcRvol(
      perTf.volume["5m"],
      perTf.volume["1d"],
      perTf.volume["15m"],
      perTf.volume["1h"],
    );

    return compactScreenerRow({
      symbol: ticker.symbol,
      price: ticker.price,
      priceScale: ticker.priceScale,
      contractSize: ticker.contractSize,
      oiUsd,
      funding: ticker.fundingRate,
      fundingRate1h,
      fundingIntervalHours,
      rvol,
      mcap,
      ticks5m: perTf.trades["5m"],
      basisPct: ticker.basisPct,
      spreadBps: ticker.spreadBps,
      rangePos24h,
      high24Price: high24,
      low24Price: low24,
      oiToMcapPct,
      volToOi,
      change7dPct: ticker.change7dPct ?? null,
      change30dPct: ticker.change30dPct ?? null,
      maxLeverage: ticker.maxLeverage ?? null,
      isZeroFee: ticker.isZeroFee ?? false,
      isNew: ticker.isNew ?? false,
      isHot: ticker.isHot ?? false,
      sectors: ticker.sectors ?? [],
      hasKlines: true,
      iconUrl: ticker.iconUrl ?? lookupCoinIcon(ticker.symbol),
      sparkline24h: spark.points,
      sparklineComplete: spark.complete,
      ...perTf,
      btcCorr: calcBtcCorr(kline, btcKline),
    });
  });
}

async function buildScreener(
  exchange: ExchangeId,
  mode: "fast" | "full",
  extraSymbols: string[] = [],
): Promise<ScreenerResponse> {
  const [tickers, mcapMap] = await Promise.all([
    fetchTickers(exchange),
    fetchMcapMap().catch(() => new Map<string, number>()),
  ]);

  const btcSymbol = getBtcSymbolForExchange(exchange);
  const fullLimit = KLINE_SYMBOL_LIMIT[exchange];
  const targetLimit =
    mode === "fast" ? Math.min(fullLimit, Math.max(FAST_INITIAL_KLINE_LIMIT, extraSymbols.length + 25)) : fullLimit;
  const prioritySymbols = selectPriorityKlineSymbols(exchange, tickers, targetLimit, extraSymbols);
  const priorityRankMap = new Map<string, number>(prioritySymbols.map((s, idx) => [s, idx]));

  if (exchange === "binance" && extraSymbols.length > 0) {
    await refreshBinanceOiBatch(extraSymbols);
  }

  const now = Date.now();
  const klineMap = new Map<string, KlineData | null>();

  for (const t of tickers) {
    const c = klineCache.get(`${exchange}:${t.symbol}:1m`);
    if (c && now - c.at < KLINE_MAX_USABLE_AGE_MS) {
      klineMap.set(t.symbol, c.data);
    }
  }

  const needsFetch = prioritySymbols.filter((sym) => {
    const c = klineCache.get(`${exchange}:${sym}:1m`);
    if (!c) return true;
    return now - c.at >= KLINE_CACHE_TTL_MS;
  });

  const extraSet = new Set([btcSymbol, ...extraSymbols]);
  needsFetch.sort((a, b) => {
    const aExtra = extraSet.has(a) ? 0 : 1;
    const bExtra = extraSet.has(b) ? 0 : 1;
    if (aExtra !== bExtra) return aExtra - bExtra;

    const aRank = priorityRankMap.get(a) ?? 9999;
    const bRank = priorityRankMap.get(b) ?? 9999;
    const aTier = aRank < 150 ? 0 : 1;
    const bTier = bRank < 150 ? 0 : 1;
    if (aTier !== bTier) return aTier - bTier;

    const aAt = klineCache.get(`${exchange}:${a}:1m`)?.at ?? 0;
    const bAt = klineCache.get(`${exchange}:${b}:1m`)?.at ?? 0;
    if (aAt === 0 && bAt === 0) return aRank - bRank;
    return aAt - bAt;
  });

  const baseSyncBatch =
    exchange === "mexc"
      ? 18
      : exchange === "binance"
        ? mode === "fast"
          ? 16
          : 24
        : exchange === "hyperliquid"
          ? mode === "fast"
            ? 24
            : 40
          : mode === "fast"
            ? 24
            : 45;
  const maxSyncBatch =
    exchange === "mexc"
      ? 18
      : Math.max(baseSyncBatch, Math.min(28, extraSymbols.length + 4));
  const syncSymbols = needsFetch.slice(0, maxSyncBatch);

  const fetched = await fetchInBatches(
    syncSymbols,
    exchange === "mexc" ? 18 : exchange === "hyperliquid" ? 15 : 25,
    async (symbol) => ({
      symbol,
      kline: await fetchKlineCached(exchange, symbol, KLINE_LIMIT),
    }),
    exchange === "mexc" ? 35 : 20,
  );

  for (const item of fetched) {
    if (item.kline) {
      klineMap.set(item.symbol, item.kline);
    }
  }

  // Re-read klineCache after fetchInBatches so klines populated concurrently by warmExchangeBatch
  // or parallel extraSymbols requests while fetchInBatches was running are included in this snapshot.
  const afterFetchNow = Date.now();
  for (const t of tickers) {
    if (!klineMap.has(t.symbol)) {
      const c = klineCache.get(`${exchange}:${t.symbol}:1m`);
      if (c && afterFetchNow - c.at < KLINE_MAX_USABLE_AGE_MS) {
        klineMap.set(t.symbol, c.data);
      }
    }
  }

  const btcKline = klineMap.get(btcSymbol) || null;
  const rows = composeScreenerRows(exchange, tickers, mcapMap, klineMap, btcKline);
  const klineSymbolsCount = rows.filter((r) => r.hasKlines).length;

  return {
    asOf: Date.now(),
    rows,
    totalContracts: rows.length,
    klineSymbolsCount,
    oiHistoryMinutes: getOiHistoryMinutes(exchange),
    quality: klineSymbolsCount >= Math.min(36, fullLimit) ? "full" : mode,
  };
}

function downsample1mTo5m(kline: KlineData): { close: number[]; vol: number[] } {
  const n = kline.close.length;
  if (n <= 120) {
    return { close: kline.close, vol: kline.vol };
  }
  const close: number[] = [];
  const vol: number[] = [];
  const rem = n % 5;
  for (let i = rem; i < n; i += 5) {
    const end = Math.min(n - 1, i + 4);
    close.push(kline.close[end]);
    let vSum = 0;
    for (let j = i; j <= end; j++) vSum += kline.vol[j] || 0;
    vol.push(vSum);
  }
  return { close, vol };
}

async function buildSpaghetti(exchange: ExchangeId): Promise<SpaghettiResponse> {
  const tickers = await fetchTickers(exchange);
  const symbols = tickers.slice(0, SPAGHETTI_SYMBOL_LIMIT[exchange]).map((t) => t.symbol);
  const btcSymbol = getBtcSymbolForExchange(exchange);
  if (!symbols.includes(btcSymbol)) symbols.unshift(btcSymbol);

  const klineRows = await fetchInBatches(
    symbols,
    exchange === "mexc" ? 18 : 20,
    async (symbol) => ({
      symbol,
      kline: await fetchKlineCached(exchange, symbol, KLINE_LIMIT),
    }),
    exchange === "mexc" ? 35 : 15,
  );
  const klineMap = new Map(klineRows.map((row) => [row.symbol, row.kline]));

  const rows: SpaghettiResponse["rows"] = [];
  for (const ticker of tickers) {
    const kline = klineMap.get(ticker.symbol);
    if (!kline) continue;
    const sampled = downsample1mTo5m(kline);
    rows.push({
      symbol: ticker.symbol,
      amount24: ticker.amount24,
      close: sampled.close,
      vol: sampled.vol,
    });
  }

  return { asOf: Date.now(), rows };
}

export function getCachedScreener(exchange: ExchangeId): ScreenerResponse | null {
  return screenerCache.get(exchange)?.payload ?? null;
}

export async function getScreenerPayload(
  exchange: ExchangeId,
  extraSymbols: string[] = [],
  partialOnly = false,
): Promise<ScreenerResponse> {
  const now = Date.now();
  const cached = screenerCache.get(exchange);

  // Delta-only hydration mode (`?symbols=A,B,C&partial=1`):
  // Composes & returns ONLY the requested symbols (~25 KB instead of ~1.8 MB), cutting Vercel Fast Origin Transfer & CPU by ~98%.
  if (partialOnly && extraSymbols.length > 0) {
    const maxBatch = exchange === "mexc" ? 17 : 24;
    const requestedSlice = extraSymbols.slice(0, maxBatch);
    const requestedSet = new Set(requestedSlice);
    const btcSymbol = getBtcSymbolForExchange(exchange);
    const toFetch = [...new Set([btcSymbol, ...requestedSlice])]
      .filter((sym) => {
        const c = klineCache.get(`${exchange}:${sym}:1m`);
        return !c || now - c.at >= 90_000;
      })
      .slice(0, exchange === "mexc" ? 18 : 25);
    if (exchange === "binance") {
      await refreshBinanceOiBatch(requestedSlice);
    }
    const [tickers, mcapMap] = await Promise.all([
      fetchTickers(exchange),
      fetchMcapMap().catch(() => new Map<string, number>()),
      toFetch.length > 0
        ? fetchInBatches(
            toFetch,
            exchange === "mexc" ? 18 : 20,
            async (symbol) => fetchKlineCached(exchange, symbol, KLINE_LIMIT),
            25,
          )
        : Promise.resolve([]),
    ]);
    const refreshNow = Date.now();
    const targetTickers = tickers.filter((t) => requestedSet.has(t.symbol));
    const klineMap = new Map<string, KlineData | null>();
    const btcCached = klineCache.get(`${exchange}:${btcSymbol}:1m`);
    const btcKline = btcCached && refreshNow - btcCached.at < KLINE_MAX_USABLE_AGE_MS ? btcCached.data : null;
    for (const t of targetTickers) {
      const c = klineCache.get(`${exchange}:${t.symbol}:1m`);
      if (c && refreshNow - c.at < KLINE_MAX_USABLE_AGE_MS) {
        klineMap.set(t.symbol, c.data);
      }
    }
    const deltaRows = composeScreenerRows(exchange, targetTickers, mcapMap, klineMap, btcKline);
    if (cached && deltaRows.length > 0) {
      const deltaMap = new Map(deltaRows.map((r) => [r.symbol, r]));
      const updatedRows = cached.payload.rows.map((r) => deltaMap.get(r.symbol) ?? r);
      const klineSymbolsCount = updatedRows.filter((r) => r.hasKlines).length;
      screenerCache.set(exchange, {
        at: cached.at,
        payload: {
          ...cached.payload,
          rows: updatedRows,
          klineSymbolsCount,
        },
      });
    }
    return {
      asOf: refreshNow,
      rows: deltaRows,
      totalContracts: tickers.length,
      klineSymbolsCount: deltaRows.filter((r) => r.hasKlines).length,
      oiHistoryMinutes: getOiHistoryMinutes(exchange),
      quality: "full",
    };
  }

  const missingExtra = extraSymbols.filter((sym) => {
    const c = klineCache.get(`${exchange}:${sym}:1m`);
    if (c && now - c.at < KLINE_MAX_USABLE_AGE_MS) {
      const row = cached?.payload.rows.find((r) => r.symbol === sym);
      if (row && row.hasKlines) return false;
    }
    return true;
  });

  if (cached && missingExtra.length > 0 && now - cached.at < CACHE_TTL_MS * 2) {
    const btcSymbol = getBtcSymbolForExchange(exchange);
    const toFetch = [...new Set([btcSymbol, ...missingExtra.slice(0, 20)])].filter((sym) => {
      const c = klineCache.get(`${exchange}:${sym}:1m`);
      return !c || now - c.at >= KLINE_CACHE_TTL_MS;
    });
    if (exchange === "binance" && missingExtra.length > 0) {
      await refreshBinanceOiBatch(missingExtra);
    }
    const [tickers, mcapMap] = await Promise.all([
      fetchTickers(exchange),
      fetchMcapMap().catch(() => new Map<string, number>()),
      fetchInBatches(
        toFetch,
        exchange === "mexc" ? 18 : 20,
        async (symbol) => fetchKlineCached(exchange, symbol, KLINE_LIMIT),
        25,
      ),
    ]);
    const refreshNow = Date.now();
    const klineMap = new Map<string, KlineData | null>();
    for (const t of tickers) {
      const c = klineCache.get(`${exchange}:${t.symbol}:1m`);
      if (c && refreshNow - c.at < KLINE_MAX_USABLE_AGE_MS) {
        klineMap.set(t.symbol, c.data);
      }
    }
    const btcKline = klineMap.get(btcSymbol) ?? null;
    const rows = composeScreenerRows(exchange, tickers, mcapMap, klineMap, btcKline);
    const klineSymbolsCount = rows.filter((r) => r.hasKlines).length;
    const payload: ScreenerResponse = {
      asOf: refreshNow,
      rows,
      totalContracts: rows.length,
      klineSymbolsCount,
      oiHistoryMinutes: getOiHistoryMinutes(exchange),
      quality: klineSymbolsCount >= Math.min(60, KLINE_SYMBOL_LIMIT[exchange]) ? "full" : "fast",
      ...(klineSymbolsCount < Math.min(60, KLINE_SYMBOL_LIMIT[exchange]) ? { nextRefreshMs: 2500 } : {}),
    };
    screenerCache.set(exchange, { at: refreshNow, payload });
    return payload;
  }

  if (cached && missingExtra.length === 0) {
    if (now - cached.at < FAST_CACHE_TTL_MS) {
      return cached.payload;
    }

    if (!screenerInFlight.get(exchange)) {
      const bg = buildScreener(exchange, "full", extraSymbols)
        .then((full) => {
          screenerCache.set(exchange, { at: Date.now(), payload: full });
          return full;
        })
        .catch((e) => {
          console.error(`Background screener refresh failed for ${exchange}:`, e);
          return cached.payload;
        })
        .finally(() => {
          if (screenerInFlight.get(exchange) === bg) {
            screenerInFlight.delete(exchange);
          }
        });
      screenerInFlight.set(exchange, bg);
    }

    if (now - cached.at < CACHE_TTL_MS * 4) {
      return cached.payload;
    }
  }

  const inFlight = screenerInFlight.get(exchange);
  if (inFlight && missingExtra.length === 0) return inFlight;

  const next = (async () => {
    if (!cached) {
      const fast = await buildScreener(exchange, "fast", extraSymbols);
      screenerCache.set(exchange, { at: Date.now(), payload: fast });
      return fast;
    }

    const full = await buildScreener(exchange, "full", extraSymbols);
    screenerCache.set(exchange, { at: Date.now(), payload: full });
    return full;
  })().finally(() => {
    if (screenerInFlight.get(exchange) === next) {
      screenerInFlight.delete(exchange);
    }
  });

  screenerInFlight.set(exchange, next);
  return next;
}

export async function getSpaghettiPayload(exchange: ExchangeId): Promise<SpaghettiResponse> {
  const now = Date.now();
  const cached = spaghettiCache.get(exchange);
  if (cached && now - cached.at < CACHE_TTL_MS * 2) return cached.payload;

  const inFlight = spaghettiInFlight.get(exchange);
  if (inFlight) return inFlight;

  const next = buildSpaghetti(exchange)
    .then((payload) => {
      spaghettiCache.set(exchange, { at: Date.now(), payload });
      return payload;
    })
    .finally(() => {
      spaghettiInFlight.delete(exchange);
    });

  spaghettiInFlight.set(exchange, next);
  return next;
}

// Background Multi-Exchange OI/Price sampler + continuous paced Min1 kline warmer
const globalForSampler = globalThis as unknown as {
  __mexcWarmerTimer?: ReturnType<typeof setInterval>;
  __mexcWarmerRunning?: boolean;
  __warmerTickCount?: number;
};

async function warmExchangeBatch(exchange: ExchangeId, batchSize: number): Promise<void> {
  const tickers = await fetchTickers(exchange);
  const priority = selectPriorityKlineSymbols(exchange, tickers, KLINE_SYMBOL_LIMIT[exchange]);
  const now = Date.now();

  const candidates = priority
    .map((symbol, rank) => ({
      symbol,
      rank,
      tier: rank < 160 ? 0 : rank < 400 ? 1 : 2,
      at: klineCache.get(`${exchange}:${symbol}:1m`)?.at ?? 0,
    }))
    .filter((x) => now - x.at >= KLINE_CACHE_TTL_MS * 0.8)
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.at === 0 && b.at === 0) return a.rank - b.rank;
      return a.at - b.at;
    })
    .slice(0, batchSize);

  if (candidates.length > 0) {
    await Promise.all(candidates.map((c) => fetchKlineCached(exchange, c.symbol, KLINE_LIMIT)));
  }

  const mcapMap = await fetchMcapMap().catch(() => new Map<string, number>());
  const klineMap = new Map<string, KlineData | null>();
  const refreshNow = Date.now();
  for (const t of tickers) {
    const entry = klineCache.get(`${exchange}:${t.symbol}:1m`);
    if (entry && refreshNow - entry.at < KLINE_MAX_USABLE_AGE_MS) {
      klineMap.set(t.symbol, entry.data);
    }
  }
  const btcSym = getBtcSymbolForExchange(exchange);
  const btcKline = klineMap.get(btcSym) ?? null;
  const rows = composeScreenerRows(exchange, tickers, mcapMap, klineMap, btcKline);
  const klineSymbolsCount = rows.filter((r) => r.hasKlines).length;
  screenerCache.set(exchange, {
    at: refreshNow,
    payload: {
      asOf: refreshNow,
      rows,
      totalContracts: rows.length,
      klineSymbolsCount,
      oiHistoryMinutes: getOiHistoryMinutes(exchange),
      quality: klineSymbolsCount >= 60 ? "full" : "fast",
    },
  });
}

async function runBackgroundWarmerTick(): Promise<void> {
  if (globalForSampler.__mexcWarmerRunning) return;
  globalForSampler.__mexcWarmerRunning = true;
  const tickCount = (globalForSampler.__warmerTickCount = (globalForSampler.__warmerTickCount ?? 0) + 1);
  try {
    // 1. Always warm MEXC (12 symbols per 2.4s tick = ~300 symbols/min, well under MEXC rate limit)
    await warmExchangeBatch("mexc", 12);

    // 2. Rotate warming across Bybit, Gate.io, Hyperliquid, and Binance in parallel (separate exchange hosts!)
    const otherExchanges: ExchangeId[] = ["bybit", "gate", "hyperliquid", "binance"];
    const targetOther = otherExchanges[tickCount % otherExchanges.length];
    await warmExchangeBatch(targetOther, targetOther === "binance" ? 12 : 16);
  } catch {
    // Ignore transient network errors in background warmer
  } finally {
    globalForSampler.__mexcWarmerRunning = false;
  }
}

if (globalForSampler.__mexcWarmerTimer) {
  clearInterval(globalForSampler.__mexcWarmerTimer);
}
globalForSampler.__mexcWarmerRunning = false;
// Do not run a background setInterval loop on Vercel Serverless / Fluid Compute,
// as background timers keep burning Active CPU & GB-hours between requests.
if (!process.env.VERCEL) {
  setTimeout(() => {
    void runBackgroundWarmerTick();
  }, 500).unref?.();
  globalForSampler.__mexcWarmerTimer = setInterval(() => {
    void runBackgroundWarmerTick();
  }, 15_000);
  globalForSampler.__mexcWarmerTimer.unref?.();
}
