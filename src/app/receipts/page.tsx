import Receipts from "@/components/Receipts";

export const metadata = { title: "Receipts · RATNET", description: "Every Rat King call, sealed on-chain every hour before the outcome is known." };

export default function ReceiptsPage() {
  return (
    <>
      <section className="hero" style={{ paddingTop: 6 }}>
        <div className="prompt">~/ratnet ❯ <span>receipts --verify</span></div>
        <h1 style={{ fontSize: "clamp(36px,6vw,64px)" }}>RECEIPTS</h1>
        <p>Every counted Rat King call goes into an hourly list. When the hour ends, the SHA-256 of that list is written on-chain in a memo. Hash the list yourself and compare it with the memo: no call can be added, changed or deleted once the outcome is known.</p>
      </section>
      <Receipts />
    </>
  );
}
