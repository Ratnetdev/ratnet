import DeskBoard from "@/components/DeskBoard";

export const metadata = { title: "Desk · RATNET" };

export default function DeskPage() {
  return (
    <>
      <section className="hero" style={{ paddingTop: 6, paddingBottom: 18 }}>
        <div className="prompt">~/ratnet ❯ <span>desk status --live</span></div>
        <h1 style={{ fontSize: "clamp(36px,6vw,64px)" }}>THE DESK</h1>
        <p>Twenty-three rats turn the King&apos;s calls, the posts that move coins, the wallets that matter and the runners into trades, share one board per coin, split capital across strategies, then go back over every decision to see what they got wrong. Every decision, every fill, every exit and every lesson, live.</p>
      </section>
      <DeskBoard />
    </>
  );
}
