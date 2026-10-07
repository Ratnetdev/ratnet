import Link from "next/link";
import LiveBoard from "@/components/LiveBoard";
import { RatCamHero } from "@/components/RatCam";
import HeroProof from "@/components/HeroProof";
import DeskStatus from "@/components/DeskStatus";
import { BurnStrip, RatSection } from "@/components/RatEconomy";
import TrackRecord from "@/components/TrackRecord";
import HallOfFame from "@/components/HallOfFame";

export default function Home() {
  return (
    <>
      <section className="hero-split">
        <div className="hero">
          <div className="prompt">
            root@ratnet:~$ <span>./dig --source pump.fun --forever</span>
            <span className="caret" />
          </div>
          <h1>
            THE MODEL RAISED
            <br />
            IN THE TRENCHES
          </h1>
          <p>Rats dig every new pump.fun coin. At minute 5 the Rat King calls it. The chain proves it right or wrong, in public.</p>
          <DeskStatus />
          <HeroProof />
          <div className="row wrapx mt" style={{ gap: 10 }}>
            <Link href="/radar" className="btn">Open the radar</Link>
            <Link href="/explore?king=B&sort=king" className="btn dim">Every BOND call</Link>
          </div>
        </div>
        <RatCamHero />
      </section>

      <BurnStrip />

      <LiveBoard />

      <TrackRecord compact />
      <HallOfFame />

      <RatSection />
    </>
  );
}
