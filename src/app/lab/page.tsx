import LabBoard from "@/components/LabBoard";
import { ScoreChart } from "@/components/Proof";
import { Ladder } from "@/components/Runners";
import History from "@/components/History";

export const metadata = { title: "Lab · RATNET" };

export default function LabPage() {
  return (
    <>
      <section className="hero" style={{ paddingTop: 6 }}>
        <div className="prompt">~/ratnet ❯ <span>lab status --learn</span></div>
        <h1 style={{ fontSize: "clamp(36px,6vw,64px)" }}>THE LAB</h1>
        <p>Rat King nano is learning from scratch, live, on nothing but what the rats dig up. Every outcome is a lesson. The loss curve and an honest scoreboard are public.</p>
      </section>
      <History />
      <div className="mt">
        <LabBoard />
      </div>
      <section className="grid g2 mt">
        <ScoreChart />
        <Ladder />
      </section>
    </>
  );
}
