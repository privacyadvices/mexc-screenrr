"use client";

import dynamic from "next/dynamic";
import type { ExchangeId } from "@/lib/exchange";

const ScreenerNoSSR = dynamic(() => import("@/components/Screener"), {
  ssr: false,
  loading: () => (
    <div className="min-h-screen bg-[#08090d] text-zinc-400 flex items-center justify-center">
      Loading screener...
    </div>
  ),
});

export default function ScreenerShell({ exchange = "mexc" }: { exchange?: ExchangeId }) {
  return <ScreenerNoSSR exchange={exchange} />;
}
