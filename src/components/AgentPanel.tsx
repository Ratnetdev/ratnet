"use client";
import Link from "next/link";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { usePoll } from "./usePoll";
import { ago } from "./fmt";

type Ev = { agent: string; at: number; text: string; tone: string; mint?: string; symbol?: string };
type Agent = { name: string; last: Ev | null; total: number; today: number; tones: Record<string, number>; history: Ev[] };

const TONE: Record<string, string> = { ok: "var(--rat)", bad: "var(--dust)", info: "var(--dim)", win: "var(--bond)", loss: "var(--dust)" };

// What each agent is, in plain words, and the rules it works by.
export const PROFILE: Record<string, { what: string; how: string[] }> = {
  HISTORIAN: {
    what: "Replays past pump.fun launches, newest first and then back in time, so the models don't start from zero.",
    how: ["Goes back 30 days from today", "Scores each past launch before learning from it: an honest backtest", "Older lessons count for less (21-day half-life), because the market changes", "Hides anything that wasn't known at the time, so it never learns from the future"],
  },
  SCOUT: {
    what: "Reads every new pump.fun launch the second it's created, and makes the first read at minute 1.",
    how: ["Records the dev, the dev's past launches and graduations, the dev buy and the socials", "Minute 1: the early model scores the launch (shadow only until it proves itself)", "Sends moving coins to TAPE and GRAPH for a deeper read"],
  },
  KING: {
    what: "The Rat King. Scores every launch 0 to 100 at minute 5 on one question: will it bond.",
    how: ["BOND 60+, WATCH 30 to 59, DUST under 30", "Two brains: transparent v0 rules and nano, a model that learns from every outcome", "Farms get a 45-point penalty", "Only calls made within 15 minutes of launch count on the scoreboard", "BOND calls go straight to the desk"],
  },
  TAPE: {
    what: "Reads every trade on the bonding curve to see who is buying, how, and how much.",
    how: ["Trade speed, unique traders, SOL per buy, share of buys", "Bundle wallets in the creation block, snipers in the first blocks", "How much the top 5 early wallets hold, whether the dev is selling", "Flags farms: a pumped curve with no real buyers behind it"],
  },
  GRAPH: {
    what: "Follows the money behind the dev and the early buyers.",
    how: ["Finds the wallet that funded the dev, and that funder's record across all its launches", "Spots dev clusters that never graduate a coin", "Learns smart wallets: early buyers with a record of picking coins that bond"],
  },
  VET: {
    what: "The gatekeeper. Every BOND call runs through every check before the desk may buy.",
    how: ["Curve inside the buy window, dev not a serial launcher, sane dev buy (a dev sell is info only on memes)", "Bundle share, funder cluster record, not a copycat, not a farm", "Signal fresh (under 3 minutes), a free slot, daily loss limit not hit", "Prior: skips a coin that already dumped 40%+ from its high. Every skip is followed in shadow; COACH drops the prior if those coins do better", "One failed check = skipped, with the reason logged"],
  },
  FLOW: {
    what: "Watches buying and selling pressure right before a buy.",
    how: ["Watches the curve for 3 seconds and checks the last hour of buys and sells", "Skips if the curve is dropping or sellers are in control"],
  },
  BUZZ: {
    what: "Checks the social side: X mentions of the CA and paid DexScreener promotion.",
    how: ["X mentions in the last 15 minutes (when X is connected)", "Paid boosts and paid profiles on DexScreener", "Logged and fed to the runner model, never a reason to buy on its own"],
  },
  SIZE: {
    what: "Decides how much to put in, and when to wait instead of chasing.",
    how: ["A set share of the balance, between a minimum and maximum in SOL", "If the price already ran too far past the call, it waits for a pullback instead (once pullbacks have proven better)"],
  },
  EXEC: {
    what: "Places every buy and sell.",
    how: ["Paper: the real price at that moment, with fees and slippage", "Live: real swaps from the desk's own wallet, every fill on Solscan"],
  },
  RISK: {
    what: "Manages every open position, every 2 seconds.",
    how: ["Stop loss until the cost is back", "Takes the cost back at 2x, the rest rides", "Sells slices at market cap milestones only when the next one looks unlikely", "A trailing stop that widens as the coin runs", "Out instantly if the insiders (bundle, snipers, top buyers) dump", "Dev sells are normal on memes: it holds through them and COACH scores the call"],
  },
  COACH: {
    what: "Reviews every trade after it ends and retunes the desk.",
    how: ["Keeps watching a coin after the desk sells", "If it ran 2x+ after the exit, trails get wider; if the desk gave back 40%+ before selling, trails get tighter", "Scores every dev sell the desk held through; the dev exit only switches on if selling with the dev proves better", "Reviews every coin a prior skipped and overrules the prior when it costs money", "Tests entries in shadow (buy now vs wait for a dip) and unlocks the better one once proven"],
  },
  FILM: {
    what: "The film room. Goes back over every decision the agents made and scores it against what the coin did next, like a fighter watching tape of his own fights.",
    how: ["Every King call meets its outcome: bonds the King didn't like are logged as misses, BOND calls that died as false BONDs", "Scores each reason the King gave: how often \"against\" reasons were wrong, how often \"for\" reasons held up", "Follows every coin VET, FLOW or never-chase skipped: 30 minutes, 2 hours and 24 hours later", "Per rule: how often the skip was right, how often it cost a run, and the average move after the skip", "nano learns from every outcome; priors switch off when the tape shows they cost money"],
  },
  WIRE: {
    what: "The social monitor. Tracks X accounts whose posts spawn coins (world leaders, Elon, founders, KOLs, news) and finds the pump.fun launches born from each post, within seconds.",
    how: ["Every tracked post is read for the names a coin would take: tickers, hashtags, names, phrases", "Every new launch is matched against the last hour of posts: a coin that links the post is a sure match, a ticker or name match is strong", "30 seconds after the first match it picks the leader among the copies (most real SOL in), reads its trades and drops farms", "Hands the leader to the desk as its own strategy, only for accounts it trusts", "Learns per account: posts, coins sparked, picks, bonds, desk P&L. Trust grows or shrinks with results", "Grows its own list: authors of posts that bonded coins link to, and accounts the tracked ones keep mentioning. Mutes accounts that never spark a coin", "Tells the King: a coin born from a tracked post gets +8"],
  },
  PULSE: {
    what: "Reads the room. Counts what every tracked post on X is about, minute by minute, and spots the narratives taking off right now.",
    how: ["Every post from the J7 feed and WIRE's own accounts is split into the words a coin would be named after", "Counted in 5-minute and hourly windows, weighted by the author's reach", "Rising = running at 3x+ its usual pace over the last 24 hours", "Mood per narrative from trench words (send, ape, rug, dump...)", "Tells the King (+5 for a launch named after a rising narrative) and logs every new one"],
  },
  PM: {
    what: "The portfolio manager. Runs the desk as several strategies side by side and gives more capital to whatever is earning, so the curve climbs steadily instead of spiking and crashing.",
    how: ["Sleeves: King calls, early reads, tweet coins (WIRE), each with its own record", "Size per sleeve = its average return over its spread, last 30 trades, shrunk toward a starting weight while the record is short", "A sleeve that loses 60% of a stake over its last 6 trades sits out for 2 hours", "Every buy is still capped by the coin's liquidity"],
  },
  LEDGER: {
    what: "Keeps the books.",
    how: ["Balance, every fill, the exam", "Promotes the desk to its own wallet when it passes, demotes it back to paper at -40%", "Logs errors and recoveries"],
  },
};

function Activity({ ev, color }: { ev: Ev[]; color: string }) {
  const now = Date.now();
  const bins = Array.from({ length: 24 }, () => 0);
  for (const e of ev) {
    const h = Math.floor((now - e.at) / 3600_000);
    if (h >= 0 && h < 24) bins[23 - h]++;
  }
  const max = Math.max(1, ...bins);
  return (
    <div className="ap-bars" title="actions per hour, last 24h">
      {bins.map((b, i) => (
        <i key={i} style={{ height: `${Math.max(4, (b / max) * 100)}%`, background: b ? color : "rgba(255,255,255,0.06)" }} />
      ))}
    </div>
  );
}

export default function AgentPanel({ name, role, color, onClose }: { name: string; role: string; color: string; onClose: () => void }) {
  const d = usePoll<Agent>(`/api/desk/agent?name=${name}`, 4000).data;
  const p = PROFILE[name];
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onClose]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="ap-wrap" onClick={onClose}>
      <aside className="ap" style={{ ["--ac" as any]: color }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`${name} agent`}>
        <div className="ap-head">
          <div>
            <b style={{ color }}>{name}</b>
            <span>{role}</span>
          </div>
          <button className="ap-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="ap-sec">
          <p className="ap-what">{p?.what}</p>
          <ul className="ap-how">{p?.how.map((h) => <li key={h}>{h}</li>)}</ul>
        </div>

        <div className="ap-sec">
          <div className="ap-k">Right now</div>
          <div className="ap-now" style={{ color: d?.last ? TONE[d.last.tone] : "var(--dim)" }}>
            {d?.last ? (d.last.mint ? <Link href={`/c/${d.last.mint}`} style={{ color: "inherit" }}>{d.last.text}</Link> : d.last.text) : "waiting for its first job"}
          </div>
          <div className="ap-when">{d?.last ? `${ago(d.last.at)} ago` : ""}</div>
        </div>

        <div className="ap-stats">
          <div><span>today</span><b>{d?.today ?? 0}</b></div>
          <div><span>all time</span><b>{d?.total ?? 0}</b></div>
          <div><span>good</span><b style={{ color: "var(--rat)" }}>{(d?.tones.ok ?? 0) + (d?.tones.win ?? 0)}</b></div>
          <div><span>bad</span><b style={{ color: "var(--dust)" }}>{(d?.tones.bad ?? 0) + (d?.tones.loss ?? 0)}</b></div>
        </div>

        <div className="ap-sec">
          <div className="ap-k">Last 24 hours</div>
          <Activity ev={d?.history || []} color={color} />
        </div>

        <div className="ap-sec ap-hist">
          <div className="ap-k">History</div>
          {(d?.history || []).map((e, i) => (
            <div key={i} className="ap-ev">
              <span className="ap-t">{ago(e.at)}</span>
              <span style={{ color: TONE[e.tone] || "var(--dim)" }}>{e.mint ? <Link href={`/c/${e.mint}`} style={{ color: "inherit" }}>{e.text}</Link> : e.text}</span>
            </div>
          ))}
          {d && !d.history.length && <div className="muted small">No history yet. It starts recording from this version on.</div>}
          {!d && <div className="muted small">loading…</div>}
        </div>
      </aside>
    </div>,
    document.body
  );
}
