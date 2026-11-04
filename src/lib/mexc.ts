const MEXC_BASE_URL = 'https://api.mexc.com';

export interface Ticker {
  symbol: string;
  lastPrice: number;
  bid1: number;
  ask1: number;
  volume24: number;
  amount24: number;
  holdVol: number;
  lower24Price: number;
  high24Price: number;
  riseFallRate: number;
  riseFallValue: number;
  indexPrice: number;
  fairPrice: number;
  fundingRate: number;
  timestamp: number;
}

export interface ContractDetail {
  symbol: string;
  displayName: string;
  displayNameEn: string;
  baseCoin: string;
  quoteCoin: string;
  settleCoin: string;
  contractSize: number;
  minLeverage: number;
  maxLeverage: number;
  priceScale: number;
  volScale: number;
  amountScale: number;
  takerFeeRate: number;
  makerFeeRate: number;
  state: number;
}

export async function getAllTickers(): Promise<Ticker[]> {
  try {
    const response = await fetch(`${MEXC_BASE_URL}/api/v1/contract/ticker`);
    const data = await response.json();
    
    if (data.success && data.data) {
      const tickers = Array.isArray(data.data) ? data.data : [data.data];
      return tickers.filter((t: Ticker) => t.symbol.endsWith('_USDT'));
    }
    return [];
  } catch (error) {
    console.error('Failed to fetch MEXC tickers:', error);
    return [];
  }
}

export async function getContractDetails(symbol?: string): Promise<ContractDetail[]> {
  try {
    const url = symbol 
      ? `${MEXC_BASE_URL}/api/v1/contract/detail?symbol=${symbol}`
      : `${MEXC_BASE_URL}/api/v1/contract/detail`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.success && data.data) {
      const details = Array.isArray(data.data) ? data.data : [data.data];
      return details.filter((d: ContractDetail) => d.symbol.endsWith('_USDT') && d.state === 0);
    }
    return [];
  } catch (error) {
    console.error('Failed to fetch contract details:', error);
    return [];
  }
}

export async function getFundingRate(symbol: string): Promise<number> {
  try {
    const response = await fetch(`${MEXC_BASE_URL}/api/v1/contract/funding_rate/${symbol}`);
    const data = await response.json();
    
    if (data.success && data.data) {
      return data.data.fundingRate;
    }
    return 0;
  } catch (error) {
    console.error(`Failed to fetch funding rate for ${symbol}:`, error);
    return 0;
  }
}

export { formatNumber, formatPrice, formatPercent, formatFunding } from "@/lib/screener";

