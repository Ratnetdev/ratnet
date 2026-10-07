import StatusBoard from "@/components/StatusBoard";
import AlivePanel from "@/components/AlivePanel";

export const metadata = { title: "Status · RATNET" };

export default function StatusPage() {
  return (
    <>
      <section className="hero" style={{ paddingTop: 6 }}>
        <div className="prompt">~/ratnet ❯ <span>status --all</span></div>
        <h1 style={{ fontSize: "clamp(36px,6vw,64px)" }}>STATUS</h1>
        <p>Every part of the protocol, live: what is running, how fast it reacts, how much it has learned and whether anything is stuck.</p>
      </section>
      <StatusBoard />
      <div className="mt">
        <AlivePanel />
      </div>
    </>
  );
}
