import SniffBoard from "@/components/SniffBoard";

export const metadata = { title: "Sniff · RATNET" };

export default function SniffPage() {
  return (
    <>
      <section className="hero" style={{ paddingTop: 6 }}>
        <div className="prompt">~/ratnet ❯ <span>sniff &lt;ca&gt;</span></div>
        <h1 style={{ fontSize: "clamp(36px,6vw,64px)" }}>SNIFF ORDERS</h1>
        <p>Point the rats at any coin. Burn $RAT and the Rat King scores the CA 0 to 100 on will it bond, with a short report on why. Every sniff burns supply.</p>
      </section>
      <SniffBoard />
    </>
  );
}
