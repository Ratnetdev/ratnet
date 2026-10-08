import Link from "next/link";

export const metadata = { title: "Not found · RATNET" };

// A wrong link gets the site's own page with a way back (it used to be Next's plain "404: This page could not be found").
export default function NotFound() {
  return (
    <section className="hero" style={{ paddingTop: 24, paddingBottom: 48 }}>
      <div className="prompt">~/ratnet ❯ <span>cd {"<"}unknown{">"}</span></div>
      <h1 style={{ fontSize: "clamp(36px,6vw,64px)" }}>NOTHING DUG HERE</h1>
      <p>This page does not exist. The rats only dig where there is something to find.</p>
      <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
        <Link className="btn" href="/">back to the feed</Link>
        <Link className="btn dim" href="/radar">open the radar</Link>
        <Link className="btn dim" href="/desk">the desk</Link>
      </div>
    </section>
  );
}
