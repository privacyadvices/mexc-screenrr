import { createHmac } from "node:crypto";

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

interface MexcCredentials {
  accessKey: string;
  secretKey: string;
}

interface NormalizedHistoryTrade {
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
}

const MEXC_BASE = "https://contract.mexc.com";
const RECV_WINDOW = 10_000;

function getCreds(): MexcCredentials | null {
  const accessKey = process.env.MEXC_ACCESS_KEY?.trim();
  const secretKey = process.env.MEXC_SECRET_KEY?.trim();
  if (!accessKey || !secretKey) return null;
  return { accessKey, secretKey };
}

function toRecord(value: JsonValue): Record<string, JsonValue> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, JsonValue>;
}

function toNumber(value: JsonValue): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toTimestampMs(value: JsonValue): number | null {
  const n = toNumber(value);
  if (n === null) return null;
  if (n > 1e12) return Math.floor(n);
  if (n > 1e9) return Math.floor(n * 1000);
  return null;
}

function inferSide(raw: Record<string, JsonValue>): "long" | "short" | "unknown" {
  const positionType = toNumber(raw.positionType);
  if (positionType === 1) return "long";
  if (positionType === 2) return "short";

  const sideNum = toNumber(raw.side);
  if (sideNum === 1 || sideNum === 2) return "long";
  if (sideNum === 3 || sideNum === 4) return "short";

  const side = String(raw.side ?? raw.positionType ?? raw.type ?? "").toLowerCase();
  if (side.includes("buy") || side.includes("long") || side.includes("open_long")) return "long";
  if (side.includes("sell") || side.includes("short") || side.includes("open_short")) return "short";
  return "unknown";
}

function parseRows(value: JsonValue): Record<string, JsonValue>[] {
  if (Array.isArray(value)) {
    return value.map(toRecord).filter((v): v is Record<string, JsonValue> => Boolean(v));
  }
  const root = toRecord(value);
  if (!root) return [];
  const candidates = [root.data, root.list, root.rows, root.result, root.items];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.map(toRecord).filter((v): v is Record<string, JsonValue> => Boolean(v));
    }
    const candidateRecord = toRecord(candidate ?? null);
    if (!candidateRecord) continue;
    const nested = [candidateRecord.list, candidateRecord.rows, candidateRecord.data];
    for (const item of nested) {
      if (!Array.isArray(item)) continue;
      return item.map(toRecord).filter((v): v is Record<string, JsonValue> => Boolean(v));
    }
  }
  return [];
}

function normalizeTradeRow(row: Record<string, JsonValue>): NormalizedHistoryTrade | null {
  const symbol = String(row.symbol ?? row.market ?? row.contract ?? "").toUpperCase();
  if (!symbol) return null;

  const closeTime =
    toTimestampMs(row.updateTime) ??
    toTimestampMs(row.closeTime) ??
    toTimestampMs(row.time) ??
    toTimestampMs(row.ts) ??
    toTimestampMs(row.ctime);

  const openTime =
    toTimestampMs(row.createTime) ??
    toTimestampMs(row.openTime) ??
    toTimestampMs(row.ctime) ??
    closeTime;

  if (!closeTime || !openTime) return null;

  const realizedPnl =
    toNumber(row.realizedPnl) ??
    toNumber(row.realisedPnl) ??
    toNumber(row.realised) ??
    toNumber(row.profit) ??
    toNumber(row.pnl) ??
    toNumber(row.closeProfitLoss) ??
    toNumber(row.closeProfit) ??
    0;

  const fee =
    Math.abs(toNumber(row.totalFee) ?? Number.NaN) ||
    Math.abs(toNumber(row.fee) ?? Number.NaN) ||
    (toNumber(row.takerFee) ?? 0) + (toNumber(row.makerFee) ?? 0) + (toNumber(row.commission) ?? 0);

  const quantity = toNumber(row.dealVol) ?? toNumber(row.vol) ?? toNumber(row.size) ?? toNumber(row.qty) ?? null;
  const closeVol = toNumber(row.closeVol);
  const holdVol = toNumber(row.holdVol);
  const entryPrice =
    toNumber(row.openAvgPrice) ??
    toNumber(row.holdAvgPrice) ??
    toNumber(row.price) ??
    toNumber(row.avgPrice) ??
    toNumber(row.dealAvgPrice) ??
    null;
  const exitPrice =
    toNumber(row.closeAvgPrice) ??
    toNumber(row.closePrice) ??
    toNumber(row.avgPrice) ??
    toNumber(row.dealAvgPrice) ??
    entryPrice;

  const id = String(row.orderId ?? row.id ?? row.positionId ?? `${symbol}-${closeTime}-${realizedPnl}`);

  const normalizedQuantity = closeVol ?? holdVol ?? quantity;

  if ((normalizedQuantity ?? 0) <= 0 && Math.abs(realizedPnl) < 1e-12) {
    return null;
  }

  return {
    id,
    symbol,
    side: inferSide(row),
    openTime,
    closeTime,
    holdMinutes: Math.max(0, (closeTime - openTime) / 60_000),
    quantity: normalizedQuantity,
    entryPrice,
    exitPrice,
    fee,
    realizedPnl,
  };
}

function buildQuery(params: Record<string, string | number>): string {
  const entries = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
  return new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

async function requestContractPrivate(
  creds: MexcCredentials,
  path: string,
  params: Record<string, string | number>,
): Promise<JsonValue> {
  const requestTime = Date.now();
  const query = buildQuery(params);
  const signaturePayload = `${creds.accessKey}${requestTime}${query}`;
  const signature = createHmac("sha256", creds.secretKey).update(signaturePayload).digest("hex");

  const response = await fetch(`${MEXC_BASE}${path}?${query}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "ApiKey": creds.accessKey,
      "Request-Time": String(requestTime),
      "Signature": signature,
      "Content-Type": "application/json",
      "recv-window": String(RECV_WINDOW),
    },
    cache: "no-store",
  });

  const text = await response.text();
  let json: JsonValue = null;
  try {
    json = JSON.parse(text) as JsonValue;
  } catch {
    if (!response.ok) {
      throw new Error(`MEXC private endpoint failed (HTTP ${response.status})`);
    }
    throw new Error("Invalid JSON from MEXC private endpoint");
  }

  const rec = toRecord(json);
  if (rec && rec.success === false) {
    const code = rec.code ?? response.status;
    const msg = rec.message ?? rec.msg ?? "Authentication or permission error";
    throw new Error(`MEXC API error (${String(code)}): ${String(msg)}`);
  }

  if (!response.ok) {
    throw new Error(`MEXC private endpoint failed (HTTP ${response.status})`);
  }

  return json;
}

async function fetchPaginated(
  creds: MexcCredentials,
  endpoint: string,
  baseParams: Record<string, string | number>,
): Promise<Record<string, JsonValue>[]> {
  const out: Record<string, JsonValue>[] = [];
  const pageSize = Number(baseParams.page_size ?? 100);
  for (let page = 1; page <= 20; page += 1) {
    const payload = await requestContractPrivate(creds, endpoint, {
      ...baseParams,
      page_num: page,
      page_size: pageSize,
    });
    const rows = parseRows(payload);
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

export async function fetchMexcHistoryTrades(): Promise<{ trades: NormalizedHistoryTrade[]; warnings: string[] }> {
  const creds = getCreds();
  if (!creds) {
    return {
      trades: [],
      warnings: ["MEXC credentials missing. Set MEXC_ACCESS_KEY and MEXC_SECRET_KEY in .env.local, or import a CSV below."],
    };
  }

  const warnings: string[] = [];
  let positionRows: Record<string, JsonValue>[] = [];
  let authFailed = false;
  try {
    positionRows = await fetchPaginated(creds, "/api/v1/private/position/list/history_positions", {
      page_size: 100,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    warnings.push(msg);
    if (msg.includes("402") || msg.includes("401") || msg.toLowerCase().includes("expired") || msg.toLowerCase().includes("signature")) {
      authFailed = true;
    }
  }

  const responses: JsonValue[] = [];
  if (positionRows.length) {
    responses.push({ data: positionRows });
  } else if (!authFailed) {
    try {
      const orders = await fetchPaginated(creds, "/api/v1/private/order/list/history_orders", {
        page_size: 100,
        start_time: Date.now() - 90 * 24 * 60 * 60 * 1000,
        end_time: Date.now(),
      });
      responses.push({ data: orders });
      if (orders.length > 0) {
        warnings.push("Using history orders fallback because closed position history returned no rows.");
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "unknown error");
    }
  }

  const unique = new Map<string, NormalizedHistoryTrade>();
  for (const payload of responses) {
    const rows = parseRows(payload);
    for (const row of rows) {
      const normalized = normalizeTradeRow(row);
      if (!normalized) continue;
      unique.set(normalized.id, normalized);
    }
  }

  const trades = [...unique.values()].sort((a, b) => a.closeTime - b.closeTime);
  if (!trades.length) {
    warnings.push("No closed trade history was returned by MEXC private endpoints.");
  }

  return { trades, warnings };
}
