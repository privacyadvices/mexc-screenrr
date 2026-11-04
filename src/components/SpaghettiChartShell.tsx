"use client";

import dynamic from "next/dynamic";
import type { ExchangeId } from "@/lib/exchange";

const SpaghettiNoSSR = dynamic(() => import("@/components/SpaghettiChartPage"), {
  ssr: false,
  loading: () => (
    <div className="min-h-screen bg-[#08090d] text-zinc-400 flex items-center justify-center">
      Loading spaghetti page...
    </div>
  ),
});

export default function SpaghettiChartShell({ mode, exchange = "mexc" }: { mode: "price" | "volume"; exchange?: ExchangeId }) {
  return <SpaghettiNoSSR mode={mode} exchange={exchange} />;
}
