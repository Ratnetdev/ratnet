"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export const GLOSSARY: Record<string, string> = {
  bond: "Graduating: the coin fills its bonding curve and moves to a real pool. About 1 in 100 make it.",
  curve: "The pump.fun meter. Buys fill it, sells drain it. 100% = graduation.",
  verdicts: "Scored 0 to 100 at minute 5. BOND 60+, WATCH 30 to 59, DUST under 30.",
  hit: "Share of King BOND calls that graduated. Running calls count as misses until they bond.",
  base: "Share of all launches that graduate. What random picking gets you.",
  lift: "King BOND calls graduate this many times more often than a random launch.",
  nano: "A second model learning from zero on every outcome. Weights public in the Lab.",
  dev: "How many coins this dev launched before, and how many graduated.",
  lead: "Average time between the King's BOND call and the graduation.",
  dust: "Right when the coin does not graduate. Most launches die, so this runs high.",
  dug: "Every pump.fun launch the rats have read.",
  cam: "The rats working live. Every nugget is a real coin. Click a line to open it.",
  grads: "Coins that just graduated, how fast, and what the King said at minute 5.",
  radar: "Live coins filling their curve, closest to graduating on top.",
  feed: "Everything the rats do, as it happens.",
  desk: "Paper: real curve prices, simulated fills with fees and slippage. Live: a real wallet, every fill on Solscan.",
  exam: "The desk trades on paper until it passes every line here. Then it goes live by itself with the funded wallet.",
  den: "Each rat is one agent. It hops and talks when it acts. A coin rolls down the line when the desk buys.",
  thresholds: "The exact rules the desk trades by, and how the last candidate scored on each one.",
  runners: "Every coin the rats followed after the King's call, for 7 days after it bonds. Peak is the highest market cap seen. x is peak vs the market cap at the call, where the King would have bought.",
  peak: "Highest market cap the rats saw after the call (sampled every few minutes, so the true top can be a bit higher).",
  fromcall: "Peak market cap divided by the market cap at the King's minute-5 call.",
  pnext: "Runner model: chance this coin reaches the next market cap milestone. Starts from base rates and learns from every coin the rats follow.",
  trail: "Trailing stop: sell what is left if price falls this far from its peak. Widens as the coin runs, scaled by COACH and the runner model.",
  insiders: "Bags of the dev, bundle wallets, snipers and top early buyers, watched every 4s. If they dump, the desk is out.",
  learn: "What the desk learned from its own trades: trail scale from exit reviews, which entry works best, and whether early entries are earned.",
  arms: "Every clean signal is followed in shadow four ways: buy now, or wait for a 20, 30 or 45% pullback. Mean result 30 minutes later.",
  historian: "Replays past pump.fun launches, today first and then back in time, rebuilding what the rats would have seen at minute 1 and 5. Older days weigh less, because seasons change.",
  season: "SOL's trend and how busy pump.fun is. Every lesson carries the season it happened in, so the models learn what works in this kind of market. A jump in recent errors means the market shifted: the models then learn faster for a while.",
  prequential: "Each past launch is scored by the model before it learns from it. Base = how many bonded within 2h (weighted sample).",
  early: "The minute-1 model. Its calls are shadowed until its record beats the minute-5 King over 50+ calls.",
  mc: "What the whole supply is worth at the current price, in USD.",
  mcap: "Market cap: price times total supply. What the whole coin is worth right now.",
  v5: "USD traded (buys + sells) in the last 5 minutes.",
  v1: "USD traded (buys + sells) in the last hour.",
  v24: "USD traded (buys + sells) in the last 24 hours.",
  c5: "Price change over the last 5 minutes.",
  c1: "Price change over the last hour.",
  bs: "Number of buy vs sell transactions in the last hour. More green = more buyers than sellers.",
  atcall: "Market cap at the moment the King made its minute-5 call. This is where you could have bought on the call.",
  trades: "Every buy and sell on the bonding curve when the rats read it. /min = trading speed since launch.",
  traders: "Unique wallets that traded. Many different wallets is healthier than a few wallets trading a lot.",
  solbuy: "Average buy size in SOL. Tiny identical buys often mean bots, a mix of sizes looks like real people.",
  buyshare: "Share of recent trades that are buys. Above 50% means buyers are winning.",
  bundle: "Share of all SOL that came in through wallets buying in the same block the coin was created (w = how many wallets). High = the dev or a bot pre-bought a big chunk.",
  snipers: "Wallets that bought in the two blocks right after launch. Usually bots that sell into the first buyers.",
  top5: "Share of early buying done by the 5 biggest wallets. High = a few wallets hold most of it and can dump.",
  devsold: "How much SOL the creator got out by selling. A dev who sells early is a strong warning.",
  funder: "The wallet that sent the creator their SOL. Devs funded from the same wallet are usually the same person.",
  cluster: "Every coin launched by devs funded from that same wallet, and how many of them graduated.",
  cledge: "That cluster's graduation rate compared to the average launch. 2x = twice as likely, under 0.5x = a known rug factory.",
  smart: "Early buyers with a proven record of getting into coins that later graduated. More of them = better.",
  meta: "A word in the name that is graduating a lot right now (the narrative of the moment), and how much more often it bonds.",
  copycat: "Copies the name of a coin that just ran. Research: copycats graduate about 10x less often than originals.",
  rowsdug: "Every launch the rats recorded. One row per coin.",
  labelled: "Rows whose result is known: graduated or died.",
  oven: "Rows still waiting for a later checkpoint (1 hour or 24 hours) before they are final.",
  bondedrows: "Rows where the coin graduated. Rare, which is why every one matters for training.",
  rows: "Number of launches in that day's file.",
  matching: "Coins that pass your filters in the chosen window.",
  bonded: "Graduated: filled the bonding curve and moved to a real pool.",
  died: "Never graduated and stopped trading.",
  stilllive: "Still on the curve. Can still graduate, so not counted as right or wrong yet.",
  curveout: "How full the bonding curve is now, or how it ended (bonded or died).",
  peakcurve: "The highest point this coin reached on its bonding curve so far.",
  socials: "Links the creator added: X, Telegram, website. Missing socials is common for quick rugs.",
  king: "The Rat King's minute-5 call: BOND (likely to graduate), WATCH (maybe) or DUST (unlikely).",
  v0: "The King's transparent rule-based scorer. Every weight is public on the Calls page.",
  curvecall: "How full the curve was when the King made the call.",
  outcome: "What happened after the call: BONDED, DIED, or still running.",
  bondedin: "Time from launch to graduation.",
  score: "The King's score from 0 to 100. BOND 60+, WATCH 30 to 59, DUST under 30.",
  by: "Wallet that paid for the sniff.",
  watchhit: "Share of WATCH calls that went on to graduate. Should sit between the BOND hit rate and the base rate.",
  samples: "Every launch with a known result is one lesson for the model.",
  bondsseen: "Lessons where the coin graduated. The model learns most from these rare positives.",
  loss: "How wrong the model's guesses are, averaged. Lower is better. 0.693 is a coin flip.",
  counted: "Calls made on time (at minute 5) that already have a result. Late calls never count.",
  burned: "Total $RAT sent to the burn address to spawn rats and order sniffs. Gone forever.",
  paidowners: "SOL paid out to rat owners so far: 40% of all creator fees, every 12 hours.",
  compute: "60% of creator fees pay for the work: digging every launch, training the models, running the calls.",
  window: "The 12-hour period this payout round covers.",
  fees: "Creator fees earned by $RAT in that round.",
  owners40: "The 40% of fees split between rat owners, weighted by digs and bag size.",
  eligible: "Rats that did at least the minimum digs in that round. Only these get paid.",
  amount: "$RAT burned in that transaction.",
  what: "What the burn bought: a rat spawn or a sniff order.",
  ratsalive: "Rats currently digging. Rats burned after a litter closes wait for the next one.",
  bagmult: "Holding more $RAT per rat raises its share of the payout. Earnings are capped at 2x the rat's cost unless you hold 100K+ per rat.",
  litter: "Rats are born in litters of 100. The litter number your rat belongs to.",
  digs: "Launches this rat read in the current 12h round. It needs the minimum digs to get paid.",
  earned: "SOL this rat has earned from payouts.",
  burntx: "The burn transaction that spawned this rat, on Solscan.",
  digsall: "Every launch this rat has read since it was born.",
  rfrom: "Starting market cap of this step.",
  rto: "The next market cap milestone.",
  reached: "Share of coins that hit the From level and went on to reach To. Learned from every coin the rats followed.",
  seen: "How many coins reached From. More = a more reliable number.",
  now: "Current market cap.",
  side: "BUY or SELL.",
  sol: "SOL spent on a buy, or received on a sell.",
  result: "Profit or loss on that sell, in percent.",
  why: "Which rule triggered the trade, for example initials, trail, insider exit.",
  wants: "The pullback the desk waits for before buying, measured from the coin's peak after the call.",
  dip: "How far the price has pulled back from its peak so far.",
  since: "How long the desk has been waiting on this coin.",
  hscanned: "Past pump.fun launches the historian replayed.",
  hbonded: "Of those, how many graduated within 2 hours.",
  hlessons: "Lessons fed to the models from the past. Older lessons count for less.",
  hrunner: "Past graduated coins used to teach the runner model how far coins run.",
  hqueue: "Launches found but not replayed yet.",
  sol24: "SOL price change over 24 hours. Memecoins usually run harder when SOL is up.",
  sol7d: "SOL price change over 7 days: the bigger trend.",
  lrate: "New pump.fun coins per hour. A busy market splits attention over more coins.",
  br24: "Share of launches that graduated in the last 24 hours.",
  labstatus: "LEARNING: nano's calls do not count yet. CALLING: it has learned enough and its calls count on the board.",
  roundstatus: "open: round running. paid: payouts sent, each one on Solscan.",
  rbonded: "When the coin graduated.",
  t_market: "Live price, volume and flow from DexScreener for this coin.",
  t_tape: "TAPE agent: reads every trade on the bonding curve to see who is buying, how and how much.",
  t_graph: "GRAPH agent: follows the money behind the dev and the early buyers, and checks their track record.",
  t_dug: "The raw facts the rats recorded when this coin launched.",
  t_cp: "The curve and market cap at 1 minute, 5 minutes, 1 hour and 24 hours. The result comes from these.",
  t_v0: "The King's transparent scorer. Score 0 to 100 at minute 5: BOND 60+, WATCH 30 to 59, DUST under 30.",
  t_outcome: "What actually happened. A coin counts as BONDED if it graduates within 2 hours of the call.",
  t_drops: "One file per day with every launch the rats recorded and its result. Free to download.",
  t_schema: "The fields in each row of the dataset.",
  t_tunnels: "The launchpads the rats watch. Open = rats are digging there now.",
  t_coins: "Every coin matching your filters. Click one to open its full read.",
  t_rules: "How a call is graded, so nobody can move the goalposts.",
  t_tloss: "How wrong nano's guesses are over time. Going down = it is learning.",
  t_vs: "Rule-based scorer against the learned model, on the same coins.",
  t_weights: "What nano has learned: how much each signal pushes the score up (green) or down (red).",
  t_how: "Plain-language walkthrough of the learning loop.",
  t_rounds: "Every 12 hours, creator fees split 60% compute, 40% rat owners. Each payout is a Solscan link.",
  t_burns: "Every $RAT burn: spawns and sniff orders, verified on chain.",
  t_proof: "Coins grouped by the score they got. If the score works, higher scores graduate more often.",
  t_24: "Hour by hour: share of BOND calls that graduated vs the average launch.",
  t_spawn: "Burn 100,000 $RAT to get a rat. It digs for the network and earns a share of fees every 12 hours.",
  t_yours: "Rats owned by the connected wallet.",
  t_top: "Rats with the most digs.",
  t_screens: "What each rat is reading right now.",
  t_sniff: "Burn 10,000 $RAT and the rats read any coin you paste. The read is public.",
  t_rsniffs: "The latest coins people paid to have sniffed.",
  t_alerts: "Sound and popups for calls and graduations. Only works while this tab is open (or in the background if you allow notifications).",
  t_balance: "The desk's balance over time. Paper until it passes the exam, then its own wallet.",
  t_open: "Coins the desk holds right now, with exit levels.",
  t_trades: "Every buy and sell the desk made, and why.",
  t_stalk: "Good coins that already ran too far past the call. The desk waits for a pullback instead of chasing.",
  t_king: "Calls the King made at minute 5 on each launch.",
  cfg_enter_on: "Which calls make the desk consider a buy.",
  cfg_curve_window: "Only buy while the curve is inside this range.",
  cfg_reject_dev: "Skip devs with a bad record: many launches and no graduations, a dev who sold, or a rug factory cluster.",
  cfg_max_bundle: "Skip if pre-bought bundle wallets put in more than this share of the SOL.",
  cfg_copycats: "Skip coins that copy a recent winner's name.",
  cfg_min_buy_flow: "Need at least this share of buys in recent trades.",
  cfg_never_chase: "If price already ran too far past the call, wait for a pullback instead of buying.",
  cfg_size: "How much of the balance goes into one trade, with a minimum and maximum in SOL.",
  cfg_stop_loss: "Sell everything if price falls this far, until initials are taken.",
  cfg_initials: "Take the starting money back once the trade is up this much. The rest rides for free.",
  cfg_moonbag: "This part is never sold on targets, only by the trailing stop. It lets real winners run.",
  cfg_ladder: "At each market cap milestone, sell a slice only if the runner model thinks the next level is unlikely.",
  cfg_trail: "Trailing stop: sell what is left if price drops this far from its peak. Wider as the coin runs bigger.",
  cfg_insider_exit: "Get out if the dev or the insider wallets (bundles, snipers, top early buyers) sell this much.",
  cfg_sellers_exit: "Get out if the curve drops fast before initials.",
  cfg_on_migration: "When the coin graduates, keep the runner bag if the next milestone is likely enough.",
  cfg_time_stop: "Sell if nothing happened within this time and initials are not taken.",
  cfg_daily_stop: "Stop trading for the day after losing this much.",
  round: "Fees are paid out every 12 hours. When the countdown hits zero, 40% of the round's creator fees go to rat owners.",
  ratcost: "Burning sends $RAT to a dead address. It is gone forever, which shrinks the supply.",
  scorer: "The King's rule-based scorer. No black box: these are the exact weights it uses.",
  dugcreator: "The wallet that launched the coin, with its record: launches before and how many graduated.",
  devbuy: "SOL the creator spent buying their own coin at launch.",
};

export default function Info({ k, children, text }: { k: keyof typeof GLOSSARY | string; children?: React.ReactNode; text?: string }) {
  const [pos, setPos] = useState<{ x: number; y: number; up: boolean } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const body = text || GLOSSARY[k] || "";
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const w = Math.min(260, window.innerWidth - 24);
    const x = Math.max(12, Math.min(r.left, window.innerWidth - w - 12));
    const up = r.bottom + 150 > window.innerHeight && r.top > 160;
    setPos({ x, y: up ? r.top - 8 : r.bottom + 8, up });
  };
  useEffect(() => {
    if (!pos) return;
    const close = (e: Event) => {
      if (e.type === "mousedown" && ref.current?.contains(e.target as Node)) return;
      setPos(null);
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    document.addEventListener("mousedown", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      document.removeEventListener("mousedown", close);
    };
  }, [pos]);
  if (!body) return <>{children}</>;
  return (
    <span
      ref={ref}
      className={`info ${pos ? "on" : ""}`}
      tabIndex={0}
      onMouseEnter={show}
      onMouseLeave={() => setPos(null)}
      onFocus={show}
      onBlur={() => setPos(null)}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        pos ? setPos(null) : show();
      }}
    >
      {children != null && <span className="info-t">{children}</span>}
      <span className="info-q" aria-label="What is this?">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><circle cx="6" cy="6" r="5.25" fill="none" stroke="currentColor" strokeWidth="1" /><rect x="5.5" y="5" width="1" height="3.6" fill="currentColor" /><rect x="5.5" y="3.1" width="1" height="1" fill="currentColor" /></svg>
      </span>
      {pos &&
        typeof document !== "undefined" &&
        createPortal(
          <span className={`info-pop ${pos.up ? "up" : ""}`} role="tooltip" style={{ left: pos.x, top: pos.y }}>
            {body}
          </span>,
          document.body
        )}
    </span>
  );
}
