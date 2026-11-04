"use client";

import dynamic from "next/dynamic";

const PerformersNoSSR = dynamic(() => import("@/components/PerformersPage"), {
  ssr: false,
  loading: () => (
    <div className="min-h-screen bg-[#08090d] text-zinc-400 flex items-center justify-center">
      Loading performers...
    </div>
  ),
});

export default function PerformersShell() {
  return <PerformersNoSSR />;
}