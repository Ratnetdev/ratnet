import LedgerBoard from "@/components/LedgerBoard";
import { LedgerFlow } from "@/components/Money";

export const metadata = { title: "Ledger · RATNET" };

export default function LedgerPage() {
  return (
    <>
      <section className="hero" style={{ paddingTop: 6 }}>
        <div className="prompt">~/ratnet ❯ <span>ledger --flow</span></div>
        <h1 style={{ fontSize: "clamp(36px,6vw,64px)" }}>THE LEDGER</h1>
        <p>Every burn, every round, every payout. Fees split 60% to compute and 40% to rat owners every 12 hours, with a Solscan link on each line.</p>
      </section>
      <LedgerFlow />
      <div className="mt" />
      <LedgerBoard />
    </>
  );
}
