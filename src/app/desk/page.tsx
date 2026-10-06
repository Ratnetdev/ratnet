import DeskBoard from "@/components/DeskBoard";

export const metadata = { title: "Desk · RATNET" };

export default function DeskPage() {
  return (
    <>
      <section className="hero" style={{ paddingTop: 6, paddingBottom: 18 }}>
        <h1 style={{ fontSize: "clamp(36px,6vw,64px)" }}>THE DESK</h1>
        <p>Eight rats turn the King&apos;s calls into trades. Every decision, every fill and every exit, live.</p>
      </section>
      <DeskBoard />
    </>
  );
}
