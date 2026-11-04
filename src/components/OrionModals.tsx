"use client";

import React, { memo, useState } from "react";
import type { ExchangeId } from "@/lib/exchange";
import { EXCHANGE_LABEL, toDisplaySymbol } from "@/lib/exchange";
import {
  formatExactFilterValue,
  formatFilterFieldLabel,
  formatFilterRuleSummary,
  formatFilterThreshold,
  parseFilterInput,
  parseShorthandNumber,
  type CompareOp,
} from "@/lib/screener";


export type SoundId = "boop" | "bell" | "ding" | "alert" | "chime";

export const ALERT_SOUNDS: { id: SoundId; label: string }[] = [
  { id: "boop", label: "Boop" },
  { id: "bell", label: "Bell" },
  { id: "ding", label: "Ding" },
  { id: "alert", label: "Alert" },
  { id: "chime", label: "Chime" },
];

const SOUND_PROFILES: Record<
  SoundId,
  { frequencies: number[]; durations: number[]; type: OscillatorType; volume: number }
> = {
  boop: { frequencies: [440, 330], durations: [0.1, 0.1], type: "sine", volume: 0.3 },
  bell: { frequencies: [880, 660, 880], durations: [0.15, 0.1, 0.2], type: "sine", volume: 0.25 },
  ding: { frequencies: [1200], durations: [0.3], type: "sine", volume: 0.2 },
  alert: { frequencies: [800, 600, 800, 600], durations: [0.1, 0.1, 0.1, 0.1], type: "square", volume: 0.15 },
  chime: { frequencies: [523, 659, 784, 1047], durations: [0.15, 0.15, 0.15, 0.3], type: "sine", volume: 0.2 },
};

let sharedAudioCtx: AudioContext | null = null;

export function playAlertSound(soundId: SoundId = "chime"): void {
  if (typeof window === "undefined") return;
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    if (!sharedAudioCtx) sharedAudioCtx = new Ctx();
    if (sharedAudioCtx.state === "suspended") {
      void sharedAudioCtx.resume();
    }
    const profile = SOUND_PROFILES[soundId] ?? SOUND_PROFILES.chime;
    let startTime = sharedAudioCtx.currentTime;
    profile.frequencies.forEach((freq, idx) => {
      if (!sharedAudioCtx) return;
      const osc = sharedAudioCtx.createOscillator();
      const gain = sharedAudioCtx.createGain();
      osc.type = profile.type;
      osc.frequency.setValueAtTime(freq, startTime);
      gain.gain.setValueAtTime(profile.volume, startTime);
      const dur = profile.durations[idx] ?? 0.15;
      gain.gain.exponentialRampToValueAtTime(0.01, startTime + dur);
      osc.connect(gain);
      gain.connect(sharedAudioCtx.destination);
      osc.start(startTime);
      osc.stop(startTime + dur);
      startTime += dur;
    });
  } catch {
    // Ignore audio context block before user gesture
  }
}

export const Sparkline24h = memo(
  function Sparkline24h({
    points,
    change24hPct,
    complete = true,
  }: {
    points?: number[];
    change24hPct?: number | null;
    complete?: boolean;
  }) {
    if (!points || points.length < 2) {
      return (
        <span className="block w-[92px] text-center text-xs text-[#606060]" title="24h trend unavailable">
          —
        </span>
      );
    }

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < points.length; i++) {
      const v = points[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const range = max - min;
    const w = 92;
    const h = 24;
    const padX = 2;
    const padY = 3;
    const innerW = w - padX * 2;
    const innerH = h - padY * 2;

    const coords: string[] = [];
    for (let i = 0; i < points.length; i++) {
      const x = padX + (i / (points.length - 1)) * innerW;
      const norm = range > 0 ? (points[i] - min) / range : 0.5;
      const y = padY + (1 - norm) * innerH;
      coords.push(`${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
    }
    const dPath = coords.join(" ");

    const first = points[0];
    const last = points[points.length - 1];
    const isUp = change24hPct !== null && change24hPct !== undefined ? change24hPct >= 0 : last >= first;
    const isFlat = range === 0;
    const strokeColor = isFlat ? "#808080" : isUp ? "#3ee0a1" : "#ff6b81";

    return (
      <div
        className="relative flex h-6 w-[92px] items-center"
        title={`24h Trend (${isUp ? "Up" : "Down"})${complete ? " · 1m candle series" : " · snapshot series"}`}
      >
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
          <path
            d={dPath}
            fill="none"
            stroke={strokeColor}
            strokeWidth="1.45"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    );
  },
  (prev, next) =>
    prev.points === next.points &&
    prev.complete === next.complete &&
    ((prev.change24hPct ?? 0) >= 0) === ((next.change24hPct ?? 0) >= 0),
);

const AVATAR_PALETTE = [
  "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
  "bg-amber-500/20 text-amber-300 border-amber-500/30",
  "bg-purple-500/20 text-purple-300 border-purple-500/30",
  "bg-rose-500/20 text-rose-300 border-rose-500/30",
  "bg-blue-500/20 text-blue-300 border-blue-500/30",
  "bg-indigo-500/20 text-indigo-300 border-indigo-500/30",
];

export const TokenAvatar = memo(function TokenAvatar({
  symbol,
  iconUrl,
}: {
  symbol: string;
  iconUrl?: string | null;
}) {
  const [failed, setFailed] = useState(false);
  const clean = symbol
    .replace(/_USDT$/, "")
    .replace(/USDT$/, "")
    .replace(/^(1000000|100000|10000|1000|100)/, "");
  const initials = (clean.slice(0, 2) || "??").toUpperCase();
  let hash = 0;
  for (let i = 0; i < symbol.length; i++) {
    hash = (hash * 31 + symbol.charCodeAt(i)) >>> 0;
  }
  const colorCls = AVATAR_PALETTE[hash % AVATAR_PALETTE.length];

  if (iconUrl && !failed) {
    return (
      <img
        src={iconUrl}
        alt={initials}
        loading="lazy"
        onError={() => setFailed(true)}
        className="h-4 w-4 shrink-0 rounded-full bg-[#151821] object-cover"
      />
    );
  }

  return (
    <span
      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[8px] font-bold leading-none ${colorCls}`}
    >
      {initials}
    </span>
  );
});

export function ExchangeBadgeIcon({
  exchange,
  size = "sm",
}: {
  exchange: ExchangeId;
  size?: "sm" | "md";
}) {
  const dim = size === "md" ? "h-5 w-5" : "h-4 w-4";

  if (exchange === "mexc") {
    // Official MEXC overlapping dual-peak mountain wave logo
    return (
      <span
        className={`inline-flex ${dim} shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#0c1a38] to-[#061024] ring-1 ring-[#1f6fff]/40 shadow-[0_0_8px_rgba(22,119,255,0.25)]`}
      >
        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none">
          <defs>
            <linearGradient id="mexcLeft" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#2998FF" />
              <stop offset="100%" stopColor="#0052D9" />
            </linearGradient>
            <linearGradient id="mexcRight" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#35F0C7" />
              <stop offset="100%" stopColor="#1677FF" />
            </linearGradient>
          </defs>
          <path
            d="M2.4 17.4L7.7 7.4C8.4 6.1 10.2 6.1 10.9 7.4L16.2 17.4H11.9L9.3 12.2L6.7 17.4H2.4Z"
            fill="url(#mexcLeft)"
          />
          <path
            d="M9.8 17.4L14.3 9.0C15.0 7.7 16.8 7.7 17.5 9.0L21.8 17.4H17.7L15.9 13.7L14.0 17.4H9.8Z"
            fill="url(#mexcRight)"
          />
        </svg>
      </span>
    );
  }

  if (exchange === "bybit") {
    // Official Bybit dark badge with crisp white geometric B + signature #F7A600 yellow vertical bar
    return (
      <span
        className={`inline-flex ${dim} shrink-0 items-center justify-center rounded-full bg-[#12141a] ring-1 ring-[#f7a600]/45 shadow-[0_0_8px_rgba(247,166,0,0.2)]`}
      >
        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none">
          <path
            d="M5 6.2H11.2C13.1 6.2 14.3 7.2 14.3 8.8C14.3 10 13.6 10.9 12.5 11.3C13.9 11.7 14.7 12.7 14.7 14.2C14.7 16.1 13.3 17.4 11.1 17.4H5V6.2ZM7.6 10.5H10.6C11.4 10.5 11.9 10 11.9 9.2C11.9 8.5 11.4 8 10.6 8H7.6V10.5ZM7.6 15.5H10.8C11.7 15.5 12.2 14.9 12.2 14.1C12.2 13.2 11.7 12.7 10.8 12.7H7.6V15.5Z"
            fill="#F4F4F5"
          />
          <rect x="16.4" y="6.2" width="2.8" height="11.2" rx="1" fill="#F7A600" />
        </svg>
      </span>
    );
  }

  if (exchange === "binance") {
    // Official Binance 5-diamond emblem inside a dark gold-ringed badge
    return (
      <span
        className={`inline-flex ${dim} shrink-0 items-center justify-center rounded-full bg-[#17140a] ring-1 ring-[#F0B90B]/45 shadow-[0_0_8px_rgba(240,185,11,0.22)]`}
      >
        <svg viewBox="0 0 24 24" fill="#F0B90B" className="h-3 w-3">
          <path d="M12 3L8.5 6.5L10.6 8.6L12 7.2L13.4 8.6L15.5 6.5L12 3ZM6.5 8.5L3 12L6.5 15.5L8.6 13.4L7.2 12L8.6 10.6L6.5 8.5ZM17.5 8.5L15.4 10.6L16.8 12L15.4 13.4L17.5 15.5L21 12L17.5 8.5ZM12 9.8L9.8 12L12 14.2L14.2 12L12 9.8ZM10.6 15.4L8.5 17.5L12 21L15.5 17.5L13.4 15.4L12 16.8L10.6 15.4Z" />
        </svg>
      </span>
    );
  }

  // Official Hyperliquid mint-teal asymmetric infinity droplet emblem on deep forest-teal badge
  return (
    <span
      className={`inline-flex ${dim} shrink-0 items-center justify-center rounded-full bg-[#07221d] ring-1 ring-[#50e3c2]/45 shadow-[0_0_8px_rgba(80,227,194,0.25)]`}
    >
      <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none">
        <path
          d="M7.2 7.5C4.8 7.5 3 9.5 3 12C3 14.5 4.8 16.5 7.2 16.5C9.2 16.5 10.7 15.1 12 13.3C13.3 15.1 14.8 16.5 16.8 16.5C19.2 16.5 21 14.5 21 12C21 9.5 19.2 7.5 16.8 7.5C14.8 7.5 13.3 8.9 12 10.7C10.7 8.9 9.2 7.5 7.2 7.5Z"
          fill="#7AF8DC"
        />
      </svg>
    </span>
  );
}

export interface AlertConditionRule {
  id: string;
  name: string;
  field: string;
  fieldLabel: string;
  op: "gt" | "lt" | "abs_gt";
  value: number;
  sound: SoundId;
  cooldownMs: number;
  enabled: boolean;
}

export interface TriggeredAlertEvent {
  id: string;
  ts: number;
  exchange: ExchangeId;
  symbol: string;
  ruleName: string;
  detail: string;
  price: number;
  isBullish: boolean;
}

function OrionCheckTile({
  label,
  checked,
  disabled,
  title,
  onToggle,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  title?: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onToggle}
      title={title}
      className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-all select-none ${
        disabled
          ? "cursor-not-allowed border-[#1c1e26] bg-[#121318] opacity-65"
          : checked
            ? "cursor-pointer border-[#2563eb]/40 bg-[#141722] hover:bg-[#191d2b]"
            : "cursor-pointer border-[#191b22] bg-[#111217] hover:border-[#272a35] hover:bg-[#161820]"
      }`}
    >
      <span
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors ${
          disabled
            ? "border-[#52525b] bg-[#3f3f46] text-[#18181b]"
            : checked
              ? "border-[#2563eb] bg-[#2563eb] text-white shadow-[0_0_8px_rgba(37,99,235,0.35)]"
              : "border-[#3f3f46] bg-[#18181b] text-transparent"
        }`}
      >
        <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="3.5 8.5 6.5 11.5 12.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className={`text-[13px] font-medium ${checked ? "text-[#f4f4f5]" : "text-[#a1a1aa]"}`}>
        {label}
      </span>
    </button>
  );
}

export function OrionColumnVisibilityDrawer({
  visible,
  showSparkline,
  onToggleSparkline,
  onToggleColumn,
  onToggleGroup,
  groupAllOn,
  onApplyPreset,
  onClose,
  groups,
  coreColumns,
}: {
  visible: Set<string>;
  showSparkline: boolean;
  onToggleSparkline: (val: boolean) => void;
  onToggleColumn: (key: string) => void;
  onToggleGroup: (groupKey: string, on: boolean) => void;
  groupAllOn: (groupKey: string) => boolean;
  onApplyPreset: (preset: "orionDefault" | "scalper" | "orderflow" | "momentum" | "coreOnly" | "all") => void;
  onClose: () => void;
  groups: readonly { key: string; label: string; menuLabel: string; timeframes: readonly string[] }[];
  coreColumns: readonly { key: string; label: string; shortTip?: string; orionCore?: boolean }[];
}) {
  const orionCoreCols = coreColumns.filter((c) => c.orionCore);
  const extraAlphaCols = coreColumns.filter((c) => !c.orionCore);

  const allOrionCoreOn =
    showSparkline && orionCoreCols.every((c) => c.key === "symbol" || visible.has(c.key));
  const allExtraAlphaOn = extraAlphaCols.every((c) => visible.has(c.key));

  const toggleAllOrionCore = () => {
    const targetOn = !allOrionCoreOn;
    onToggleSparkline(targetOn);
    for (const col of orionCoreCols) {
      if (col.key === "symbol") continue;
      if (visible.has(col.key) !== targetOn) {
        onToggleColumn(col.key);
      }
    }
  };

  const toggleAllExtraAlpha = () => {
    const targetOn = !allExtraAlphaOn;
    for (const col of extraAlphaCols) {
      if (visible.has(col.key) !== targetOn) {
        onToggleColumn(col.key);
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/45 backdrop-blur-[1px]" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-[410px] flex-col border-l border-[#1f2430] bg-[#0a0b0e] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#1a1d26] px-4 py-3.5">
          <span className="text-[15px] font-semibold text-[#f4f4f5]">Column Visibility</span>
          <button
            onClick={onClose}
            className="rounded p-1 text-xl leading-none text-[#71717a] hover:bg-[#181b24] hover:text-[#f4f4f5]"
            aria-label="Close Column Visibility"
          >
            ×
          </button>
        </div>

        {/* Scrollable Body matching Orion Screenshot */}
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3.5">
          {/* CORE Section */}
          <div>
            <div className="mb-2.5 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[#71717a]">CORE</span>
              <button
                type="button"
                onClick={toggleAllOrionCore}
                className={`rounded px-1.5 py-0.5 text-xs font-medium transition-colors ${
                  allOrionCoreOn
                    ? "text-[#ff6b81] hover:bg-[#ff6b81]/10"
                    : "text-[#3ee0a1] hover:bg-[#3ee0a1]/10"
                }`}
              >
                {allOrionCoreOn ? "Hide All" : "Show All"}
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              <OrionCheckTile
                label="24h trend"
                checked={showSparkline}
                title="24h price sparkline chart"
                onToggle={() => onToggleSparkline(!showSparkline)}
              />
              {orionCoreCols.map((col) => {
                const isSymbol = col.key === "symbol";
                const checked = isSymbol || visible.has(col.key);
                return (
                  <OrionCheckTile
                    key={col.key}
                    label={col.label}
                    checked={checked}
                    disabled={isSymbol}
                    title={col.shortTip}
                    onToggle={() => !isSymbol && onToggleColumn(col.key)}
                  />
                );
              })}
            </div>

            {/* Extra MEXC Alpha Core Columns */}
            {extraAlphaCols.length > 0 && (
              <div className="mt-3.5 border-t border-[#181b24] pt-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-[#71717a]">
                    MCAP RATIOS & EXTRA ALPHA
                  </span>
                  <button
                    type="button"
                    onClick={toggleAllExtraAlpha}
                    className={`rounded px-1.5 py-0.5 text-xs font-medium transition-colors ${
                      allExtraAlphaOn
                        ? "text-[#ff6b81] hover:bg-[#ff6b81]/10"
                        : "text-[#3ee0a1] hover:bg-[#3ee0a1]/10"
                    }`}
                  >
                    {allExtraAlphaOn ? "Hide All" : "Show All"}
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {extraAlphaCols.map((col) => (
                    <OrionCheckTile
                      key={col.key}
                      label={col.label}
                      checked={visible.has(col.key)}
                      title={col.shortTip}
                      onToggle={() => onToggleColumn(col.key)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* All 11 Timeframe Metric Groups matching Orion Screenshot */}
          {groups.map((g) => {
            const allOn = groupAllOn(g.key);
            return (
              <div key={g.key} className="border-t border-[#181b24] pt-3.5">
                <div className="mb-2.5 flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-[#71717a]">
                    {g.menuLabel}
                  </span>
                  <button
                    type="button"
                    onClick={() => onToggleGroup(g.key, !allOn)}
                    className={`rounded px-1.5 py-0.5 text-xs font-medium transition-colors ${
                      allOn
                        ? "text-[#ff6b81] hover:bg-[#ff6b81]/10"
                        : "text-[#3ee0a1] hover:bg-[#3ee0a1]/10"
                    }`}
                  >
                    {allOn ? "Hide All" : "Show All"}
                  </button>
                </div>
                <div className="grid grid-cols-5 gap-2">
                  {g.timeframes.map((tf) => {
                    const key = `${g.key}:${tf}`;
                    const checked = visible.has(key);
                    return (
                      <OrionCheckTile
                        key={key}
                        label={tf}
                        checked={checked}
                        onToggle={() => onToggleColumn(key)}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Bottom Footer Presets matching Orion Screenshot */}
        <div className="border-t border-[#1a1d26] bg-[#0d0f14] p-3">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onApplyPreset("all")}
              className="flex-1 rounded-md bg-[#171a24] py-2 text-xs font-medium text-[#d4d4d8] hover:bg-[#222634] hover:text-white"
            >
              All
            </button>
            <button
              type="button"
              onClick={() => onApplyPreset("orionDefault")}
              className="flex-1 rounded-md bg-[#171a24] py-2 text-xs font-medium text-[#d4d4d8] hover:bg-[#222634] hover:text-white"
            >
              Defaults
            </button>
            <button
              type="button"
              onClick={() => onApplyPreset("coreOnly")}
              className="flex-1 rounded-md bg-[#171a24] py-2 text-xs font-medium text-[#d4d4d8] hover:bg-[#222634] hover:text-white"
            >
              Core Only
            </button>
          </div>
          <div className="mt-2 flex gap-1.5">
            <button
              type="button"
              onClick={() => onApplyPreset("scalper")}
              className="flex-1 rounded border border-[#222634] bg-[#11131a] py-1 text-[11px] text-cyan-300 hover:bg-cyan-500/10"
            >
              ⚡ Scalper
            </button>
            <button
              type="button"
              onClick={() => onApplyPreset("orderflow")}
              className="flex-1 rounded border border-[#222634] bg-[#11131a] py-1 text-[11px] text-emerald-300 hover:bg-emerald-500/10"
            >
              📊 Orderflow
            </button>
            <button
              type="button"
              onClick={() => onApplyPreset("momentum")}
              className="flex-1 rounded border border-[#222634] bg-[#11131a] py-1 text-[11px] text-amber-300 hover:bg-amber-500/10"
            >
              🚀 Momentum
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export interface FilterFieldOption {
  value: string;
  label: string;
  group?: string;
}

export function renderGroupedFieldOptions(fieldOptions: readonly FilterFieldOption[]) {
  const hasGroups = fieldOptions.some((f) => Boolean(f.group));
  if (!hasGroups) {
    return fieldOptions.map((f) => (
      <option key={f.value} value={f.value}>
        {f.label}
      </option>
    ));
  }
  const groups: { name: string; items: FilterFieldOption[] }[] = [];
  const byName = new Map<string, FilterFieldOption[]>();
  for (const item of fieldOptions) {
    const g = item.group ?? "Other Metrics";
    let list = byName.get(g);
    if (!list) {
      list = [];
      byName.set(g, list);
      groups.push({ name: g, items: list });
    }
    list.push(item);
  }
  return groups.map((g) => (
    <optgroup key={g.name} label={g.name}>
      {g.items.map((f) => (
        <option key={f.value} value={f.value}>
          {f.label}
        </option>
      ))}
    </optgroup>
  ));
}

export function OrionAlertsDrawer({
  exchange,
  rules,
  events,
  soundEnabled,
  onToggleSound,
  onToggleRule,
  onDeleteRule,
  onAddRule,
  onClearEvents,
  onSelectSymbol,
  onClose,
  fieldOptions,
}: {
  exchange: ExchangeId;
  rules: AlertConditionRule[];
  events: TriggeredAlertEvent[];
  soundEnabled: boolean;
  onToggleSound: () => void;
  onToggleRule: (id: string) => void;
  onDeleteRule: (id: string) => void;
  onAddRule: (rule: Omit<AlertConditionRule, "id">) => void;
  onClearEvents: () => void;
  onSelectSymbol: (symbol: string) => void;
  onClose: () => void;
  fieldOptions: readonly FilterFieldOption[];
}) {
  const [name, setName] = useState("");
  const [field, setField] = useState("changePct:5m");
  const [op, setOp] = useState<"gt" | "lt" | "abs_gt">("abs_gt");
  const [value, setValue] = useState("2.5");
  const [sound, setSound] = useState<SoundId>("chime");
  const [cooldownMs, setCooldownMs] = useState(300_000);

  const parsedAlertVal = parseShorthandNumber(value);

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const num = parseShorthandNumber(value);
    if (num === null || !Number.isFinite(num)) return;
    const foundLabel = fieldOptions.find((f) => f.value === field)?.label ?? field;
    const ruleName =
      name.trim() ||
      `${foundLabel} ${op === "abs_gt" ? "|x| >" : op === "gt" ? ">" : "<"} ${formatFilterThreshold(field, num)}`;
    onAddRule({
      name: ruleName,
      field,
      fieldLabel: foundLabel,
      op,
      value: num,
      sound,
      cooldownMs,
      enabled: true,
    });
    setName("");
  };

  return (
    <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[430px] flex-col border-l border-[#1f2430] bg-[#0a0b0e] shadow-2xl">
      <div className="flex items-center justify-between border-b border-[#1a1d26] px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-[#e4e4e7]">Real-Time Market Alerts</span>
          <span className="rounded bg-[#3ee0a1]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[#3ee0a1]">
            {EXCHANGE_LABEL[exchange]}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleSound}
            className={`rounded border px-2 py-1 text-[11px] font-medium ${
              soundEnabled
                ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                : "border-zinc-700 bg-zinc-800/60 text-zinc-400"
            }`}
          >
            {soundEnabled ? "🔊 Audio ON" : "🔇 Audio Muted"}
          </button>
          <button
            onClick={onClose}
            className="rounded p-1 text-lg leading-none text-[#71717a] hover:bg-[#181b24] hover:text-[#e4e4e7]"
          >
            ×
          </button>
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {/* Live Triggered Feed */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
              Triggered Alerts Feed ({events.length})
            </span>
            {events.length > 0 && (
              <button onClick={onClearEvents} className="text-[11px] text-rose-400 hover:text-rose-300">
                Clear History
              </button>
            )}
          </div>
          {events.length === 0 ? (
            <div className="rounded-lg border border-[#181b24] bg-[#0f1118] p-3 text-center text-xs text-zinc-500">
              Listening for live {EXCHANGE_LABEL[exchange]} triggers across active rules...
            </div>
          ) : (
            <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
              {events.map((ev) => (
                <div
                  key={ev.id}
                  onClick={() => onSelectSymbol(ev.symbol)}
                  className="flex cursor-pointer items-center justify-between rounded-md border border-[#1a1f2c] bg-[#10131c] px-2.5 py-2 hover:border-cyan-500/40"
                >
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`inline-block h-2 w-2 rounded-full ${
                          ev.isBullish ? "bg-[#3ee0a1]" : "bg-[#ff6b81]"
                        }`}
                      />
                      <span className="text-xs font-bold text-zinc-100">
                        {toDisplaySymbol(ev.exchange, ev.symbol)}
                      </span>
                      <span className="rounded bg-zinc-800 px-1 py-0.5 text-[9px] text-zinc-400">
                        {EXCHANGE_LABEL[ev.exchange]}
                      </span>
                      <span className="text-[11px] font-medium text-cyan-300">{ev.detail}</span>
                    </div>
                    <div className="mt-0.5 text-[10px] text-zinc-500">{ev.ruleName}</div>
                  </div>
                  <div className="text-right font-mono text-[10px] text-zinc-400">
                    <div>${ev.price}</div>
                    <div>{new Date(ev.ts).toLocaleTimeString()}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Active Alert Rules */}
        <div className="border-t border-[#181b24] pt-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
            Active Scanner Alert Rules
          </div>
          <div className="space-y-1.5">
            {rules.map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between rounded-md border border-[#181b24] bg-[#0f1118] px-2.5 py-2 text-xs"
              >
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    onChange={() => onToggleRule(r.id)}
                    className="h-3.5 w-3.5 accent-[#3ee0a1]"
                  />
                  <div>
                    <div className="font-medium text-zinc-200">{r.name}</div>
                    <div className="text-[10px] text-zinc-500">
                      {r.fieldLabel} {r.op === "abs_gt" ? "|x| >" : r.op === "gt" ? ">" : "<"}{" "}
                      {formatFilterThreshold(r.field, r.value)} • Sound: {r.sound}
                    </div>
                  </div>
                </label>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => playAlertSound(r.sound)}
                    className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:border-zinc-500"
                    title="Preview alert sound"
                  >
                    ♪
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteRule(r.id)}
                    className="text-sm text-zinc-500 hover:text-rose-400"
                    title="Delete rule"
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Create New Alert Rule */}
        <form onSubmit={handleCreate} className="space-y-2.5 border-t border-[#181b24] pt-3 text-xs">
          <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
            <span>+ Create Custom Alert Rule</span>
            {parsedAlertVal !== null && (
              <span className="font-mono text-[10.5px] font-semibold normal-case text-emerald-300">
                = {formatExactFilterValue(field, parsedAlertVal)}
              </span>
            )}
          </div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Alert name (optional, e.g. 5m Momentum Spike)..."
            className="w-full rounded border border-[#1f2430] bg-[#11131a] px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-cyan-500/50"
          />
          <div className="grid grid-cols-3 gap-1.5">
            <select
              value={field}
              onChange={(e) => setField(e.target.value)}
              className="col-span-2 rounded border border-[#1f2430] bg-[#11131a] px-2 py-1.5 text-xs text-zinc-200"
            >
              {renderGroupedFieldOptions(fieldOptions)}
            </select>
            <select
              value={op}
              onChange={(e) => setOp(e.target.value as "gt" | "lt" | "abs_gt")}
              className="rounded border border-[#1f2430] bg-[#11131a] px-2 py-1.5 text-xs text-zinc-200"
            >
              <option value="abs_gt">|x| &gt;</option>
              <option value="gt">&gt; Above</option>
              <option value="lt">&lt; Below</option>
            </select>
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <input
              type="text"
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="e.g. 1k, 50k, 2.5"
              className="rounded border border-[#1f2430] bg-[#11131a] px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-cyan-500/50"
            />
            <div className="flex items-center gap-1">
              <select
                value={sound}
                onChange={(e) => {
                  const s = e.target.value as SoundId;
                  setSound(s);
                  playAlertSound(s);
                }}
                className="w-full rounded border border-[#1f2430] bg-[#11131a] px-2 py-1.5 text-xs text-zinc-200"
              >
                {ALERT_SOUNDS.map((s) => (
                  <option key={s.id} value={s.id}>
                    🔊 {s.label}
                  </option>
                ))}
              </select>
            </div>
            <select
              value={cooldownMs}
              onChange={(e) => setCooldownMs(Number(e.target.value))}
              className="rounded border border-[#1f2430] bg-[#11131a] px-2 py-1.5 text-xs text-zinc-200"
            >
              <option value={60_000}>1m cooldown</option>
              <option value={300_000}>5m cooldown</option>
              <option value={900_000}>15m cooldown</option>
              <option value={3_600_000}>1h cooldown</option>
            </select>
          </div>
          <button
            type="submit"
            disabled={parsedAlertVal === null}
            className="w-full rounded border border-[#3ee0a1]/40 bg-[#3ee0a1]/15 py-2 text-xs font-semibold text-[#3ee0a1] hover:bg-[#3ee0a1]/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            + Add Live Alert Rule
          </button>
        </form>
      </div>
    </div>
  );
}

export interface OrionManualFilterRule {
  id: string;
  field: string;
  op: CompareOp;
  value: number;
  value2?: number;
}

export interface OrionSavedFilterPreset {
  id: string;
  name: string;
  filters: OrionManualFilterRule[];
}

export function OrionFilterModal({
  fieldOptions,
  builderField,
  onChangeBuilderField,
  builderOp,
  onChangeBuilderOp,
  builderValue,
  onChangeBuilderValue,
  builderValue2,
  onChangeBuilderValue2,
  onAddFilter,
  onApplyQuickRule,
  manualFilters,
  onRemoveFilter,
  onEditFilter,
  onClearAllFilters,
  presetThresholds,
  onChangePresetThresholds,
  savedFilterPresets,
  newPresetName,
  onChangeNewPresetName,
  onSavePreset,
  onApplySavedPreset,
  onDeleteSavedPreset,
  previewMatchCount,
  activeMatchCount,
  totalCount,
  onClose,
}: {
  fieldOptions: readonly FilterFieldOption[];
  builderField: string;
  onChangeBuilderField: (field: string) => void;
  builderOp: CompareOp;
  onChangeBuilderOp: (op: CompareOp) => void;
  builderValue: string;
  onChangeBuilderValue: (val: string) => void;
  builderValue2: string;
  onChangeBuilderValue2: (val: string) => void;
  onAddFilter: () => void;
  onApplyQuickRule: (field: string, op: CompareOp, rawValue: string) => void;
  manualFilters: OrionManualFilterRule[];
  onRemoveFilter: (id: string) => void;
  onEditFilter: (rule: OrionManualFilterRule) => void;
  onClearAllFilters: () => void;
  presetThresholds: { highVolume: number; oiSpike: number; bigMovers: number; highFunding: number };
  onChangePresetThresholds: (
    updater: (prev: { highVolume: number; oiSpike: number; bigMovers: number; highFunding: number }) => {
      highVolume: number;
      oiSpike: number;
      bigMovers: number;
      highFunding: number;
    },
  ) => void;
  savedFilterPresets: OrionSavedFilterPreset[];
  newPresetName: string;
  onChangeNewPresetName: (val: string) => void;
  onSavePreset: () => void;
  onApplySavedPreset: (preset: OrionSavedFilterPreset) => void;
  onDeleteSavedPreset: (id: string) => void;
  previewMatchCount: number | null;
  activeMatchCount: number;
  totalCount: number;
  onClose: () => void;
}) {
  const parsedPrimary = parseFilterInput(builderValue);
  const effectiveOp = parsedPrimary?.opOverride ?? builderOp;
  const needsSecondInput = effectiveOp === "between" && parsedPrimary?.value2 === undefined;
  const parsedSecondary =
    effectiveOp === "between"
      ? parsedPrimary?.value2 !== undefined
        ? { value: parsedPrimary.value2 }
        : parseFilterInput(builderValue2)
      : null;

  const isValidDraft =
    parsedPrimary !== null &&
    (effectiveOp !== "between" || (parsedSecondary !== null && Number.isFinite(parsedSecondary.value)));

  const hasInvalidPrimary = builderValue.trim().length > 0 && parsedPrimary === null;
  const hasInvalidSecondary =
    needsSecondInput && builderValue2.trim().length > 0 && parsedSecondary === null;
  const waitingForSecondary =
    needsSecondInput && parsedPrimary !== null && builderValue2.trim().length === 0;

  const isDollarMetric =
    builderField === "mcap" ||
    builderField === "oiUsd" ||
    builderField.startsWith("volume:") ||
    builderField.startsWith("changeUsd:") ||
    builderField.startsWith("oiChangeUsd:") ||
    builderField.startsWith("volChangeUsd:") ||
    builderField.startsWith("cvd:");

  const isTradeMetric = builderField.startsWith("trades:") || builderField === "ticks5m";

  const quickThresholds = isDollarMetric
    ? ["1k", "10k", "50k", "100k", "1m", "10m", "100m"]
    : isTradeMetric
      ? ["50", "100", "500", "1k", "5k", "10k"]
      : ["0.5", "1", "2", "3", "5", "10"];

  const exactParsedBadgeText =
    parsedPrimary !== null
      ? effectiveOp === "between" && parsedSecondary !== null
        ? `= ${formatExactFilterValue(builderField, parsedPrimary.value)} – ${formatExactFilterValue(builderField, parsedSecondary.value)}`
        : `= ${formatExactFilterValue(builderField, parsedPrimary.value)}`
      : null;

  return (
    <div
      data-testid="orion-filter-modal"
      className="mt-2.5 rounded-xl border border-cyan-500/35 bg-[#090b10] p-3.5 shadow-[0_12px_36px_rgba(0,0,0,0.65)]"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-[#181d2a] pb-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold uppercase tracking-wider text-cyan-300">
            ⚡ Manual Metric Filter Builder &amp; Thresholds
          </span>
          <span
            data-testid="modal-filter-match-count"
            className="rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 font-mono text-[11px] font-semibold text-cyan-200"
          >
            Showing {activeMatchCount} / {totalCount} contracts
          </span>
          {previewMatchCount !== null && isValidDraft && parsedPrimary && (
            <span
              data-testid="modal-filter-live-preview"
              className="rounded-md border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 font-mono text-[11px] font-semibold text-emerald-200"
            >
              Live Input Preview:{" "}
              {formatFilterRuleSummary(
                builderField,
                effectiveOp,
                parsedPrimary.value,
                parsedSecondary?.value,
              )}{" "}
              ({exactParsedBadgeText}) → {previewMatchCount} matches
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClearAllFilters}
            className="rounded-md border border-rose-500/40 bg-rose-500/15 px-2.5 py-1 text-xs font-semibold text-rose-200 hover:bg-rose-500/25"
          >
            Clear All Filters
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-700 bg-zinc-800/80 px-2.5 py-1 text-xs font-semibold text-zinc-300 hover:text-white"
          >
            ✕ Close
          </button>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[1.35fr_1fr]">
        {/* Left: Custom Rule Builder */}
        <div className="rounded-lg border border-zinc-800/90 bg-[#0d1018] p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-zinc-200">
            <span>Add Manual Filter (Supports 1k, 50k, 2.5m, 1b, $100k, 5%)</span>
            <div className="flex items-center gap-1.5">
              <input
                value={newPresetName}
                onChange={(e) => onChangeNewPresetName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onSavePreset();
                  }
                }}
                placeholder="Save preset as..."
                className="h-6 w-32 rounded border border-zinc-700 bg-zinc-900 px-2 text-[11px] font-normal text-zinc-200 outline-none focus:border-purple-400"
              />
              <button
                type="button"
                onClick={onSavePreset}
                className="h-6 rounded border border-purple-500/40 bg-purple-500/15 px-2 text-[11px] text-purple-300 hover:bg-purple-500/25"
              >
                Save Preset
              </button>
            </div>
          </div>

          {/* 1-Click Popular Metric Pills */}
          <div className="mb-2.5 flex flex-wrap items-center gap-1">
            <span className="mr-1 text-[10px] font-semibold uppercase text-zinc-500">Metric:</span>
            {(
              [
                { field: "volume:1d", label: "Vol 1d $" },
                { field: "volume:1h", label: "Vol 1h $" },
                { field: "volume:15m", label: "Vol 15m $" },
                { field: "volume:5m", label: "Vol 5m $" },
                { field: "mcap", label: "MCAP $" },
                { field: "oiUsd", label: "OI $" },
                { field: "trades:15m", label: "Trades 15m" },
                { field: "changePct:15m", label: "CHG % 15m" },
                { field: "oiChangePct:15m", label: "OI CHG % 15m" },
                { field: "rvol", label: "RVOL" },
                { field: "price", label: "Price $" },
              ] as const
            ).map((m) => (
              <button
                key={m.field}
                type="button"
                onClick={() => onChangeBuilderField(m.field)}
                className={`rounded border px-2 py-0.5 text-[10.5px] font-semibold transition-colors ${
                  builderField === m.field
                    ? "border-cyan-400/70 bg-cyan-500/20 text-cyan-100"
                    : "border-zinc-800 bg-[#111520] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              onAddFilter();
            }}
            className="flex flex-wrap items-center gap-2 text-xs"
          >
            <select
              data-testid="modal-filter-field"
              value={builderField}
              onChange={(e) => onChangeBuilderField(e.target.value)}
              className="h-8 rounded border border-zinc-700 bg-zinc-900/80 px-2 font-medium text-zinc-100 outline-none focus:border-cyan-500"
            >
              {renderGroupedFieldOptions(fieldOptions)}
            </select>

            <select
              data-testid="modal-filter-op"
              value={builderOp}
              onChange={(e) => onChangeBuilderOp(e.target.value as CompareOp)}
              className="h-8 rounded border border-zinc-700 bg-zinc-900/80 px-2 font-mono font-bold text-cyan-200 outline-none focus:border-cyan-500"
            >
              <option value=">">&gt; (Greater than)</option>
              <option value=">=">&gt;= (At least)</option>
              <option value="<">&lt; (Less than)</option>
              <option value="<=">&lt;= (At most)</option>
              <option value="=">= (Equals)</option>
              <option value="between">Between (Range)</option>
              <option value="abs_gt">|x| &gt; (Abs Move)</option>
            </select>

            <input
              type="text"
              inputMode="decimal"
              data-testid="modal-filter-input"
              value={builderValue}
              onChange={(e) => onChangeBuilderValue(e.target.value)}
              placeholder="e.g. 1k, 50k, 10m, 2.5"
              className="h-8 w-36 rounded border border-zinc-700 bg-zinc-900/90 px-2.5 font-mono text-zinc-100 outline-none placeholder:font-sans placeholder:text-zinc-500 focus:border-cyan-400"
            />

            {needsSecondInput && (
              <>
                <span className="text-zinc-400">and</span>
                <input
                  type="text"
                  inputMode="decimal"
                  data-testid="modal-filter-input-max"
                  value={builderValue2}
                  onChange={(e) => onChangeBuilderValue2(e.target.value)}
                  placeholder="Max (e.g. 100m)"
                  className="h-8 w-32 rounded border border-zinc-700 bg-zinc-900/90 px-2.5 font-mono text-zinc-100 outline-none placeholder:font-sans placeholder:text-zinc-500 focus:border-cyan-400"
                />
              </>
            )}

            {exactParsedBadgeText && (
              <span
                data-testid="modal-filter-parsed-badge"
                className="inline-flex h-8 items-center rounded border border-emerald-500/35 bg-emerald-500/10 px-2 font-mono text-[11px] font-semibold text-emerald-300"
              >
                {exactParsedBadgeText}
              </span>
            )}

            <button
              type="submit"
              data-testid="modal-filter-add"
              disabled={!isValidDraft}
              className="h-8 rounded border border-cyan-500/50 bg-cyan-500/20 px-3.5 font-semibold text-cyan-100 shadow-[0_0_10px_rgba(34,211,238,0.15)] hover:bg-cyan-500/30 disabled:cursor-not-allowed disabled:opacity-40"
            >
              + Add Filter
            </button>
          </form>

          {(hasInvalidPrimary || hasInvalidSecondary || waitingForSecondary) && (
            <div className="mt-2">
              {waitingForSecondary ? (
                <span className="inline-flex items-center rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-200">
                  Min set ({exactParsedBadgeText}) — enter a Max value above (or type a range like 1k - 50k)
                </span>
              ) : (
                <span className="inline-flex items-center rounded border border-rose-500/40 bg-rose-500/15 px-2 py-0.5 text-[11px] text-rose-300">
                  Enter a valid number or shorthand like 1k, 50k, 10m, 2.5
                </span>
              )}
            </div>
          )}

          {/* 1-Click Shorthand Threshold Buttons */}
          <div className="mt-2.5 flex flex-wrap items-center gap-1">
            <span className="mr-1 text-[10px] font-semibold uppercase text-zinc-500">
              Quick {formatFilterFieldLabel(builderField)}:
            </span>
            {quickThresholds.map((presetVal) => {
              const parsed = parseFilterInput(presetVal);
              const quickOp: CompareOp =
                parsed && parsed.value < 0
                  ? builderOp === "<="
                    ? "<="
                    : "<"
                  : builderOp === "between" || builderOp === "="
                    ? ">"
                    : builderOp;
              const isRuleActive =
                parsed !== null &&
                manualFilters.some(
                  (f) =>
                    f.field === builderField &&
                    f.op === quickOp &&
                    Math.abs(f.value - parsed.value) < 1e-9,
                );
              return (
                <button
                  key={presetVal}
                  type="button"
                  onClick={() => onApplyQuickRule(builderField, quickOp, presetVal)}
                  className={`rounded border px-2 py-0.5 font-mono text-[10.5px] font-medium transition-colors ${
                    isRuleActive
                      ? "border-cyan-400/70 bg-cyan-500/25 text-cyan-100"
                      : "border-zinc-800 bg-[#121622] text-cyan-300 hover:border-cyan-500/40 hover:bg-cyan-500/15 hover:text-cyan-100"
                  }`}
                  title={`Toggle filter: ${formatFilterFieldLabel(builderField)} ${quickOp} ${presetVal}`}
                >
                  {quickOp === "abs_gt" ? `|x|>${presetVal.toUpperCase()}` : `${quickOp}${presetVal.toUpperCase()}`}
                </button>
              );
            })}
          </div>

          {/* Active Manual Filter Chips */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-zinc-800/80 pt-2.5 text-xs">
            {manualFilters.map((f) => (
              <div
                key={f.id}
                className="inline-flex items-center gap-1.5 rounded-md border border-cyan-500/40 bg-cyan-500/15 px-2.5 py-1 font-mono text-[11px] font-semibold text-cyan-100"
              >
                <button
                  type="button"
                  onClick={() => onEditFilter(f)}
                  className="hover:underline"
                  title="Click to edit this filter"
                >
                  {formatFilterRuleSummary(f.field, f.op, f.value, f.value2)}
                </button>
                <button
                  type="button"
                  onClick={() => onRemoveFilter(f.id)}
                  className="ml-0.5 text-cyan-300 hover:text-rose-300"
                  title="Remove filter"
                >
                  ✕
                </button>
              </div>
            ))}
            {!manualFilters.length && (
              <span className="text-[11px] text-zinc-500">
                No locked filter chips yet — type any value above (like <code className="text-zinc-300">1k</code> or{" "}
                <code className="text-zinc-300">10m</code>) to filter live or press Enter to pin.
              </span>
            )}
          </div>
        </div>

        {/* Right: Scanner Preset Thresholds & Saved Presets */}
        <div className="flex flex-col justify-between rounded-lg border border-zinc-800/90 bg-[#0d1018] p-3">
          <div>
            <div className="mb-2 flex items-center justify-between text-xs font-semibold text-zinc-200">
              <span>Scanner Preset Thresholds</span>
              <span className="text-[10px] font-normal text-zinc-500">Used by top Scanner buttons</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <label className="self-center text-zinc-400">High Volume (5m RVOL &gt;)</label>
              <input
                type="text"
                inputMode="decimal"
                defaultValue={presetThresholds.highVolume}
                key={`hv-${presetThresholds.highVolume}`}
                onBlur={(e) => {
                  const n = parseShorthandNumber(e.target.value);
                  if (n !== null && n >= 0) {
                    onChangePresetThresholds((p) => ({ ...p, highVolume: n }));
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const n = parseShorthandNumber((e.target as HTMLInputElement).value);
                    if (n !== null && n >= 0) {
                      onChangePresetThresholds((p) => ({ ...p, highVolume: n }));
                    }
                  }
                }}
                className="rounded border border-zinc-700 bg-zinc-900/70 px-2 py-1 font-mono text-zinc-200"
              />
              <label className="self-center text-zinc-400">OI Spike (5m/15m/1h % &gt;)</label>
              <input
                type="text"
                inputMode="decimal"
                defaultValue={presetThresholds.oiSpike}
                key={`oi-${presetThresholds.oiSpike}`}
                onBlur={(e) => {
                  const n = parseShorthandNumber(e.target.value);
                  if (n !== null && n >= 0) {
                    onChangePresetThresholds((p) => ({ ...p, oiSpike: n }));
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const n = parseShorthandNumber((e.target as HTMLInputElement).value);
                    if (n !== null && n >= 0) {
                      onChangePresetThresholds((p) => ({ ...p, oiSpike: n }));
                    }
                  }
                }}
                className="rounded border border-zinc-700 bg-zinc-900/70 px-2 py-1 font-mono text-zinc-200"
              />
              <label className="self-center text-zinc-400">Big Movers (|5m/15m/1h %| &gt;)</label>
              <input
                type="text"
                inputMode="decimal"
                defaultValue={presetThresholds.bigMovers}
                key={`bm-${presetThresholds.bigMovers}`}
                onBlur={(e) => {
                  const n = parseShorthandNumber(e.target.value);
                  if (n !== null && n >= 0) {
                    onChangePresetThresholds((p) => ({ ...p, bigMovers: n }));
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const n = parseShorthandNumber((e.target as HTMLInputElement).value);
                    if (n !== null && n >= 0) {
                      onChangePresetThresholds((p) => ({ ...p, bigMovers: n }));
                    }
                  }
                }}
                className="rounded border border-zinc-700 bg-zinc-900/70 px-2 py-1 font-mono text-zinc-200"
              />
              <label className="self-center text-zinc-400">High Funding (|%| &gt;)</label>
              <input
                type="text"
                inputMode="decimal"
                defaultValue={presetThresholds.highFunding}
                key={`hf-${presetThresholds.highFunding}`}
                onBlur={(e) => {
                  const n = parseShorthandNumber(e.target.value);
                  if (n !== null && n >= 0) {
                    onChangePresetThresholds((p) => ({ ...p, highFunding: n }));
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const n = parseShorthandNumber((e.target as HTMLInputElement).value);
                    if (n !== null && n >= 0) {
                      onChangePresetThresholds((p) => ({ ...p, highFunding: n }));
                    }
                  }
                }}
                className="rounded border border-zinc-700 bg-zinc-900/70 px-2 py-1 font-mono text-zinc-200"
              />
            </div>
          </div>

          {savedFilterPresets.length > 0 && (
            <div className="mt-3 border-t border-zinc-800/80 pt-2.5">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                Saved Custom Presets
              </div>
              <div className="flex flex-wrap gap-1.5">
                {savedFilterPresets.map((sp) => (
                  <div
                    key={sp.id}
                    className="inline-flex h-6 items-center rounded-md border border-purple-500/40 bg-purple-500/10"
                  >
                    <button
                      type="button"
                      onClick={() => onApplySavedPreset(sp)}
                      className="px-2 text-[11px] font-medium text-purple-200 hover:text-white"
                    >
                      ★ {sp.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteSavedPreset(sp.id)}
                      className="pr-1.5 text-[11px] text-purple-400 hover:text-rose-300"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


