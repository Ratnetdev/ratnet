import DeskBoard from "@/components/DeskBoard";

export const metadata = { title: "Desk · RATNET" };

export default function DeskPage() {
  return (
    <>
      <section className="hero" style={{ paddingTop: 6, paddingBottom: 18 }}>
        <div className="prompt">~/ratnet ❯ <span>desk status --live</span></div>
        <h1 style={{ fontSize: "clamp(36px,6vw,64px)" }}>THE DESK</h1>
        <p>Thirteen rats turn the King&apos;s calls into trades and learn from every one. Every decision, every fill, every exit and every lesson, live.</p>
      </section>
      <DeskBoard />
    </>
  );
}
