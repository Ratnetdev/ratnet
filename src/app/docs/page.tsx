export const metadata = { title: "Docs · RATNET" };

const TOKENOMICS = [
  { k: "Public", v: 80, c: "var(--rat)", d: "Fair launch on pump.fun" },
  { k: "Team", v: 8, c: "var(--watch)", d: "Locked 6 months" },
  { k: "Marketing", v: 7, c: "var(--bond)", d: "Listings, KOLs, campaigns" },
  { k: "Airdrop", v: 5, c: "var(--dust)", d: "First rat owners and early sniff users" },
];

export default function Docs() {
  return (
    <div className="doc">
      <section className="hero" style={{ paddingTop: 6 }}>
        <h1 style={{ fontSize: "clamp(36px,6vw,64px)" }}>DOCS</h1>
        <p>Pretraining the first model raised in the trenches. From scratch. On nothing but what its rats dig up.</p>
      </section>

      <h2>What RATNET is</h2>
      <p>
        RATNET is a network of rats that dig every new pump.fun launch, a dataset that grows by over 10K rows a day, and a model, the <b>Rat King</b>, that is being raised on that data from scratch. Holders own the rats. The rats feed the King. The King gets judged in public, every single call.
      </p>
      <p>
        Most AI tokens give you a chatbot and ask you to judge it on vibes. The Rat King has one job you can check: <b>score every new launch 0 to 100 on whether it will bond</b>. Every call is logged and checked against the chain automatically, so its hit rate is a number, not an opinion.
      </p>

      <h2>The rats</h2>
      <h3>What a rat does</h3>
      <ul>
        <li>Digs each new pump.fun launch the moment it is created: name, ticker, description, socials, creator, dev buy, bonding curve at birth.</li>
        <li>Comes back at 5 minutes, 1 hour and 24 hours to sniff the curve again.</li>
        <li>Records the outcome: <b>BONDED</b> (curve completed), <b>ALIVE</b> or <b>DIED</b> (under 5% curve at 24h).</li>
      </ul>
      <h3>Spawning</h3>
      <ul>
        <li>Burn <b>100,000 $RAT</b> to spawn one rat. The burn is verified on chain and the tokens are gone for good.</li>
        <li>Rats come in <b>weekly litters</b>. Litter 1 is 100 rats. When a litter sells out, burns queue for the next one.</li>
        <li>Work is handed out round-robin to every live rat. Each dig and each checkpoint counts as one unit of work.</li>
      </ul>
      <h3>Earning</h3>
      <ul>
        <li>Fees are split <b>60% compute</b> (digging, training, calls) and <b>40% rat owners</b>, paid every 12 hours.</li>
        <li>A rat must do <b>50+ digs</b> in a round to earn that round.</li>
        <li>Share = digs × bag multiplier. Bag is the owner&apos;s $RAT divided by rats owned.</li>
        <li>Per-rat bag 100K → 1x, 500K → 1.25x, 1M → 1.5x, 2.5M → 2x.</li>
        <li>Below 100K $RAT per rat, a rat&apos;s lifetime earnings cap at <b>2x its spawn cost</b>. Hold 100K+ per rat and the cap is gone.</li>
        <li>Every round and every transfer is on the <a href="/ledger">ledger</a> with a Solscan link.</li>
      </ul>

      <h2>Sniff orders</h2>
      <ul>
        <li>Burn <b>10,000 $RAT</b> to point the rats at any CA. The Rat King returns a score, a verdict and a short report on why.</li>
        <li>Sniffs are public on the <a href="/sniff">sniff board</a>. Every sniff burns supply.</li>
      </ul>

      <h2>The Rat King</h2>
      <h3>v0 · live now</h3>
      <p>
        A transparent baseline scorer. Every weight is published on the <a href="/king">King page</a>. It calls each launch 5 minutes after birth: <b>BOND</b> at 60+, <b>WATCH</b> at 30 to 59, <b>DUST</b> below 30. Calls made later than 15 minutes after birth are marked late and never count toward the hit rate. Misses stay on the board.
      </p>
      <h3>v1 · training</h3>
      <p>
        Pretrained from scratch on the dug dataset. No borrowed base model. Public loss curve, hit rate per version, and the <b>weights published on Hugging Face after the first epoch</b>. v1 runs next to v0 so everyone can see whether it actually wins.
      </p>

      <h2>Tokenomics</h2>
      <p>$RAT · Solana · 1,000,000,000 supply.</p>
      <div style={{ display: "flex", height: 18, border: "1px solid var(--line2)", maxWidth: 760, margin: "14px 0" }}>
        {TOKENOMICS.map((t) => (
          <div key={t.k} style={{ width: `${t.v}%`, background: t.c, opacity: 0.85 }} title={`${t.k} ${t.v}%`} />
        ))}
      </div>
      <div className="scroll" style={{ maxWidth: 760 }}>
        <table className="tbl">
          <thead>
            <tr><th>Allocation</th><th>Share</th><th>Tokens</th><th>Notes</th></tr>
          </thead>
          <tbody>
            {TOKENOMICS.map((t) => (
              <tr key={t.k}>
                <td><span style={{ display: "inline-block", width: 10, height: 10, background: t.c, marginRight: 8 }} />{t.k}</td>
                <td>{t.v}%</td>
                <td>{(t.v * 10_000_000).toLocaleString("en-US")}</td>
                <td className="muted">{t.d}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Sinks</h3>
      <ul>
        <li>Spawning burns 100K $RAT per rat.</li>
        <li>Sniff orders burn 10K $RAT per sniff.</li>
        <li>Weekly litters keep the spawn sink running every week.</li>
      </ul>

      <h2>Roadmap</h2>
      <h3><span className="pill">live</span> Launch day</h3>
      <ul>
        <li>Live rat feed reading every new pump.fun launch.</li>
        <li>Rat King v0 calls with the hit rate tracked from hour one.</li>
        <li>Litter 1 spawning, sniff orders, payout ledger, public dataset counter.</li>
      </ul>
      <h3><span className="pill soon">next</span> Rat King v1</h3>
      <ul>
        <li>First from-scratch pretraining run on the dug dataset, public loss curve.</li>
        <li>Weights and dataset on Hugging Face after the first epoch.</li>
        <li>Litters 2 and 3, weekly.</li>
      </ul>
      <h3><span className="pill soon">next</span> The King speaks up</h3>
      <ul>
        <li>Telegram and X bot that posts the King&apos;s calls in real time.</li>
        <li>Rat King v2 with first-hour trade flow, hit rate per version.</li>
      </ul>
      <h3><span className="pill">graduation</span> The King talks</h3>
      <ul>
        <li>Chat with the Rat King about any coin, in trench voice, backed by everything the rats ever dug.</li>
      </ul>

      <h2>Links</h2>
      <ul>
        <li><a href="/king">Rat King calls</a> · <a href="/rats">Rats</a> · <a href="/sniff">Sniff</a> · <a href="/ledger">Ledger</a> · <a href="/dataset">Dataset</a></li>
      </ul>
    </div>
  );
}
