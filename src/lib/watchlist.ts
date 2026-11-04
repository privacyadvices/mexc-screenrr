import { EXCHANGES, type ExchangeId } from "@/lib/exchange";

export type WatchlistItem = {
  exchange: ExchangeId;
  symbol: string;
};

export const WATCHLIST_STORAGE_KEY = "mexc-screener-watchlist-v1";

export function toWatchKey(exchange: ExchangeId, symbol: string): string {
  return `${exchange}:${symbol}`;
}

export function parseWatchKey(key: string): WatchlistItem | null {
  const [exchange, symbol] = key.split(":");
  if (!exchange || !symbol) return null;
  if (!(EXCHANGES as readonly string[]).includes(exchange)) return null;
  return { exchange: exchange as ExchangeId, symbol };
}

export function loadWatchlistFromStorage(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(WATCHLIST_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    const valid = parsed.filter((x): x is string => typeof x === "string" && !!parseWatchKey(x));
    return new Set(valid);
  } catch {
    return new Set();
  }
}

export function saveWatchlistToStorage(keys: Set<string>): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify([...keys]));
}
