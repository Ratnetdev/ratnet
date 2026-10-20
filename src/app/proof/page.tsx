import ProofBoard from "@/components/ProofBoard";

export const metadata = { title: "Proof · RATNET", description: "The RATNET desk against its own paper twin, trade by trade: the real gap, the fill speed, and the Rat King's record graded by the chain." };

export default function ProofPage() {
  return (
    <>
      <section className="hero" style={{ paddingTop: 6 }}>
        <div className="prompt">~/ratnet ❯ <span>proof --live</span></div>
        <h1 style={{ fontSize: "clamp(36px,6vw,64px)" }}>PROOF</h1>
        <p>The desk signs its own trades, no human in the loop. Every live trade is paired with the paper trade of the strategy it followed, on the same coin, and the difference is published. Every buy is timed from the signal to the fill. Nothing here is edited by hand and nothing gets deleted.</p>
      </section>
      <ProofBoard />
    </>
  );
}
