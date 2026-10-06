import Explorer from "@/components/Explorer";

export const metadata = { title: "Explore · RATNET" };

export default function ExplorePage() {
  return (
    <>
      <section className="hero" style={{ paddingTop: 6 }}>
        <div className="prompt">~/ratnet ❯ <span>explore --last 24h</span></div>
        <h1 style={{ fontSize: "clamp(36px,6vw,64px)" }}>EXPLORE THE DIG</h1>
        <p>Every coin the King and nano liked, filterable by what they predicted, what happened, the dev&apos;s record and the socials. The numbers above the table tell you how often your filter actually bonded.</p>
      </section>
      <Explorer />
    </>
  );
}
