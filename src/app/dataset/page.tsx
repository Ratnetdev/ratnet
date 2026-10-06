import DatasetBoard from "@/components/DatasetBoard";

export const metadata = { title: "Dataset · RATNET" };

export default function DatasetPage() {
  return (
    <>
      <section className="hero" style={{ paddingTop: 6 }}>
        <div className="prompt">~/ratnet ❯ <span>dataset ls --daily</span></div>
        <h1 style={{ fontSize: "clamp(36px,6vw,64px)" }}>THE DATASET</h1>
        <p>Data that never runs out. Over 10K pump.fun launches a day, every one dug, checkpointed and labelled by the chain itself. This is what the Rat King is raised on, and it is free to read.</p>
      </section>
      <DatasetBoard />
    </>
  );
}
