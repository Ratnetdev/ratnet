import type { Metadata } from "next";
import CoinView from "@/components/CoinView";
import { getCoin } from "@/lib/stats";
import { isPubkey } from "@/lib/solana";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { mint: string } }): Promise<Metadata> {
  let title = "Coin · RATNET";
  let desc = "The Rat King's call on this launch.";
  try {
    if (isPubkey(params.mint)) {
      const { launch, call } = await getCoin(params.mint);
      const sym = call?.symbol || launch?.symbol;
      if (sym) title = `$${sym} · Rat King ${call ? `${call.verdict} ${call.score}` : "watching"}`;
      if (call) desc = `Called ${call.verdict} ${call.score}/100 five minutes after launch.${call.outcome ? ` Outcome: ${call.outcome}.` : ""}`;
    }
  } catch {}
  const img = `/api/og/${params.mint}`;
  return { title, description: desc, openGraph: { title, description: desc, images: [img] }, twitter: { card: "summary_large_image", title, description: desc, images: [img] } };
}

export default function CoinPage({ params }: { params: { mint: string } }) {
  return <CoinView mint={params.mint} />;
}
