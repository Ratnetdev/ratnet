import KingBoard from "@/components/KingBoard";
import { HourlyChart, ScoreChart } from "@/components/Proof";
import Runners from "@/components/Runners";

export const metadata = { title: "Rat King · RATNET" };

export default function KingPage() {
  return (
    <>
      <section className="hero" style={{ paddingTop: 6 }}>
        <h1 style={{ fontSize: "clamp(36px,6vw,64px)" }}>THE RAT KING</h1>
        <p>One question, asked of every pump.fun launch: will it bond? Every call is logged and checked against the chain. The hit rate is whatever the chain says it is.</p>
      </section>
      <KingBoard />
      <div className="mt" id="runners" style={{ scrollMarginTop: 120 }}>
        <Runners limit={20} />
      </div>
      <section className="grid g2 mt">
        <ScoreChart />
        <HourlyChart />
      </section>
    </>
  );
}
