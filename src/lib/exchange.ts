export const EXCHANGES = ["mexc", "bybit", "binance", "hyperliquid"] as const;

export type ExchangeId = (typeof EXCHANGES)[number];

export const EXCHANGE_LABEL: Record<ExchangeId, string> = {
  mexc: "MEXC",
  bybit: "Bybit",
  binance: "Binance",
  hyperliquid: "Hyperliquid",
};

export function toDisplaySymbol(exchange: ExchangeId, symbol: string): string {
  if (exchange === "mexc") return symbol.replace("_USDT", "");
  if (exchange === "hyperliquid") return symbol.replace(/_USDT$/, "").replace(/USDT$/, "");
  return symbol.replace(/USDT$/, "");
}

export function toOrionSymbol(exchange: ExchangeId, symbol: string): string {
  const base = toDisplaySymbol(exchange, symbol);
  if (exchange === "hyperliquid") return `${base}USD`;
  return `${base}USDT`;
}

export function normalizeInputToExchangeSymbol(exchange: ExchangeId, input: string): string {
  const upper = input.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
  if (!upper) return "";
  const base = upper.replace(/_USDT$/, "").replace(/USDT$/, "").replace(/USD$/, "");
  if (exchange === "mexc") return `${base}_USDT`;
  if (exchange === "hyperliquid") return base;
  return `${base}USDT`;
}

export function toTradingViewSymbol(exchange: ExchangeId, symbol: string): { prefix: string; symbol: string } {
  const base = toDisplaySymbol(exchange, symbol);
  if (exchange === "mexc") {
    return { prefix: "MEXC", symbol: `${base}USDT.P` };
  }
  if (exchange === "bybit") {
    return { prefix: "BYBIT", symbol: `${base}USDT.P` };
  }
  if (exchange === "binance") {
    return { prefix: "BINANCE", symbol: `${base}USDT.P` };
  }
  // Hyperliquid: TradingView supports CRYPTO/PYTH/BINANCE fallback for chart widget embed
  return { prefix: "BYBIT", symbol: `${base}USDT.P` };
}

export function toTradingViewChartUrl(exchange: ExchangeId, symbol: string): string {
  const tv = toTradingViewSymbol(exchange, symbol);
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(`${tv.prefix}:${tv.symbol}`)}`;
}

export function toExchangeTradeUrl(exchange: ExchangeId, symbol: string): string {
  if (exchange === "mexc") return `https://futures.mexc.com/exchange/${symbol}`;
  if (exchange === "binance") return `https://www.binance.com/en/futures/${symbol}`;
  if (exchange === "hyperliquid") return `https://app.hyperliquid.xyz/trade/${toDisplaySymbol(exchange, symbol)}`;
  return `https://www.bybit.com/trade/usdt/${symbol}`;
}

export function exchangePath(exchange: ExchangeId): string {
  return `/screener/${exchange}`;
}

export function exchangeSpaghettiPath(exchange: ExchangeId, mode: "price" | "volume"): string {
  return `/screener/${exchange}/spaghetti/${mode}`;
}

export function journalPath(): string {
  return "/screener/journal";
}
