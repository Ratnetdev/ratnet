import RadarBoard from "@/components/RadarBoard";

export const metadata = { title: "Radar · RATNET" };

export default function RadarPage() {
  return (
    <>
      <section className="hero" style={{ paddingTop: 6 }}>
        <h1 style={{ fontSize: "clamp(36px,6vw,64px)" }}>THE RADAR</h1>
        <p>Every launch the rats dug whose bonding curve is filling right now, sorted by how close it is to graduating. The Rat King&apos;s call and the dev&apos;s history sit next to each one.</p>
      </section>
      <RadarBoard />
      <p className="tiny muted mt">Not financial advice. The Rat King is a model in training and is often wrong; its full record is public on the King page.</p>
    </>
  );
}
