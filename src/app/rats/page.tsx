import RatsBoard from "@/components/RatsBoard";
import { RatsMoney } from "@/components/Money";

export const metadata = { title: "Rats · RATNET" };

export default function RatsPage() {
  return (
    <>
      <section className="hero" style={{ paddingTop: 6 }}>
        <div className="prompt">~/ratnet ❯ <span>rats spawn --name &lt;you&gt;</span></div>
        <h1 style={{ fontSize: "clamp(36px,6vw,64px)" }}>SPAWN A RAT</h1>
        <p>Burn $RAT to spawn a rat. Your rat digs pump.fun launches around the clock and earns its share of 40% of fees every 12 hours.</p>
      </section>
      <RatsBoard />
      <RatsMoney />
    </>
  );
}
