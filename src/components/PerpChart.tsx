"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChartBar } from "@/app/api/klines/[exchange]/route";
import type { ExchangeId } from "@/lib/exchange";

type PerpChartProps = {
  exchange: ExchangeId;
  symbol: string;
  displaySymbol: string;
  interval: string; // "1" | "5" | "15" | "60" | "240" | "D"
  chartStyle: "1" | "8" | "3"; // "1"=Candles, "8"=Heikin-Ashi, "3"=Area
  livePrice?: number | null;
  priceScale?: number;
  studies: Set<string>;
  onToggleStudy?: (studyId: string) => void;
};

type PinnedLevel = {
  id: string;
  price: number;
};

type RulerBox = {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  startPrice: number;
  endPrice: number;
  startIdx: number;
  endIdx: number;
};

type ComputedLayout = {
  plotW: number;
  mainH: number;
  rsiH: number;
  totalPlotH: number;
  startFloat: number;
  endFloat: number;
  startIdx: number;
  endIdx: number;
  priceMin: number;
  priceMax: number;
  priceSpan: number;
  maxVol: number;
  priceToY: (p: number) => number;
  yToPrice: (y: number) => number;
  indexToX: (idx: number) => number;
  xToIndex: (x: number) => number;
};

const RIGHT_AXIS_WIDTH = 96;
const BOTTOM_AXIS_HEIGHT = 24;

function intervalToSeconds(interval: string): number {
  switch (interval) {
    case "1":
      return 60;
    case "5":
      return 300;
    case "15":
      return 900;
    case "60":
      return 3600;
    case "240":
      return 14400;
    case "D":
    case "1D":
      return 86400;
    default:
      return 900;
  }
}

function detectDecimals(price: number, explicitScale?: number): number {
  if (explicitScale !== undefined && explicitScale >= 0 && explicitScale <= 10) {
    return explicitScale;
  }
  const abs = Math.abs(price);
  if (abs === 0) return 4;
  if (abs >= 10000) return 1;
  if (abs >= 100) return 2;
  if (abs >= 1) return 4;
  if (abs >= 0.01) return 6;
  if (abs >= 0.0001) return 7;
  return 8;
}

function formatAxisPrice(price: number, decimals: number): string {
  if (!Number.isFinite(price)) return "—";
  return price.toFixed(decimals);
}

function formatCountdown(remainingSec: number): string {
  const sec = Math.max(0, Math.floor(remainingSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) {
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }
  return `${pad(m)}:${pad(s)}`;
}

function formatPctDistance(pct: number): string {
  if (!Number.isFinite(pct)) return "0.0%";
  const sign = pct > 0 ? "+" : "";
  const abs = Math.abs(pct);
  if (abs >= 10) return `${sign}${pct.toFixed(1)}%`;
  return `${sign}${pct.toFixed(2)}%`;
}

function formatBarTimestamp(sec: number): string {
  const d = new Date(sec * 1000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd} ${hh}:${min}`;
}

function computeSmaSeries(bars: ChartBar[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length < period || period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= period) {
      sum -= bars[i - period].close;
    }
    if (i >= period - 1) {
      out[i] = sum / period;
    }
  }
  return out;
}

export const PerpChart = React.memo(function PerpChart({
  exchange,
  symbol,
  displaySymbol,
  interval,
  chartStyle,
  livePrice,
  priceScale,
  studies,
  onToggleStudy,
}: PerpChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mainCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);

  // Direct DOM refs for 120fps zero-React-render legend updates on mouse move
  const timeElRef = useRef<HTMLSpanElement>(null);
  const openElRef = useRef<HTMLElement>(null);
  const highElRef = useRef<HTMLElement>(null);
  const lowElRef = useRef<HTMLElement>(null);
  const closeElRef = useRef<HTMLElement>(null);
  const cursorWrapElRef = useRef<HTMLDivElement>(null);
  const cursorPriceElRef = useRef<HTMLSpanElement>(null);
  const cursorPctElRef = useRef<HTMLSpanElement>(null);
  const ma36ValElRef = useRef<HTMLSpanElement>(null);
  const ma60ValElRef = useRef<HTMLSpanElement>(null);

  const seriesKey = `${exchange}:${symbol}:${interval}`;
  const [rawBarsState, setRawBarsState] = useState<{ key: string; bars: ChartBar[] }>({
    key: seriesKey,
    bars: [],
  });
  const rawBars = useMemo(
    () => (rawBarsState.key === seriesKey ? rawBarsState.bars : []),
    [rawBarsState, seriesKey],
  );
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [rulerMode, setRulerMode] = useState<boolean>(false);
  const [pinnedLevels, setPinnedLevels] = useState<PinnedLevel[]>([]);
  const [maLegendExpanded, setMaLegendExpanded] = useState<boolean>(true);

  const showMa36 = studies.has("MA36");
  const showMa60 = studies.has("MA60");

  // Mutable viewport & interaction state (updated at 120fps without React re-renders)
  const sizeRef = useRef<{ width: number; height: number }>({ width: 900, height: 480 });
  const viewRef = useRef<{
    visibleCount: number;
    rightOffsetBars: number;
    verticalScaleFactor: number;
    verticalPricePanOffset: number;
  }>({
    visibleCount: 110,
    rightOffsetBars: 6,
    verticalScaleFactor: 1,
    verticalPricePanOffset: 0,
  });

  const mouseRef = useRef<{ x: number; y: number; active: boolean }>({
    x: 0,
    y: 0,
    active: false,
  });

  const rulerRef = useRef<RulerBox | null>(null);
  const rulerModeRef = useRef<boolean>(false);
  rulerModeRef.current = rulerMode;

  const dragModeRef = useRef<"none" | "pan" | "priceAxis" | "ruler">("none");
  const dragStartRef = useRef<{
    x: number;
    y: number;
    rightOffsetBars: number;
    verticalScaleFactor: number;
    verticalPricePanOffset: number;
    priceSpan: number;
  }>({
    x: 0,
    y: 0,
    rightOffsetBars: 6,
    verticalScaleFactor: 1,
    verticalPricePanOffset: 0,
    priceSpan: 1,
  });

  const rafMainRef = useRef<number | null>(null);
  const rafOverlayRef = useRef<number | null>(null);
  const layoutRef = useRef<ComputedLayout | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const prevSymbolKeyRef = useRef<string>(`${exchange}:${symbol}`);

  // Fetch OHLCV bars from `/api/klines/[exchange]` and poll every 6s
  const fetchBars = useCallback(
    async (isInitial = false) => {
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const reqSeriesKey = `${exchange}:${symbol}:${interval}`;
      if (isInitial) {
        setRawBarsState({ key: reqSeriesKey, bars: [] });
        setLoading(true);
        setError(null);
      }
      try {
        if (!isInitial && typeof document !== "undefined" && document.hidden) {
          return;
        }
        const res = await fetch(
          `/api/klines/${exchange}?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=380`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as { bars?: ChartBar[]; error?: string };
        if (controller.signal.aborted) return;
        if (Array.isArray(data.bars) && data.bars.length > 0) {
          if (isInitial) {
            viewRef.current.visibleCount = Math.max(28, Math.min(110, data.bars.length + 8));
          }
          setRawBarsState({ key: reqSeriesKey, bars: data.bars });
          setError(null);
        } else if (isInitial) {
          setError(data.error || "No candle data returned");
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        if (isInitial) {
          setError(err instanceof Error ? err.message : "Failed to load candles");
        }
      } finally {
        if (!controller.signal.aborted && isInitial) {
          setLoading(false);
        }
      }
    },
    [exchange, symbol, interval],
  );

  useEffect(() => {
    const symKey = `${exchange}:${symbol}`;
    if (prevSymbolKeyRef.current !== symKey) {
      prevSymbolKeyRef.current = symKey;
      setPinnedLevels([]);
    }
    viewRef.current = {
      visibleCount: 110,
      rightOffsetBars: 6,
      verticalScaleFactor: 1,
      verticalPricePanOffset: 0,
    };
    rulerRef.current = null;
    void fetchBars(true);
    // Live candle close/high/low is patched in real-time via WebSocket `livePrice` prop, so 25s historical bar polling is plenty
    const timer = window.setInterval(() => void fetchBars(false), 25_000);
    return () => {
      window.clearInterval(timer);
      abortControllerRef.current?.abort();
    };
  }, [exchange, symbol, fetchBars]);

  // Patch the latest candle in real-time whenever `livePrice` updates from WebSocket/Screener
  const bars = useMemo<ChartBar[]>(() => {
    if (rawBars.length === 0) return [];
    const copy = rawBars.slice();
    const last = { ...copy[copy.length - 1] };
    if (livePrice && Number.isFinite(livePrice) && livePrice > 0) {
      last.close = livePrice;
      if (livePrice > last.high) last.high = livePrice;
      if (livePrice < last.low) last.low = livePrice;
    }
    copy[copy.length - 1] = last;

    if (chartStyle === "8") {
      const ha: ChartBar[] = new Array(copy.length);
      for (let i = 0; i < copy.length; i++) {
        const b = copy[i];
        const haClose = (b.open + b.high + b.low + b.close) / 4;
        const haOpen = i === 0 ? (b.open + b.close) / 2 : (ha[i - 1].open + ha[i - 1].close) / 2;
        const haHigh = Math.max(b.high, haOpen, haClose);
        const haLow = Math.min(b.low, haOpen, haClose);
        ha[i] = {
          time: b.time,
          open: haOpen,
          high: haHigh,
          low: haLow,
          close: haClose,
          volume: b.volume,
        };
      }
      return ha;
    }
    return copy;
  }, [rawBars, livePrice, chartStyle]);

  // Precompute MA36 & MA60 series across all bars
  const ma36Series = useMemo(() => computeSmaSeries(bars, 36), [bars]);
  const ma60Series = useMemo(() => computeSmaSeries(bars, 60), [bars]);

  const currentPrice = useMemo(() => {
    if (livePrice && Number.isFinite(livePrice) && livePrice > 0) return livePrice;
    if (rawBars.length > 0) return rawBars[rawBars.length - 1].close;
    return 0;
  }, [livePrice, rawBars]);

  const decimals = useMemo(() => detectDecimals(currentPrice, priceScale), [currentPrice, priceScale]);

  // Keep latest data in a ref so the rAF draw functions always read fresh values without re-binding listeners
  const stateRef = useRef({
    bars,
    ma36Series,
    ma60Series,
    currentPrice,
    decimals,
    interval,
    chartStyle,
    studies,
    showMa36,
    showMa60,
    pinnedLevels,
  });
  stateRef.current = {
    bars,
    ma36Series,
    ma60Series,
    currentPrice,
    decimals,
    interval,
    chartStyle,
    studies,
    showMa36,
    showMa60,
    pinnedLevels,
  };

  const computeLayout = useCallback((): ComputedLayout => {
    const { width, height } = sizeRef.current;
    const { bars: bArr, studies: st, currentPrice: curP, showMa36: s36, showMa60: s60, ma36Series: m36, ma60Series: m60 } =
      stateRef.current;
    const { visibleCount, rightOffsetBars, verticalScaleFactor, verticalPricePanOffset } = viewRef.current;

    const plotW = Math.max(100, width - RIGHT_AXIS_WIDTH);
    const hasRsi = st.has("RSI@tv-basicstudies");
    const totalPlotH = Math.max(120, height - BOTTOM_AXIS_HEIGHT);
    const rsiH = hasRsi ? Math.round(totalPlotH * 0.22) : 0;
    const mainH = totalPlotH - rsiH;

    const total = bArr.length;
    const endFloat = total - 1 + rightOffsetBars;
    const startFloat = endFloat - visibleCount + 1;
    const startIdx = Math.max(0, Math.floor(startFloat));
    const endIdx = Math.min(total - 1, Math.ceil(endFloat));

    let minP = Infinity;
    let maxP = -Infinity;
    let maxVol = 0;

    for (let i = startIdx; i <= endIdx; i++) {
      const b = bArr[i];
      if (!b) continue;
      if (b.low < minP) minP = b.low;
      if (b.high > maxP) maxP = b.high;
      if (s36 && m36[i] !== null) {
        if (m36[i]! < minP) minP = m36[i]!;
        if (m36[i]! > maxP) maxP = m36[i]!;
      }
      if (s60 && m60[i] !== null) {
        if (m60[i]! < minP) minP = m60[i]!;
        if (m60[i]! > maxP) maxP = m60[i]!;
      }
      if (b.volume > maxVol) maxVol = b.volume;
    }

    if (!Number.isFinite(minP) || !Number.isFinite(maxP) || minP <= 0) {
      const base = curP > 0 ? curP : 1;
      minP = base * 0.95;
      maxP = base * 1.05;
    }

    let rawSpan = maxP - minP;
    if (rawSpan <= 0) rawSpan = (maxP || 1) * 0.02;
    const mid = (maxP + minP) / 2 + verticalPricePanOffset;
    const halfSpan = (rawSpan * 1.16 * verticalScaleFactor) / 2;

    const priceMax = mid + halfSpan;
    const priceMin = Math.max(mid * 0.0001, mid - halfSpan);
    const priceSpan = Math.max(1e-12, priceMax - priceMin);

    const priceToY = (p: number) => ((priceMax - p) / priceSpan) * mainH;
    const yToPrice = (y: number) => priceMax - (y / mainH) * priceSpan;
    const indexToX = (idx: number) => ((idx - startFloat + 0.5) / visibleCount) * plotW;
    const xToIndex = (x: number) => Math.round((x / plotW) * visibleCount + startFloat - 0.5);

    const computed: ComputedLayout = {
      plotW,
      mainH,
      rsiH,
      totalPlotH,
      startFloat,
      endFloat,
      startIdx,
      endIdx,
      priceMin,
      priceMax,
      priceSpan,
      maxVol,
      priceToY,
      yToPrice,
      indexToX,
      xToIndex,
    };
    layoutRef.current = computed;
    return computed;
  }, []);

  // Fast Overlay Draw (Crosshair + Right Axis Cursor % Pill + Bottom Time Pill + Ruler + DOM Legend)
  const drawOverlay = useCallback(() => {
    rafOverlayRef.current = null;
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = sizeRef.current;
    const targetW = Math.round(width * dpr);
    const targetH = Math.round(height * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const ly = layoutRef.current ?? computeLayout();
    const { plotW, mainH, totalPlotH, yToPrice, xToIndex } = ly;
    const { bars: bArr, currentPrice: curP, decimals: dec, showMa36: s36, showMa60: s60, ma36Series: m36, ma60Series: m60 } =
      stateRef.current;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // 1. Interactive Drag-to-Measure Ruler Box
    const activeRuler = rulerRef.current;
    if (activeRuler) {
      const x1 = activeRuler.startX;
      const y1 = activeRuler.startY;
      const x2 = activeRuler.endX;
      const y2 = activeRuler.endY;
      const pct = ((activeRuler.endPrice - activeRuler.startPrice) / activeRuler.startPrice) * 100;
      const deltaUsd = activeRuler.endPrice - activeRuler.startPrice;
      const barCount = Math.abs(activeRuler.endIdx - activeRuler.startIdx);
      const isUp = pct >= 0;

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, plotW, mainH);
      ctx.clip();

      ctx.fillStyle = isUp ? "rgba(38, 166, 154, 0.18)" : "rgba(239, 83, 80, 0.18)";
      ctx.strokeStyle = isUp ? "rgba(62, 224, 161, 0.85)" : "rgba(255, 107, 129, 0.85)";
      ctx.lineWidth = 1.5;
      ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));

      const badgeText = `${formatPctDistance(pct)} (${deltaUsd >= 0 ? "+" : ""}${formatAxisPrice(deltaUsd, dec)}) • ${barCount} bars`;
      ctx.font = "700 11.5px Inter, -apple-system, sans-serif";
      const bw = ctx.measureText(badgeText).width + 18;
      const bx = Math.max(8, Math.min(plotW - bw - 8, (x1 + x2) / 2 - bw / 2));
      const by = Math.max(24, Math.min(mainH - 28, Math.min(y1, y2) - 26));
      ctx.fillStyle = isUp ? "#0d9488" : "#e11d48";
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, 22, 5);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(badgeText, bx + bw / 2, by + 11);
      ctx.restore();
    }

    // 2. Crosshair + Right Axis Cursor Price & Exact `%` Distance Pill
    const mouse = mouseRef.current;
    let activeBarIdx = bArr.length - 1;

    if (mouse.active && mouse.x >= 0 && mouse.x <= plotW && mouse.y >= 0 && mouse.y <= mainH) {
      const { x, y } = mouse;
      const cursorPrice = yToPrice(y);
      const pctFromCurrent = curP > 0 ? ((cursorPrice - curP) / curP) * 100 : 0;

      ctx.save();
      ctx.strokeStyle = "rgba(161, 161, 170, 0.65)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(plotW, Math.round(y) + 0.5);
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, totalPlotH);
      ctx.stroke();
      ctx.restore();

      const boxH = 36;
      const boxY = Math.max(2, Math.min(mainH - boxH - 2, y - boxH / 2));

      // (+) Pin button next to right axis
      const plusW = 24;
      const plusX = plotW - plusW - 1;
      ctx.fillStyle = "#525866";
      ctx.beginPath();
      ctx.roundRect(plusX, boxY, plusW, boxH, 4);
      ctx.fill();

      const cx = plusX + plusW / 2;
      const cy = boxY + boxH / 2;
      ctx.strokeStyle = "#f4f4f5";
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(cx, cy, 7.5, 0, Math.PI * 2);
      ctx.moveTo(cx - 4, cy);
      ctx.lineTo(cx + 4, cy);
      ctx.moveTo(cx, cy - 4);
      ctx.lineTo(cx, cy + 4);
      ctx.stroke();

      // Right axis Cursor Price + % Distance pill
      ctx.fillStyle = "#4a505e";
      ctx.beginPath();
      ctx.roundRect(plotW + 1, boxY, RIGHT_AXIS_WIDTH - 3, boxH, 4);
      ctx.fill();

      ctx.fillStyle = "#ffffff";
      ctx.font = "700 11.5px Inter, -apple-system, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(formatAxisPrice(cursorPrice, dec), plotW + 7, boxY + 11);

      const pctText = formatPctDistance(pctFromCurrent);
      ctx.fillStyle = pctFromCurrent >= 0 ? "#6ee7b7" : "#fda4af";
      ctx.font = "700 11px Inter, -apple-system, sans-serif";
      ctx.fillText(pctText, plotW + 7, boxY + 25.5);

      const hoveredIdx = Math.max(0, Math.min(bArr.length - 1, xToIndex(x)));
      activeBarIdx = hoveredIdx;
      const hoveredBar = bArr[hoveredIdx];
      if (hoveredBar) {
        const dt = new Date(hoveredBar.time * 1000);
        const timeText = dt.toLocaleString("en-GB", {
          month: "short",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        });
        ctx.font = "600 10.5px Inter, sans-serif";
        const tw = ctx.measureText(timeText).width + 14;
        const tx = Math.max(4, Math.min(plotW - tw - 4, x - tw / 2));
        ctx.fillStyle = "#4a505e";
        ctx.beginPath();
        ctx.roundRect(tx, totalPlotH + 2, tw, BOTTOM_AXIS_HEIGHT - 4, 3);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.fillText(timeText, tx + tw / 2, totalPlotH + BOTTOM_AXIS_HEIGHT / 2);
      }

      // Update Top-Left Cursor % Telemetry DOM directly (0 React re-renders!)
      if (cursorWrapElRef.current && cursorPriceElRef.current && cursorPctElRef.current) {
        cursorWrapElRef.current.style.display = "flex";
        cursorPriceElRef.current.textContent = `$${formatAxisPrice(cursorPrice, dec)}`;
        cursorPctElRef.current.textContent = pctText;
        cursorPctElRef.current.className =
          pctFromCurrent >= 0
            ? "rounded px-1.5 py-0.2 font-bold bg-emerald-500/20 text-[#3ee0a1] border border-emerald-500/40"
            : "rounded px-1.5 py-0.2 font-bold bg-rose-500/20 text-[#ff6b81] border border-rose-500/40";
      }
    } else if (cursorWrapElRef.current) {
      cursorWrapElRef.current.style.display = "none";
    }

    // 3. Update Top-Left OHLC + MA36/MA60 Legend DOM nodes directly
    const bar = bArr[activeBarIdx];
    if (bar) {
      if (timeElRef.current) timeElRef.current.textContent = formatBarTimestamp(bar.time);
      if (openElRef.current) openElRef.current.textContent = formatAxisPrice(bar.open, dec);
      if (highElRef.current) highElRef.current.textContent = formatAxisPrice(bar.high, dec);
      if (lowElRef.current) lowElRef.current.textContent = formatAxisPrice(bar.low, dec);
      if (closeElRef.current) {
        closeElRef.current.textContent = formatAxisPrice(bar.close, dec);
        closeElRef.current.className = bar.close >= bar.open ? "text-[#3ee0a1]" : "text-[#ff6b81]";
      }
    }
    if (ma36ValElRef.current) {
      const v36 = m36[activeBarIdx];
      ma36ValElRef.current.textContent = s36
        ? v36 !== null && v36 !== undefined
          ? formatAxisPrice(v36, dec)
          : "—"
        : "OFF (Click)";
    }
    if (ma60ValElRef.current) {
      const v60 = m60[activeBarIdx];
      ma60ValElRef.current.textContent = s60
        ? v60 !== null && v60 !== undefined
          ? formatAxisPrice(v60, dec)
          : "—"
        : "OFF (Click)";
    }

    ctx.restore();
  }, [computeLayout]);

  // Main Chart Layer Draw (Grid + Volume + Candles + MA36/MA60 + Studies + Current Price Pill)
  const drawMain = useCallback(() => {
    rafMainRef.current = null;
    const canvas = mainCanvasRef.current;
    if (!canvas) return;
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width > 20 && rect.height > 20) {
        sizeRef.current = { width: Math.floor(rect.width), height: Math.floor(rect.height) };
      }
    }
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = sizeRef.current;
    const targetW = Math.round(width * dpr);
    const targetH = Math.round(height * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    if (overlayCanvasRef.current && (overlayCanvasRef.current.width !== targetW || overlayCanvasRef.current.height !== targetH)) {
      overlayCanvasRef.current.width = targetW;
      overlayCanvasRef.current.height = targetH;
    }
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const ly = computeLayout();
    const { plotW, mainH, rsiH, totalPlotH, startIdx, endIdx, maxVol, priceToY, yToPrice, indexToX } = ly;
    const {
      bars: bArr,
      ma36Series: m36,
      ma60Series: m60,
      currentPrice: curP,
      decimals: dec,
      interval: intv,
      chartStyle: cStyle,
      studies: st,
      showMa36: s36,
      showMa60: s60,
      pinnedLevels: pins,
    } = stateRef.current;
    const { visibleCount } = viewRef.current;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 1. Background
    ctx.fillStyle = "#080a10";
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = "#0b0e16";
    ctx.fillRect(plotW, 0, RIGHT_AXIS_WIDTH, height);

    // 2. Horizontal price grid lines & right-axis labels
    const gridRows = 7;
    ctx.font = "500 11px Inter, -apple-system, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    for (let i = 0; i <= gridRows; i++) {
      const y = (mainH / gridRows) * i;
      if (y < 14 || y > mainH - 14) continue;
      const p = yToPrice(y);

      ctx.strokeStyle = "rgba(255, 255, 255, 0.045)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(plotW, Math.round(y) + 0.5);
      ctx.stroke();

      ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
      ctx.beginPath();
      ctx.moveTo(plotW, Math.round(y) + 0.5);
      ctx.lineTo(plotW + 4, Math.round(y) + 0.5);
      ctx.stroke();

      ctx.fillStyle = "#71717a";
      ctx.fillText(formatAxisPrice(p, dec), plotW + 8, y);
    }

    // 3. Vertical time grid lines & bottom time labels
    const timeStep = Math.max(1, Math.round(visibleCount / 7));
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let idx = Math.floor(startIdx / timeStep) * timeStep; idx <= endIdx + timeStep; idx += timeStep) {
      const x = indexToX(idx);
      if (x < 30 || x > plotW - 30) continue;

      ctx.strokeStyle = "rgba(255, 255, 255, 0.035)";
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, totalPlotH);
      ctx.stroke();

      const bar = bArr[idx];
      if (bar) {
        const dt = new Date(bar.time * 1000);
        const label =
          intv === "D" || intv === "1D"
            ? dt.toLocaleDateString("en-US", { month: "short", day: "numeric" })
            : dt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
        ctx.fillStyle = "#71717a";
        ctx.fillText(label, x, totalPlotH + BOTTOM_AXIS_HEIGHT / 2);
      }
    }

    // 4. Pinned User Target Levels (`⊕` clicked levels)
    if (pins.length > 0 && curP > 0) {
      ctx.save();
      for (const lvl of pins) {
        const y = priceToY(lvl.price);
        if (y < 4 || y > mainH - 4) continue;
        const pct = ((lvl.price - curP) / curP) * 100;
        const isUp = pct >= 0;

        ctx.strokeStyle = "#38bdf8";
        ctx.lineWidth = 1.25;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(plotW, Math.round(y) + 0.5);
        ctx.stroke();

        const label = `🎯 Target $${formatAxisPrice(lvl.price, dec)} (${formatPctDistance(pct)})`;
        ctx.font = "600 10.5px Inter, -apple-system, sans-serif";
        const tw = ctx.measureText(label).width + 12;
        ctx.fillStyle = "rgba(14, 116, 144, 0.85)";
        ctx.fillRect(plotW - tw - 8, y - 9, tw, 18);
        ctx.fillStyle = isUp ? "#a5f3fc" : "#fecdd3";
        ctx.textAlign = "left";
        ctx.fillText(label, plotW - tw - 2, y);
      }
      ctx.restore();
    }

    // 5. Clip main chart area and draw Volume + Candles / Area + MA36 / MA60 + Studies
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotW, mainH);
    ctx.clip();

    const barWidth = Math.max(2, Math.min(22, (plotW / visibleCount) * 0.72));

    // Volume histogram in bottom 18% of main pane
    if (maxVol > 0) {
      const volMaxH = mainH * 0.18;
      for (let i = startIdx; i <= endIdx; i++) {
        const b = bArr[i];
        if (!b) continue;
        const x = indexToX(i);
        const h = (b.volume / maxVol) * volMaxH;
        const isBull = b.close >= b.open;
        ctx.fillStyle = isBull ? "rgba(62, 224, 161, 0.16)" : "rgba(255, 107, 129, 0.16)";
        ctx.fillRect(x - barWidth / 2, mainH - h, barWidth, h);
      }
    }

    // Candles or Area (batched by bull/bear color to minimize GPU state switches)
    if (cStyle === "3") {
      ctx.beginPath();
      let firstX = 0;
      let lastX = 0;
      for (let i = startIdx; i <= endIdx; i++) {
        const b = bArr[i];
        if (!b) continue;
        const x = indexToX(i);
        const y = priceToY(b.close);
        if (i === startIdx) {
          firstX = x;
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        lastX = x;
      }
      ctx.strokeStyle = "#22d3ee";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.lineTo(lastX, mainH);
      ctx.lineTo(firstX, mainH);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, mainH);
      grad.addColorStop(0, "rgba(34, 211, 238, 0.28)");
      grad.addColorStop(1, "rgba(34, 211, 238, 0.0)");
      ctx.fillStyle = grad;
      ctx.fill();
    } else {
      // Batch bull wicks & bodies, then bear wicks & bodies (2 draw calls instead of 400!)
      for (const passIsBull of [true, false]) {
        const color = passIsBull ? "#26a69a" : "#ef5350";
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = startIdx; i <= endIdx; i++) {
          const b = bArr[i];
          if (!b) continue;
          const isBull = b.close >= b.open;
          if (isBull !== passIsBull) continue;
          const x = Math.round(indexToX(i));
          ctx.moveTo(x + 0.5, priceToY(b.high));
          ctx.lineTo(x + 0.5, priceToY(b.low));
        }
        ctx.stroke();

        for (let i = startIdx; i <= endIdx; i++) {
          const b = bArr[i];
          if (!b) continue;
          const isBull = b.close >= b.open;
          if (isBull !== passIsBull) continue;
          const x = Math.round(indexToX(i));
          const yOpen = priceToY(b.open);
          const yClose = priceToY(b.close);
          const top = Math.min(yOpen, yClose);
          const bodyH = Math.max(1.5, Math.abs(yClose - yOpen));
          ctx.fillRect(x - barWidth / 2, top, barWidth, bodyH);
        }
      }
    }

    // MA36 Line (`#f23645`)
    if (s36) {
      ctx.strokeStyle = "#f23645";
      ctx.lineWidth = 1.65;
      ctx.beginPath();
      let started = false;
      for (let i = Math.max(0, startIdx - 1); i <= endIdx; i++) {
        const val = m36[i];
        if (val === null || val === undefined) continue;
        const x = indexToX(i);
        const y = priceToY(val);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }

    // MA60 Line (`#a855f7`)
    if (s60) {
      ctx.strokeStyle = "#a855f7";
      ctx.lineWidth = 1.65;
      ctx.beginPath();
      let started = false;
      for (let i = Math.max(0, startIdx - 1); i <= endIdx; i++) {
        const val = m60[i];
        if (val === null || val === undefined) continue;
        const x = indexToX(i);
        const y = priceToY(val);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }

    // Optional Bollinger Bands (20, 2)
    if (st.has("BB@tv-basicstudies") && bArr.length >= 20) {
      ctx.lineWidth = 1.2;
      const drawBBLine = (getter: (idx: number) => number | null, stroke: string) => {
        ctx.strokeStyle = stroke;
        ctx.beginPath();
        let started = false;
        for (let i = Math.max(19, startIdx); i <= endIdx; i++) {
          const val = getter(i);
          if (val === null) continue;
          const x = indexToX(i);
          const y = priceToY(val);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      };

      const computeBB = (idx: number) => {
        let sum = 0;
        for (let k = idx - 19; k <= idx; k++) sum += bArr[k].close;
        const mean = sum / 20;
        let sq = 0;
        for (let k = idx - 19; k <= idx; k++) {
          const d = bArr[k].close - mean;
          sq += d * d;
        }
        const std = Math.sqrt(sq / 20);
        return { mean, upper: mean + 2 * std, lower: mean - 2 * std };
      };

      drawBBLine((i) => computeBB(i).upper, "rgba(56, 189, 248, 0.65)");
      drawBBLine((i) => computeBB(i).mean, "rgba(251, 191, 36, 0.65)");
      drawBBLine((i) => computeBB(i).lower, "rgba(56, 189, 248, 0.65)");
    }

    // Optional VWAP overlay
    if (st.has("VWAP@tv-basicstudies") && bArr.length > 0) {
      ctx.strokeStyle = "rgba(56, 189, 248, 0.85)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let cumPV = 0;
      let cumV = 0;
      let started = false;
      for (let i = 0; i <= endIdx; i++) {
        const b = bArr[i];
        const typ = (b.high + b.low + b.close) / 3;
        const v = b.volume > 0 ? b.volume : 1;
        cumPV += typ * v;
        cumV += v;
        if (i >= startIdx) {
          const vwap = cumPV / cumV;
          const x = indexToX(i);
          const y = priceToY(vwap);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
      }
      ctx.stroke();
    }

    // Current Live Price horizontal dashed line across chart
    if (curP > 0) {
      const curY = priceToY(curP);
      const lastBar = bArr[bArr.length - 1];
      const isUp = !lastBar || lastBar.close >= lastBar.open;
      ctx.save();
      ctx.strokeStyle = isUp ? "rgba(38, 166, 154, 0.85)" : "rgba(239, 83, 80, 0.85)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, Math.round(curY) + 0.5);
      ctx.lineTo(plotW, Math.round(curY) + 0.5);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore(); // End main chart clip

    // 6. Optional RSI(14) Sub-pane
    if (rsiH > 0 && bArr.length > 15) {
      const rsiTop = mainH;
      ctx.strokeStyle = "#1e2433";
      ctx.beginPath();
      ctx.moveTo(0, rsiTop + 0.5);
      ctx.lineTo(width, rsiTop + 0.5);
      ctx.stroke();

      const y70 = rsiTop + (1 - 70 / 100) * rsiH;
      const y30 = rsiTop + (1 - 30 / 100) * rsiH;
      ctx.fillStyle = "rgba(139, 92, 246, 0.06)";
      ctx.fillRect(0, y70, plotW, y30 - y70);

      ctx.strokeStyle = "rgba(139, 92, 246, 0.3)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, y70);
      ctx.lineTo(plotW, y70);
      ctx.moveTo(0, y30);
      ctx.lineTo(plotW, y30);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.strokeStyle = "#c084fc";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (let i = Math.max(14, startIdx); i <= endIdx; i++) {
        let gains = 0;
        let losses = 0;
        for (let k = i - 13; k <= i; k++) {
          const diff = bArr[k].close - bArr[k - 1].close;
          if (diff > 0) gains += diff;
          else losses -= diff;
        }
        const rs = losses === 0 ? 100 : gains / losses;
        const rsi = 100 - 100 / (1 + rs);
        const x = indexToX(i);
        const y = rsiTop + (1 - rsi / 100) * rsiH;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();

      ctx.fillStyle = "#a78bfa";
      ctx.font = "600 10px Inter, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText("RSI (14)", 8, rsiTop + 12);
    }

    // 7. Dividers for Right Axis & Bottom Axis
    ctx.strokeStyle = "#1e2433";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotW + 0.5, 0);
    ctx.lineTo(plotW + 0.5, height);
    ctx.moveTo(0, totalPlotH + 0.5);
    ctx.lineTo(width, totalPlotH + 0.5);
    ctx.stroke();

    // 8. RIGHT AXIS PILL 1: Current Live Price + Candle Close Countdown
    if (curP > 0) {
      const nowSec = Math.floor(Date.now() / 1000);
      const curY = Math.max(20, Math.min(mainH - 20, priceToY(curP)));
      const lastBar = bArr[bArr.length - 1];
      const isBull = !lastBar || lastBar.close >= lastBar.open;
      const intvSec = intervalToSeconds(intv);
      const nextCloseSec = (Math.floor(nowSec / intvSec) + 1) * intvSec;
      const remSec = Math.max(0, nextCloseSec - nowSec);

      const pillH = 34;
      const pillY = curY - pillH / 2;
      ctx.fillStyle = isBull ? "#089981" : "#f23645";
      ctx.beginPath();
      ctx.roundRect(plotW + 1, pillY, RIGHT_AXIS_WIDTH - 3, pillH, 4);
      ctx.fill();

      ctx.fillStyle = "#ffffff";
      ctx.font = "700 11.5px Inter, -apple-system, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(formatAxisPrice(curP, dec), plotW + 7, pillY + 10.5);

      ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
      ctx.font = "600 10.5px Inter, -apple-system, sans-serif";
      ctx.fillText(formatCountdown(remSec), plotW + 7, pillY + 24.5);
    }

    ctx.restore();
    drawOverlay();
  }, [computeLayout, drawOverlay]);

  const scheduleMainDraw = useCallback(() => {
    if (rafMainRef.current !== null) return;
    rafMainRef.current = window.requestAnimationFrame(drawMain);
  }, [drawMain]);

  const scheduleOverlayDraw = useCallback(() => {
    if (rafOverlayRef.current !== null) return;
    rafOverlayRef.current = window.requestAnimationFrame(drawOverlay);
  }, [drawOverlay]);

  // Redraw when data, livePrice, studies, or pinned levels change
  useEffect(() => {
    scheduleMainDraw();
  }, [bars, currentPrice, decimals, interval, chartStyle, studies, showMa36, showMa60, pinnedLevels, scheduleMainDraw]);

  // 1-second tick for countdown pill on right axis
  useEffect(() => {
    const id = window.setInterval(() => {
      scheduleMainDraw();
    }, 1000);
    return () => window.clearInterval(id);
  }, [scheduleMainDraw]);

  // ResizeObserver for crisp high-DPI dual-canvas sizing
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 20 && rect.height > 20) {
        const w = Math.floor(rect.width);
        const h = Math.floor(rect.height);
        if (sizeRef.current.width !== w || sizeRef.current.height !== h) {
          sizeRef.current = { width: w, height: h };
          const dpr = window.devicePixelRatio || 1;
          const targetW = Math.round(w * dpr);
          const targetH = Math.round(h * dpr);
          if (mainCanvasRef.current) {
            mainCanvasRef.current.width = targetW;
            mainCanvasRef.current.height = targetH;
          }
          if (overlayCanvasRef.current) {
            overlayCanvasRef.current.width = targetW;
            overlayCanvasRef.current.height = targetH;
          }
          drawMain();
        }
      }
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, [drawMain]);

  // Native non-passive `wheel` listener: 120fps cursor-anchored zoom & pan with ZERO React re-renders
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const plotW = Math.max(100, sizeRef.current.width - RIGHT_AXIS_WIDTH);
      const vp = viewRef.current;

      const rawDeltaY = e.deltaMode === 1 ? e.deltaY * 28 : e.deltaY;
      const rawDeltaX = e.deltaMode === 1 ? e.deltaX * 28 : e.deltaX;
      const clampedY = Math.max(-140, Math.min(140, rawDeltaY));

      // 1. Over right price axis (or Alt held): zoom vertical price scale smoothly
      if (x > plotW || e.altKey) {
        const vFactor = Math.exp(clampedY * 0.003);
        vp.verticalScaleFactor = Math.max(0.15, Math.min(30, vp.verticalScaleFactor * vFactor));
        scheduleMainDraw();
        return;
      }

      // 2. Two-finger horizontal trackpad pan when horizontal swipe dominates
      if (!e.ctrlKey && !e.metaKey && Math.abs(rawDeltaX) > Math.abs(rawDeltaY) * 1.25 && Math.abs(rawDeltaX) > 1.5) {
        const barsPerPx = vp.visibleCount / plotW;
        vp.rightOffsetBars -= rawDeltaX * barsPerPx * 0.85;
        scheduleMainDraw();
        return;
      }

      // 3. TradingView-style Cursor-Anchored Horizontal Zoom
      const zoomFactor = Math.exp(clampedY * 0.0024);
      const prevVis = vp.visibleCount;
      const nextVis = Math.max(16, Math.min(360, prevVis * zoomFactor));
      const deltaVis = nextVis - prevVis;
      if (Math.abs(deltaVis) < 0.01) return;

      const cursorFracFromLeft = Math.max(0, Math.min(1, x / plotW));
      const rightWeight = 1 - cursorFracFromLeft;

      vp.visibleCount = nextVis;
      vp.rightOffsetBars += deltaVis * rightWeight;
      scheduleMainDraw();
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scheduleMainDraw]);

  // Window-level drag tracking at 120fps without React state updates
  useEffect(() => {
    const onWinMouseMove = (e: MouseEvent) => {
      if (dragModeRef.current === "none") return;
      const el = mainCanvasRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const plotW = Math.max(100, sizeRef.current.width - RIGHT_AXIS_WIDTH);
      const mainH = layoutRef.current?.mainH ?? Math.max(120, sizeRef.current.height - BOTTOM_AXIS_HEIGHT);
      const vp = viewRef.current;

      if (dragModeRef.current === "pan") {
        const dx = x - dragStartRef.current.x;
        const dy = y - dragStartRef.current.y;
        const barsPerPx = vp.visibleCount / plotW;
        vp.rightOffsetBars = dragStartRef.current.rightOffsetBars + dx * barsPerPx;
        if (dragStartRef.current.verticalScaleFactor !== 1 || Math.abs(dy) > 3) {
          const pricePerPx = dragStartRef.current.priceSpan / mainH;
          vp.verticalPricePanOffset = dragStartRef.current.verticalPricePanOffset + dy * pricePerPx;
        }
        scheduleMainDraw();
      } else if (dragModeRef.current === "priceAxis") {
        const dy = y - dragStartRef.current.y;
        vp.verticalScaleFactor = Math.max(
          0.15,
          Math.min(30, dragStartRef.current.verticalScaleFactor * Math.exp(dy * 0.007)),
        );
        scheduleMainDraw();
      }
    };

    const onWinMouseUp = () => {
      if (dragModeRef.current === "ruler") {
        setRulerMode(false);
      }
      dragModeRef.current = "none";
    };

    window.addEventListener("mousemove", onWinMouseMove);
    window.addEventListener("mouseup", onWinMouseUp);
    return () => {
      window.removeEventListener("mousemove", onWinMouseMove);
      window.removeEventListener("mouseup", onWinMouseUp);
    };
  }, [scheduleMainDraw]);

  useEffect(() => {
    return () => {
      if (rafMainRef.current !== null) window.cancelAnimationFrame(rafMainRef.current);
      if (rafOverlayRef.current !== null) window.cancelAnimationFrame(rafOverlayRef.current);
    };
  }, []);

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const ly = layoutRef.current ?? computeLayout();
    const vp = viewRef.current;

    if (x >= ly.plotW - 26 && x <= ly.plotW && y >= 0 && y <= ly.mainH) {
      const targetPrice = ly.yToPrice(y);
      if (Number.isFinite(targetPrice) && targetPrice > 0) {
        setPinnedLevels((prev) => [
          ...prev.slice(-5),
          { id: `${Date.now()}-${Math.random()}`, price: targetPrice },
        ]);
      }
      return;
    }

    if (x > ly.plotW) {
      dragModeRef.current = "priceAxis";
      dragStartRef.current = {
        x,
        y,
        rightOffsetBars: vp.rightOffsetBars,
        verticalScaleFactor: vp.verticalScaleFactor,
        verticalPricePanOffset: vp.verticalPricePanOffset,
        priceSpan: ly.priceSpan,
      };
      return;
    }

    if (e.shiftKey || rulerModeRef.current) {
      dragModeRef.current = "ruler";
      const startPrice = ly.yToPrice(y);
      const startIdx = ly.xToIndex(x);
      rulerRef.current = {
        startX: x,
        startY: y,
        endX: x,
        endY: y,
        startPrice,
        endPrice: startPrice,
        startIdx,
        endIdx: startIdx,
      };
      scheduleOverlayDraw();
      return;
    }

    dragModeRef.current = "pan";
    dragStartRef.current = {
      x,
      y,
      rightOffsetBars: vp.rightOffsetBars,
      verticalScaleFactor: vp.verticalScaleFactor,
      verticalPricePanOffset: vp.verticalPricePanOffset,
      priceSpan: ly.priceSpan,
    };
    if (rulerRef.current) {
      rulerRef.current = null;
      scheduleOverlayDraw();
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    mouseRef.current = { x, y, active: true };

    const ly = layoutRef.current;
    if (ly) {
      e.currentTarget.style.cursor = x > ly.plotW ? "ns-resize" : "crosshair";
      if (dragModeRef.current === "ruler" && rulerRef.current) {
        const clampedX = Math.min(ly.plotW, Math.max(0, x));
        const clampedY = Math.min(ly.mainH, Math.max(0, y));
        rulerRef.current = {
          ...rulerRef.current,
          endX: clampedX,
          endY: clampedY,
          endPrice: ly.yToPrice(clampedY),
          endIdx: ly.xToIndex(clampedX),
        };
      }
    }
    scheduleOverlayDraw();
  };

  const handleMouseUp = () => {
    if (dragModeRef.current === "ruler") {
      setRulerMode(false);
    }
    dragModeRef.current = "none";
  };

  const zoomHorizontalBy = (factor: number) => {
    const vp = viewRef.current;
    const prevVis = vp.visibleCount;
    const nextVis = Math.max(16, Math.min(360, prevVis * factor));
    const deltaVis = nextVis - prevVis;
    vp.visibleCount = nextVis;
    vp.rightOffsetBars += deltaVis * 0.2;
    scheduleMainDraw();
  };

  const latestBar = bars.length > 0 ? bars[bars.length - 1] : null;
  const latestMa36 = bars.length > 0 ? ma36Series[bars.length - 1] : null;
  const latestMa60 = bars.length > 0 ? ma60Series[bars.length - 1] : null;

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full select-none overflow-hidden bg-[#080a10] overscroll-contain touch-none"
      style={{ contain: "strict" }}
    >
      {/* Layer 1: GPU-composited Main Candlesticks & Studies Canvas */}
      <canvas
        ref={mainCanvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          mouseRef.current.active = false;
          scheduleOverlayDraw();
        }}
        onDoubleClick={() => {
          viewRef.current = {
            visibleCount: 110,
            rightOffsetBars: 6,
            verticalScaleFactor: 1,
            verticalPricePanOffset: 0,
          };
          rulerRef.current = null;
          scheduleMainDraw();
        }}
        className="block h-full w-full cursor-crosshair will-change-transform"
      />

      {/* Layer 2: Ultra-fast Transparent Crosshair, % Telemetry & Ruler Overlay Canvas */}
      <canvas
        ref={overlayCanvasRef}
        className="pointer-events-none absolute inset-0 block h-full w-full will-change-transform"
      />

      {/* Top-Left Live Legend: Timestamp + OHLC + MA36 / MA60 (Updated via Direct DOM Refs at 120fps) */}
      <div className="pointer-events-none absolute left-2.5 top-2 flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-800/80 bg-[#090c14]/90 px-2.5 py-1 text-[11px]">
          <span className="font-mono text-[11px] font-medium text-zinc-200 tabular-nums">
            <span className="mr-1 text-zinc-400">›</span>
            <span ref={timeElRef}>{latestBar ? formatBarTimestamp(latestBar.time) : "—"}</span>
          </span>
          <span className="font-bold text-zinc-100">{displaySymbol}</span>
          <div className="flex items-center gap-2 text-[11px] tabular-nums">
            <span className="text-zinc-400">
              O <strong ref={openElRef} className="text-zinc-200">{latestBar ? formatAxisPrice(latestBar.open, decimals) : "—"}</strong>
            </span>
            <span className="text-zinc-400">
              H <strong ref={highElRef} className="text-zinc-200">{latestBar ? formatAxisPrice(latestBar.high, decimals) : "—"}</strong>
            </span>
            <span className="text-zinc-400">
              L <strong ref={lowElRef} className="text-zinc-200">{latestBar ? formatAxisPrice(latestBar.low, decimals) : "—"}</strong>
            </span>
            <span className="text-zinc-400">
              C{" "}
              <strong
                ref={closeElRef}
                className={!latestBar || latestBar.close >= latestBar.open ? "text-[#3ee0a1]" : "text-[#ff6b81]"}
              >
                {latestBar ? formatAxisPrice(latestBar.close, decimals) : "—"}
              </strong>
            </span>
          </div>

          <div
            ref={cursorWrapElRef}
            style={{ display: "none" }}
            className="items-center gap-1.5 border-l border-zinc-700/80 pl-2 text-[11px] tabular-nums"
          >
            <span className="text-[10px] uppercase text-zinc-400">Cursor:</span>
            <span ref={cursorPriceElRef} className="font-bold text-white" />
            <span ref={cursorPctElRef} className="rounded px-1.5 py-0.2 font-bold" />
          </div>
        </div>

        {/* Row 2: Interactive `▾ MA  MA36  MA60` Legend */}
        <div className="pointer-events-auto flex w-fit items-center gap-2 rounded-md border border-zinc-800/80 bg-[#090c14]/90 px-2.5 py-1 text-[11.5px] tabular-nums">
          <button
            type="button"
            onClick={() => setMaLegendExpanded((v) => !v)}
            className="flex items-center gap-1 font-semibold text-zinc-200 hover:text-white"
            title="Collapse or expand MA indicator row"
          >
            <span className="text-[10px] text-zinc-400">{maLegendExpanded ? "▾" : "▸"}</span>
            <span>MA</span>
          </button>

          {maLegendExpanded && (
            <>
              <button
                type="button"
                onClick={() => onToggleStudy?.("MA36")}
                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-all ${
                  showMa36 ? "bg-[#f23645]/15 ring-1 ring-[#f23645]/50" : "opacity-55 hover:opacity-90"
                }`}
                title={showMa36 ? "MA36 is ON — Click to hide MA36 line" : "Click to enable MA36 line on chart"}
              >
                <span className="h-2 w-2 rounded-full bg-[#f23645]" />
                <span className="font-medium text-zinc-200">MA36:</span>
                <span ref={ma36ValElRef} className="font-semibold text-[#f23645]">
                  {showMa36
                    ? latestMa36 !== null && latestMa36 !== undefined
                      ? formatAxisPrice(latestMa36, decimals)
                      : "—"
                    : "OFF (Click)"}
                </span>
              </button>

              <button
                type="button"
                onClick={() => onToggleStudy?.("MA60")}
                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-all ${
                  showMa60 ? "bg-[#a855f7]/15 ring-1 ring-[#a855f7]/50" : "opacity-55 hover:opacity-90"
                }`}
                title={showMa60 ? "MA60 is ON — Click to hide MA60 line" : "Click to enable MA60 line on chart"}
              >
                <span className="h-2 w-2 rounded-full bg-[#a855f7]" />
                <span className="font-medium text-zinc-200">MA60:</span>
                <span ref={ma60ValElRef} className="font-semibold text-[#a855f7]">
                  {showMa60
                    ? latestMa60 !== null && latestMa60 !== undefined
                      ? formatAxisPrice(latestMa60, decimals)
                      : "—"
                    : "OFF (Click)"}
                </span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Top-Right Quick MA36/MA60 & Zoom/Ruler Controls */}
      <div className="absolute right-[104px] top-2 flex flex-wrap items-center gap-1 rounded-md border border-zinc-800/90 bg-[#090c14]/90 p-1 text-[10px]">
        <button
          type="button"
          onClick={() => onToggleStudy?.("MA36")}
          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-semibold transition-colors ${
            showMa36
              ? "bg-[#f23645]/20 text-[#ff8a93] border border-[#f23645]/50"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
          title="Toggle MA 36 line on chart"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-[#f23645]" />
          <span>MA36</span>
        </button>
        <button
          type="button"
          onClick={() => onToggleStudy?.("MA60")}
          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-semibold transition-colors ${
            showMa60
              ? "bg-[#a855f7]/20 text-[#d8b4fe] border border-[#a855f7]/50"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
          title="Toggle MA 60 line on chart"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-[#a855f7]" />
          <span>MA60</span>
        </button>

        <div className="mx-0.5 h-3 w-px bg-zinc-800" />

        <button
          type="button"
          onClick={() => zoomHorizontalBy(0.75)}
          className="rounded border border-zinc-700/80 bg-[#101420] px-1.5 py-0.5 font-bold text-zinc-200 hover:bg-zinc-800 hover:text-white"
          title="Zoom In candles (or scroll mouse wheel up over chart)"
        >
          ＋
        </button>
        <button
          type="button"
          onClick={() => zoomHorizontalBy(1.33)}
          className="rounded border border-zinc-700/80 bg-[#101420] px-1.5 py-0.5 font-bold text-zinc-200 hover:bg-zinc-800 hover:text-white"
          title="Zoom Out candles (or scroll mouse wheel down over chart)"
        >
          －
        </button>
        <button
          type="button"
          onClick={() => {
            viewRef.current = {
              visibleCount: 110,
              rightOffsetBars: 6,
              verticalScaleFactor: 1,
              verticalPricePanOffset: 0,
            };
            rulerRef.current = null;
            scheduleMainDraw();
          }}
          className="rounded px-1.5 py-0.5 font-semibold text-zinc-400 hover:bg-zinc-800 hover:text-white"
          title="Reset chart zoom to auto-fit candles (or double-click chart)"
        >
          Auto Fit
        </button>
        <button
          type="button"
          onClick={() => setRulerMode((v) => !v)}
          className={`rounded px-2 py-0.5 font-semibold transition-colors ${
            rulerMode
              ? "bg-amber-500/25 text-amber-200 border border-amber-500/40"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
          title="Measure % distance between any two points (or hold Shift + Drag)"
        >
          📏 Measure
        </button>
        {pinnedLevels.length > 0 && (
          <button
            type="button"
            onClick={() => setPinnedLevels([])}
            className="rounded bg-rose-500/20 px-1.5 py-0.5 font-semibold text-rose-300 hover:bg-rose-500/30"
            title="Clear pinned target lines"
          >
            Clear Pins ({pinnedLevels.length})
          </button>
        )}
      </div>

      {loading && bars.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#080a10]/70 text-xs text-zinc-400">
          Loading {displaySymbol} candles...
        </div>
      )}
      {error && bars.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#080a10]/80 text-xs text-rose-300">
          {error}
        </div>
      )}
    </div>
  );
});
