"use client";

import dynamic from "next/dynamic";

const WatchlistNoSSR = dynamic(() => import("@/components/WatchlistPage"), {
  ssr: false,
  loading: () => (
    <div className="min-h-screen bg-[#08090d] text-zinc-400 flex items-center justify-center">
      Loading watchlist...
    </div>
  ),
});

export default function WatchlistShell() {
  return <WatchlistNoSSR />;
}
