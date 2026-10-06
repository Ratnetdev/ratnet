export const metadata = { title: "API · RATNET" };

const EPS: [string, string, string][] = [
  ["GET", "/api/live", "Stats, the live feed, latest calls, radar and graduations in one call. Cached 3s."],
  ["GET", "/api/radar", "Up to 50 live launches whose curve is filling, sorted by curve %, with the King's call and dev history."],
  ["GET", "/api/king?page=0", "Latest Rat King calls, 60 per page, plus hit rates for v0 and nano. Add &verdict=BOND to filter."],
  ["GET", "/api/graduations", "The last 100 launches that bonded, time to bond, and what the King said at 5 minutes."],
  ["GET", "/api/coin/{CA}", "Everything the rats dug on one launch: metadata, dev history, checkpoints, call, outcome."],
  ["GET", "/api/king/weights", "Rat King nano's live weights, sample count and loss log. Run it yourself: p = sigmoid(Σ w·x)."],
  ["GET", "/api/ledger", "Payout rounds, burns and the public dataset drops."],
  ["GET", "/api/og/{CA}", "1200×630 share card for a call. Use it as an image in bots and posts."],
];

export default function Developers() {
  return (
    <div className="doc">
      <section className="hero" style={{ paddingTop: 6 }}>
        <h1 style={{ fontSize: "clamp(36px,6vw,64px)" }}>BUILD ON THE RATS</h1>
        <p>Everything the rats dig and everything the King says is open. Free JSON, no key, built for bots, dashboards and sniping tools. Please cache on your side and keep it under one request per second.</p>
      </section>
      <div className="panel">
        <div className="scroll">
          <table className="tbl">
            <thead><tr><th>Method</th><th>Endpoint</th><th>Returns</th></tr></thead>
            <tbody>
              {EPS.map(([m, p, d]) => (
                <tr key={p}>
                  <td className="green">{m}</td>
                  <td><a href={p.replace("{CA}", "").replace("?page=0", "")} target="_blank" rel="noreferrer">{p}</a></td>
                  <td className="muted" style={{ whiteSpace: "normal" }}>{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <h2>Example: a BOND call bot</h2>
      <pre className="panel pb small" style={{ overflowX: "auto", margin: 0 }}>{`const seen = new Set();
setInterval(async () => {
  const { calls } = await (await fetch("https://ratnet.fun/api/king?verdict=BOND")).json();
  for (const c of calls) {
    if (seen.has(c.mint) || !c.counted) continue;
    seen.add(c.mint);
    post(\`Rat King: $\${c.symbol} BOND \${c.score}/100 https://ratnet.fun/c/\${c.mint}\`);
  }
}, 15_000);`}</pre>
      <h2>Dataset</h2>
      <p>Daily JSONL drops of every resolved launch live on the <a href="/dataset">dataset page</a>, one row per launch with the features the King saw and the outcome the chain decided. Use them to train your own model and try to beat ours.</p>
      <p className="tiny muted">The source is public on GitHub. Nothing here is financial advice.</p>
    </div>
  );
}
