"use client";
// Last line of defence: an error in the layout itself (header, live feed, alerts). Plain HTML, no app styles needed.
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", background: "#060807", color: "#c8d3cc", fontFamily: "ui-monospace, Menlo, monospace" }}>
        <div style={{ textAlign: "center", padding: 24 }}>
          <div style={{ color: "#8cff5a", letterSpacing: 6, fontSize: 22 }}>RATNET</div>
          <p style={{ margin: "18px 0" }}>The page failed to load. The protocol keeps running.</p>
          <button onClick={() => reset()} style={{ background: "transparent", color: "#8cff5a", border: "1px solid #8cff5a", padding: "10px 18px", font: "inherit", cursor: "pointer" }}>reload</button>
        </div>
      </body>
    </html>
  );
}
