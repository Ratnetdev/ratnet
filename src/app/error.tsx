"use client";
// One page failing must never blank the whole site: the header, menu and the other pages keep working, and the page
// offers a retry. (Before v0.1.27 any render error showed Next's bare "Application error" screen.)
import { useEffect } from "react";

export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("page error", error);
  }, [error]);
  return (
    <main className="wrap" style={{ padding: "64px 0", minHeight: "50vh" }}>
      <div className="panel">
        <div className="ph"><span><b>this page hit an error</b></span></div>
        <div className="pb" style={{ display: "grid", gap: 14 }}>
          <p className="muted" style={{ margin: 0 }}>The rats keep digging, only this view failed to draw. Try again, or open another page from the menu.</p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn" onClick={() => reset()}>try again</button>
            <a className="btn" href="/status">system status</a>
          </div>
        </div>
      </div>
    </main>
  );
}
