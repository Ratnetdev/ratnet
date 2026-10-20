import SniffBoard from "@/components/SniffBoard";

export const metadata = { title: "Sniff · RATNET" };

export default function SniffPage() {
  return (
    <>
      <section className="hero" style={{ paddingTop: 6 }}>
        <div className="prompt">~/ratnet ❯ <span>sniff &lt;ca&gt;</span></div>
        <h1 style={{ fontSize: "clamp(36px,6vw,64px)" }}>SNIFF ORDERS</h1>
        <p>Point the rats at any coin. The Rat King scores it 0 to 100 on will it bond, and the rats show who is really buying: FOMO traders, wallets with a real winning record, proven wallets, bots and wallets that buy before KOL callouts. Then ask the King anything about it. After launch every sniff burns $RAT.</p>
        <p className="small muted">Also in Telegram (<code>/check CA</code>) and in Claude or Cursor as an MCP server: <a href="/developers#mcp">how to add it</a>.</p>
      </section>
      <SniffBoard />
    </>
  );
}
