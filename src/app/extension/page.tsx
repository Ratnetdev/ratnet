import { SITE } from "@/config/site";

export const metadata = { title: "Extension · RATNET", description: "The Rat King's read on every Solana coin you open: pump.fun, Axiom, GMGN, Photon, BullX, Padre and DexScreener." };

const SITES = ["pump.fun", "Axiom", "GMGN", "Photon", "BullX Neo", "Padre", "DexScreener"];

export default function ExtensionPage() {
  return (
    <div className="doc">
      <section className="hero" style={{ paddingTop: 6 }}>
        <div className="prompt">~/ratnet ❯ <span>install king</span></div>
        <h1 style={{ fontSize: "clamp(36px,6vw,64px)" }}>THE KING IN YOUR BROWSER</h1>
        <p>Open any coin and the Rat King&apos;s read sits in the corner: the bond score, who is really buying (FOMO traders, wallets with a real winning record, proven wallets, bots, wallets that buy before KOL callouts), copies of earlier coins and the red flags. One click to ask the King about it.</p>
        <div className="row mt" style={{ gap: 12 }}>
          <a className="btn" href="/ratnet-extension.zip" download>Download for Chrome</a>
          <a className="btn ghost" href="/sniff">Try a check first</a>
        </div>
      </section>
      <h2>Works on</h2>
      <p>{SITES.join(" · ")}. On terminals that put the pair in the address bar, the rats find the coin&apos;s mint on the page. Anywhere else: select a contract address, right click, <b>Check with the Rat King</b>. Or click the rat in your toolbar and paste one.</p>
      <h2>Install (2 minutes)</h2>
      <ol className="small">
        <li>Download the zip and unzip it. You get a folder with <code>manifest.json</code> inside.</li>
        <li>Open <code>chrome://extensions</code> and switch on <b>Developer mode</b> (top right).</li>
        <li>Click <b>Load unpacked</b> and pick the unzipped folder.</li>
        <li>Pin the rat in your toolbar. Open a coin on pump.fun to see it work.</li>
      </ol>
      <p className="small muted">Works in Chrome, Brave, Edge and Arc. The Chrome Web Store listing is on its way; the store version updates by itself.</p>
      <h2>What it can see</h2>
      <p className="small">Nothing but the coin address on the page you are on. It never touches your wallet, never asks to sign anything and only talks to {SITE.url.replace(/^https?:\/\//, "")}. The code is public on GitHub.</p>
      <p className="tiny muted">Free while $RAT is not launched. After launch the King&apos;s checks are sniff orders that burn $RAT. Not financial advice.</p>
    </div>
  );
}
