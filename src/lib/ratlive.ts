// v0.1.133 RAT KING CHECK, the worker half. What only the worker knows about a coin, from its own firehose: who bought it
// (FOMO traders, earners, proven wallets, bots, callout front-runners, crews counted once), whether it copies an earlier
// coin, its dev's launches this week, a running story, its market-cap class and the desk's live record there, and the
// RATNET paper strategies holding it. The site asks through Redis (rn:check:q) and the worker answers (rn:check:r:<mint>).
// Every line says what was measured. Signals still on their paper test say so.
import { smartRead, type SmartRead } from "./smartbuy";
import { originAt, originStory } from "./origin";
import { classGate, classLabel, classOf, type Cls } from "./classgate";
import { gridLiveHolding } from "./gridlive";
import { fomoRegime } from "./fomotap";
import { CHECK_Q, CHECK_R, type LiveRead } from "./ratcheck";
import { redis } from "./redis";

export function liveRead(mint: string, now = Date.now()): LiveRead {
  const who: SmartRead | null = smartRead(mint, now);
  const og = originAt(mint);
  const story = originStory(mint, now);
  const hold = gridLiveHolding(mint);
  const regime = fomoRegime(now);
  const cls: Cls | null = hold.px ? classOf(hold.px) : null;
  const gate = cls ? classGate(cls, now) : null;
  const good: string[] = [];
  const bad: string[] = [];
  const info: string[] = [];
  if (who) {
    const bots = who.bots;
    if (bots >= 3 || (who.buyers >= 5 && bots / who.buyers >= 0.2)) bad.push(`${bots} bots bought it (wallets with 30+ round trips a day). On RATNET's paper trades, coins bots buy rugged 48% of the time vs 8% for the rest`);
    else if (bots) info.push(`${bots} bot${bots > 1 ? "s" : ""} bought it`);
    if (who.fomo >= 5) good.push(`${who.fomo} FOMO traders bought it (crews counted once): the retail crowd found it`);
    else if (who.fomo) info.push(`${who.fomo} FOMO trader${who.fomo > 1 ? "s" : ""} bought it`);
    else if (who.buyers >= 30) info.push("no FOMO traders in it yet");
    if (who.earners) good.push(`${who.earners} wallet${who.earners > 1 ? "s" : ""} with a real winning record bought it (10+ trades, +0.5 SOL net, 25%+ won)`);
    if (who.proven) good.push(`${who.proven} proven wallet${who.proven > 1 ? "s" : ""} bought it (their earlier coins migrated)`);
    if (who.front) good.push(`${who.front} wallet${who.front > 1 ? "s" : ""} that usually buy before KOL callouts got in (signal still on its paper test)`);
    if (who.smart >= 3 && who.smartCrews === 1) bad.push(`the ${who.smart} smart buyers are one crew: they keep buying within seconds of each other, so it is one buyer, not ${who.smart}`);
  }
  if (og && og.rank > 1) bad.push(`a copy: ${og.rank - 1} earlier coin${og.rank > 2 ? "s" : ""} used this name, ticker or picture`);
  if (og && og.cr >= 3) bad.push(`the dev launched ${og.cr} other coins in the last 7 days`);
  if (story) info.push("its name or ticker already migrated another coin in the last 24 hours (a running story)");
  if (cls && gate) info.push(`market cap class ${classLabel(cls)}: the RATNET desk's own live record there is ${gate.live.n ? `${gate.live.pnl >= 0 ? "+" : ""}${gate.live.pnl} SOL on ${gate.live.n} trades` : "not started"}${gate.on ? "" : " (the desk does not buy this class with real money now)"}`);
  if (hold.books) good.push(`${hold.books} RATNET paper strateg${hold.books > 1 ? "ies hold" : "y holds"} it${hold.passed ? `, ${hold.passed} of them followed by the live desk` : ""}`);
  if (regime != null) info.push(`FOMO retail money is running at ${regime}x its 6-hour average`);
  return {
    at: now,
    who: who && { since: who.since, buys: who.buys, buyers: who.buyers, buyersCapped: who.buyersCapped, sol: who.sol, fomo: who.fomo, earners: who.earners, proven: who.proven, bots: who.bots, front: who.front, crews: who.smartCrews, smart: who.smart },
    copy: og ? og.rank - 1 : null,
    devWeek: og ? og.cr : null,
    story,
    cls,
    classOn: gate ? gate.on : null,
    mcSol: hold.px,
    books: hold.books,
    followed: hold.passed,
    regime,
    good,
    bad,
    info,
  };
}

/** Telegram call lines: who is in the coin right now (short). */
export function callLines(mint: string): string[] {
  const r = liveRead(mint);
  const w = r.who;
  const parts = w ? [w.fomo ? `${w.fomo} FOMO` : "", w.earners ? `${w.earners} earners` : "", w.proven ? `${w.proven} proven` : "", w.front ? `${w.front} front-runners` : "", w.bots ? `${w.bots} bots` : ""].filter(Boolean) : [];
  return [parts.length ? `Who is in: ${parts.join(" · ")}` : "", ...r.bad.slice(0, 2).map((x) => `⚠ ${x.split(":")[0].split(". On")[0]}`)].filter(Boolean);
}

let busy = false;
/** Worker, every second: answer the site's checks. */
export async function serveChecks() {
  if (busy) return 0;
  busy = true;
  let n = 0;
  try {
    const r = redis();
    for (let i = 0; i < 20; i++) {
      const q = await r.rpop<{ m: string; at: number }>(CHECK_Q);
      if (!q?.m) break;
      if (Date.now() - (q.at || 0) > 15_000) continue; // the site stopped waiting
      await r.set(CHECK_R(q.m), liveRead(q.m), { ex: 120 }).catch(() => null);
      n++;
    }
  } catch {
  } finally {
    busy = false;
  }
  return n;
}
