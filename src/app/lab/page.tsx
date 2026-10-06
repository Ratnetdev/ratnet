import LabBoard from "@/components/LabBoard";

export const metadata = { title: "Lab · RATNET" };

export default function LabPage() {
  return (
    <>
      <section className="hero" style={{ paddingTop: 6 }}>
        <h1 style={{ fontSize: "clamp(36px,6vw,64px)" }}>THE LAB</h1>
        <p>Rat King nano is learning from scratch, live, on nothing but what the rats dig up. Every outcome is a lesson. The loss curve and every weight are public.</p>
      </section>
      <LabBoard />
    </>
  );
}
