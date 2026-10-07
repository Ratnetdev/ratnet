# Changelog

## v0.1.17 · Never stall
- Found why the desk froze with the worker "running": the worker's heartbeat was a timer, not proof of work, and RPC calls had no deadline. One stalled Helius connection could hang the desk loop forever (no price updates, no exits, no entries) while the heartbeat kept the Vercel ping standing aside. Now: every chain read has an 8s deadline (RPC_TIMEOUT_MS); every part of a session has a cap, so a slow agent is left to finish on its own instead of holding the loop; the worker's heartbeat only beats while sessions complete, pauses past 3x a session and the process restarts itself past 5x (Railway starts a fresh one); the Vercel minute ping steps aside only while the desk itself is beating, so it takes the desk over within a minute of any stall (the desk lock keeps it to one desk).
- Positions never go blind: if the chain read fails, open positions are priced from DexScreener for that beat, and any coin with no curve and no canonical pool (another pool or launchpad) falls back to DexScreener's deepest SOL pair.
- Live prices on the site no longer depend on the trade stream alone: /api/px reads the market caps of the coins on screen straight from the chain (1s CDN cache) and the browser polls it every 2s for any coin without a streamed trade in the last 3s. Numbers on screen are at most ~2-3 seconds old.
- Dev exit learned per kind: coins are classed tech or meme (what the coin says about itself and its website: agent, protocol, app, GitHub, docs ...). Tech starts with the dev exit on, memes off (starting priors), and COACH learns each separately from every case: holding through a dev sell vs selling with the dev, and for dev exits whether the coin ran 30%+ after. After 15 cases per kind the record decides.

## v0.1.16 · Exit lab
- EXIT LAB: exits are learned per strategy and per market-cap tier (micro under $100K, small to $1M, large $1M+) from every trade's whole path. Every closed trade, real and ghost, leaves its price path from the buy until 2 hours after it (COACH keeps watching after the sale). Every ~10 minutes the lab replays the last 40 paths of each bucket under a grid of 500 exit settings (stop, time stop, initials, trail) and moves halfway toward the best one, once a bucket has 12 paths. Shown in admin Strategy with the replayed result vs before. Nobody sets these numbers by hand.
- Fixed two flaws that gave a $3M coin an 8-minute time stop: one exit profile per strategy for every market cap (now per tier), and a feedback loop where profiles only saw the price while holding (a short time stop made every peak look early, which shortened the stop further). Profiles are now per tier, and the lab judges exits on the whole move, including after the sale.
- COACH now also learns from stop-loss and time-stop exits (through the lab), not only from trailing stops.

## v0.1.15 · Real time
- Live market caps: every page streams pump.fun trades (curve and PumpSwap) for the coins on screen straight from PumpPortal's public websocket. Open positions, the radar, open trades in the track record and the coin page move with every trade (green on a buy, red on a sell, a live dot). One shared connection per tab, subscriptions follow what is on screen.
- Worker: one PumpPortal connection for launches, migrations and live trades on every open position, the 40 hottest curves and fresh migrations. A 20-second live tape per coin lands in Redis (rn:rt) every 2 seconds, and a buying burst (10+ buys from 6+ wallets, 4+ SOL net in 20s) wakes CATCH at once instead of at its next 12-second pass. CATCH's starting score reads the live tape (+10 on a burst, -8 when sellers dominate).
- Insider exit fixed: it fired on any drop in the watched wallets' bags, even when they were tiny (three snipers selling 0.3% of supply = "insiders dumped 99%"). Now it needs the insiders to have let go of at least 2% of the supply (insiderMinSupply) and the price 8%+ off the peak; the exit line says both numbers.
- LENS: a social page in the website field (Instagram, TikTok, YouTube, X, Telegram, Linktree, ...) is no longer "does not load -10": it is noted as "no own website" (-2) and not opened. An X read failing on our side (key, rate limit, outage) is no longer counted against the coin; only a real "post/account not found" is. The address bar shows ratnet://lens/$TICKER when the dossier is written.

## v0.1.14 · CATCH, BOARD, hardening
- Desk freeze fixed. A MOMO position hitting its own time stop crashed every desk beat (an exit message read a strategy profile that did not exist yet), so the desk stopped exiting and entering until restarted. Fixed, and the desk is now fault-isolated: one broken position, ghost position or signal logs an error and everything else keeps running.
- Slots fixed. Positions whose cost is back (house money) no longer take a slot, so moonbags can never fill the desk (the 12h sim showed 7 bags blocking every slot for 6 hours). MOMO positions no longer use the King's slots. New: bag cap (maxBags 12, the quietest bag is sold to make room) and quiet-bag exit (no new high for bagStaleMin 120 minutes and under 3x: sold).
- CATCH (23rd agent): the sender catcher. Looks again and again at the 40 hottest curves, every migrated pump.fun coin MOMO sees and every coin several agents agree on, and asks: does it reach max($300K, 2x) within 6 hours? Each look is a ~33-feature snapshot (stage, speed, migration time, breadth, buy pressure, tracked wallets, the story, every agent's stance) labelled 6 hours later by what the coin did. An online logistic model learns from every label, graded before it learns (honest record by score band, curve vs migrated). Until it has 300 labels a transparent starting score trades; then the lowest band hitting 8%+ and 6x the base rate. Own desk checks (room to run, farm, bundle, top 10 holders, liquidity), own slots (3), own PM sleeve, own starting exits (initials +60%, stop -18%, 30m time stop, trail 0.8x). Settings: catch* in the desk JSON.
- CATCH looks at a coin the moment it migrates: the digger and the worker (PumpPortal migration feed) flag fresh migrations, CATCH reads their pool straight from the chain (no waiting for MOMO's minute list) and the worker triggers a pass at once.
- CATCH starts trained: HISTORIAN turns every replayed launch into CATCH lessons (the minute-5 look and, for bonded coins, the migration look, labelled by the hourly candles after the bond), with its own record.
- BOARD: one shared page per coin. Every agent line about a coin lands there as a stance through agentLog (explicit stances from KING, MIND, LENS, HOUND and MOMO). Families count once and fade over 45 minutes. Where 3+ families agree, MIND and LENS look at once; every CATCH signal gets a MIND read. Shown on /desk with each agent's stance.
- MIND: needs an independent signal to buy (King or nano BOND, tracked wallets, MOMO traction or a post wave); creator-written text is wrapped as data and instructions in it count as a scam signal; school lessons that name a coin, ticker or address are dropped.
- Security review, every finding fixed: coin image proxy only serves real raster images (bytes sniffed, SVG/HTML refused) with nosniff and a sandbox CSP; SSRF guard for every fetch of a stranger's URL (metadata, images, websites: public hosts only, redirects re-checked, byte cap, one deadline); signed expiring admin sessions with a login rate limit and logout; per-purpose webhook secrets (X, Helius, Telegram) instead of the root secret, constant-time compares everywhere, cron secret via Authorization header (CRON_HEADER_ONLY=1); Telegram commands only from TELEGRAM_ADMIN_IDS; trade transactions vetted before signing (payer and program allowlist) and a timed-out swap is followed until its blockhash expires before any retry (no double buys); owned, renewed desk lock; payouts locked per round, signature saved before sending, chain checked before any retry, partly paid rounds can't be recomputed; desk settings validated and bounded; public routes rate limited; VET values and King internals stripped from public endpoints; external links sanitised; security headers (CSP, HSTS, frame-ancestors none); /api/health public answer is ok/fail only; Next.js 14.2.35.
- Admin Setup tab: every env var and whether it is set, live status of the worker, RPC plan, Telegram webhook, X watchlist and Helius webhook, one-click connect/sync buttons, the twitterapi.io webhook URL (copy), cron instructions. No secrets shown.
- UI: every page swept on desktop and mobile (no overflow, no console errors); the Den showed only 21 of its agents (last row cut off), now sized to the team; strategy sleeves table labelled every non-King sleeve "Tweet coins"; tighter mobile tables (trade icons on the coin page instead of every row, shorter curve bars).
- Tests: sim/securitytest.ts (25 checks). 12h sim: 0 errors, the desk trades all 12 hours (200 closed vs 58 before the fixes), CATCH traded 19 times.

## v0.1.13 · Speed
- Fast execution: every live trade builds its own transaction from Jupiter's swap instructions (fetched in parallel with a blockhash that is always pre-loaded), with a live priority fee from Helius (capped at 0.003 SOL), a small Jito tip (0.4% of the trade, 0.0003 to 0.002 SOL), sent through Helius Sender and the RPC at the same time, rebroadcast every 0.7s, confirmation checked every 0.4s. Any problem with the fast path falls back to Jupiter's own transaction. Each trade logs how long it took to land. Settings in the desk JSON: fastExec, maxPriorityLamports, jitoTipMinSol, jitoTipMaxSol.
- Faster loop on a paid RPC plan (RPC_RPS 40+): positions re-read every 1s (was 2s), the rats dig every 5s (was 10s).
- FLOW waits 1.5s before a King buy (was 3s), tweet coins no wait. WIRE picks the leader among a post's copies after 20s (was 30s).
- Always-on worker (worker/index.ts, `npm run worker`): runs the whole protocol back to back with no gaps between minute pings, and digs a new launch the moment PumpPortal announces it. Deploy on Railway from the same repo with the same env vars. The Vercel minute ping steps aside while the worker's heartbeat is fresh and takes over again if it stops.
- Admin Strategy tab: speed panel (worker on or off, RPC plan, how fast live trades land).
- Live updates on every page (bottom right, replaces the one-line rat cam pill): a stack of the 3 latest moments as cards (new launches, King calls, graduations, desk buys and sells, MOMO, MIND, WIRE), one new card every 2.6s so every line can be read. When it gets busy the least important updates are dropped, never sped up. Hover pauses it ("paused · N waiting"); click a card to open the coin; "cam" opens the full rat cam, × folds it into a dot with a counter. One card on mobile, above the tab bar.
- Coin logos everywhere, including brand-new pairs: live update cards, calls, radar, graduations, coin pages, alerts, desk positions and trades, MOMO, MIND, HOUND, LENS, runners, hall of fame, sniff and the feed. New route /api/img/[mint] finds the image (dig record, the launch metadata, pump.fun, DexScreener), asks 5 IPFS gateways at once (pump.fun's own first) and caches the winner on the CDN for a week. No image yet: a ticker badge, retried every 2 minutes.
- Trade button logos (GMGN, Axiom, FOMO, pump.fun, DexScreener) race Google, DuckDuckGo and the site's own favicon, with a letter badge if all fail. Never a blank button.
- MIND reads coin images through pump.fun's gateway and retries on text alone if the image can't be fetched.
- Tests: sim/exectest.ts.


## v0.1.12 · MOMO
- MOMO (22nd agent): the runners after migration. Every minute it reads GeckoTerminal's trending Solana pools (5m and 1h) and PumpSwap's busiest pools, and sends the desk the pump.fun coins with real traction right now: $25K+ volume in 5 minutes, $100K+ in the hour, 40+ different buyers, more buyers than sellers, $20K+ liquidity, under 24 hours old, not falling and not already +60% in 5 minutes. Live table on /desk with why each coin is or is not taken.
- The desk buys MOMO coins in their own sleeve (3 slots, PM sizing by record) after its own checks: holder spread (top 10 under 35%, pool excluded), wash trading, 40+ SOL in the pool. Starting exits are tighter (initials at +40%, stop -20%, out after 40 minutes without initials) until MOMO's own record sets them. MIND judges every MOMO coin too. All lines are in the desk JSON (momo*), every skip is followed by FILM.
- BOND calls the rats could not tape in time are no longer kept from the desk: the desk reads the trades itself (its own fast lane) and runs VET on them. Farms are still caught.
- Sim (4h): desk tape reads caught every farm sent to it; MOMO picked and traded rising migrated coins. 0 errors.


## v0.1.11 · HOUND and OVERSEER
- HOUND (20th agent), the wallet book, in three parts:
  - FOMO traders (fomoapi.io): every leaderboard trader is profiled from their own closed trades (win rate, average win, average loss, expected value per trade, best trade, 10x+ count). Only two kinds are tracked, both with a positive EV: home-run hitters (40% win rate or less, 2+ trades of 10x, average win 3x+) and steady hands (60%+ win rate, smaller wins, small losses).
  - KOL wallets: from the MadeOnSol and Solana Tracker rosters and from the admin (new Wallets tab, or /wallet on Telegram). Confirmed only with objective proof: the on-chain SNS registry links the wallet to their X handle, or their own X account posted the address. Two rosters agreeing = likely; anything else = unconfirmed. The name is always shown.
  - Smart wallets found on chain: every coin that breaks out past $500K is dug up (every buy on its curve before bond). Wallets that put 1+ SOL in early get credit; 3 breakouts (or 2 with 10x entries and 3+ SOL) and not a spray bot = tracked.
- Live: every tracked wallet sits on one Helius webhook (kept in sync with the book). Buys show on /desk within seconds with names; smart wallets stay anonymous in public. 2+ tracked wallets in a coin within 30 minutes, or one strong one, sends it to LENS and MIND. MIND can now judge coins the rats never dug (older coins, other launchpads) from DexScreener; those stay on its record, the desk only trades pump.fun coins.
- Copy records: every tracked buy is followed 1h, 6h and 24h later as if we had copied it a minute later, per wallet and per class. MIND sees them; RISK sizes a buy 0.7x to 1.4x by how copying the classes in the coin has actually done.
- OVERSEER (21st agent): explores Reddit, GitHub, arXiv and X for ideas (one source per 10 minutes, never reads the same thing twice, trail visible in admin) and every 6 hours reads the whole protocol (desk, sleeves, FILM, MIND, the King's honest scoreboard, wallet classes, priors, your feedback). Proposes up to 3 concrete ideas with the numbers behind them, numbered, to your Telegram ideas chat. Answer /yes 12, /no 12 why, /later 12; it learns which kinds you take. Also /ideas, /think, /status, /teach, /wallet, /id. It proposes only.
- Admin: Wallets tab (add with proof check, switch off, every wallet's record) and Overseer tab (ideas with yes/later/no, the exploring trail, findings, ideas now).
- Trade buttons now also on every call list, radar, explore, runners, open positions and the track record (small logos, same referral links).
- Tests: sim/houndtest.ts, sim/overseertest.ts.


## v0.1.10 · King v1 and MIND
- MIND (19th agent): the trader's mind. Judges coins like a sharp memecoin trader: the meme itself (it looks at the coin's image), the name and the story, the narrative and how hot it is on X right now, who posted it (KOLs, traders, the post behind it), whether it is a copy and whether a copy can still win, the timing, plus everything the other agents know (curve, trades, holders, dev record, King call, LENS's look at the website and X). SEND, WATCH or PASS with a conviction and a thesis in plain words. Looks at KOL calls, tweet coins, BOND calls, fresh migrations and narrative coins, before or after migration.
- MIND learns: every call is followed 15m, 1h, 6h and 24h later. Post-mortems after 24 hours on every SEND and every coin it passed that ran 3x+; lessons that keep helping gain weight, lessons that keep hurting drop out. The lesson book starts with your trench rules. School: every hour it reads what the KOLs and traders it follows posted and keeps the reusable lessons. Admin can teach it (paste a thread, a video transcript, your own rules) and switch lessons on or off.
- MIND trades: its own sleeve (PM), its own 2 slots, buys on the curve or after migration (20+ SOL in the pool). In auto mode its SEND calls only trade once 20+ of them average +15% after 6 hours with 40%+ up; until then they are on record only. mindMode on/off in the desk JSON.
- KOL and trader calls: a CA posted by a KOL, a trader or any 10k+ account goes to MIND at any coin age, and every caller is graded 6 hours later (calls, average, 2x+). 11 memecoin traders added to the seed list; new seeds now join a running WIRE.
- Tweet links: any post a new launch links (in its X link, description or website) is fetched within seconds, even from accounts WIRE was not watching. The coin becomes a WIRE match, the author joins WIRE (big accounts start with more trust), copies named after the post match too.
- Tweet coins, picked like a trader: WIRE's picker scores every copy on a post (volume in, pace, unique traders, top 5 holders, bundle, who was first, links the post) with weights it learns: 2 hours after each post it checks which copy went furthest and moves toward it. Starts from the hint "volume, spread holders, first out", not bound to it.
- Vamps: for 30 minutes after a pick the post stays on watch. A later copy that pulls 25%+ more SOL than the pick, faster, on a post with a proven wave (4+ coins, 40+ SOL across them) is picked too, max 2 per post, in its own PM sleeve (sized by its own record).
- New prior post_traction: most headlines move nothing, so a tweet coin needs its post to have spawned a wave (3+ coins or 25+ SOL across them), unless the author posted the CA. Skipped tweet coins are followed in shadow and COACH overrules the prior if they do better.
- Exit profiles per strategy: PM records how high each sleeve's coins peak and how fast. Once a sleeve has 12+ closed trades (real or ghost), its initials sit at 80% of its typical peak and, when its coins peak fast, its time stop shortens. COACH now tunes the trail per sleeve too. Tweet coins that dump right after the first push get taken into that push, if that is what the trades show.
- MIND knows about waves, copies and vamps; four of your trench notes join its lesson book as starting hints with no record.
- Rat King v1: nano leads. Every lesson is scored before nano learns from it; the BOND line is the score with the best balance of hits and catches over the last 7 days, WATCH where the bond rate is twice the base rate. v0's rules stay on the card, and a coin born from a 100k+ post keeps a v0 BOND. v1 takes over by itself once 1,500 lessons and 15 bonds are graded.
- Faster learning: each bond lesson now counts as much as the misses around it (class weighting up to 50x instead of a fixed 8x). Four new features: born from a post, the post author's reach, links the post itself, the narrative's pace.
- Honest scoreboard on /lab: BOND calls graded at the 2-hour label only (no pending), per King version, and how many of all bonds were caught.
- Menu fixed (desktop and mobile): clicking a menu title no longer closes the dropdown under the mouse; links to the page you are already on (Hall of fame from /king, Runners, the mobile sheet) now switch the tab, scroll, or close the menu instead of doing nothing; a thin progress bar and a loading screen show at once on every click while the next page loads.
- Links: every link points at www.ratnet.network (README, API docs, the X webhook, the site's own fallback URL).
- Public pages no longer carry the numbers behind a call (v0 points, nano pulls).
- Sim (5h and 9h, stand-in model): MIND judged 151 and 270 coins, its SEND calls traded by the desk; King v1 took over once its lines were calibrated (9h: v1 BOND calls 15.3% right at 2h vs 11.9% for v0.3, synthetic market); the picker learned from 5 posts; 0 errors. Post-mortems, school and teach checked in sim/mindtest.ts.


## v0.1.9 · LENS, scorecards, a private playbook
- Trade buttons on every coin, everywhere pump.fun used to be the only link: GMGN, Axiom, FOMO, pump.fun and DexScreener (the old "chart" button), each with its logo. Referral codes per venue are set in admin (trade buttons panel), with editable link templates; empty code = plain link. Buy $RAT uses the pump.fun link with your code.
- LENS (18th agent): the hands-on look. For every desk buy, tweet pick, BOND call and launch named after a rising narrative it opens the website (loads? shows this CA? links the same X? builder? domain age via RDAP), the X account or the post the coin is tied to (followers, age, posts, blue, WIRE trust), searches X for the CA and ticker (who posted it in the last hour, reach, trusted accounts, shill-bot pattern) and reads the Telegram member count. Writes a 0-100 dossier with red flags and good signs. Up to 60 an hour, newest and most important first.
- LensCam: LENS's browser streamed live on /desk (tabs, address bar, the page it is reading, its checklist ticking off), the latest dossiers under it, and the full dossier on every coin page.
- Scorecard on every trade and coin page: the reasons for and against, and the LENS read. Admins also see the numbers behind them: King v0 points per rule and nano's strongest feature pulls.
- New prior has_socials: a coin with no X, website or Telegram is skipped, unless it is tied to a tweet or 2+ smart wallets bought early. Not a hard cap: every skipped coin is followed in shadow and COACH overrules the prior when those coins do better than the ones bought (same as holding_floor). FILM grades it like every other rule.
- Feedback (admin only): good or bad, tags (no socials, bought the top, sold too early...) and a note on any trade, call or skip, from the trade view or the coin page. Tallied in the Strategy tab.
- Admin Strategy tab: the whole playbook on one page. Priors and what COACH made of them, every desk rule, what the desk learned (trail scale, entry arms, unlocks), King rules, nano weights, FILM grades per rule, PM sleeves, COACH follow-ups, WIRE's accounts and your feedback.
- The playbook is private: public pages no longer show desk thresholds, learned stats, FILM rule grades, check values or nano weights. Signed in to admin, the same pages show everything (admin answers are never cached). Trades still show why they were taken.
- Sim (3h): socials prior reviewed 40 skipped coins (avg -13% in 30m vs +34% bought), stays on. 0 errors.


## v0.1.8 · The ghost desk
- Ghost desk: every signal that passes every check on the coin but is blocked only by the desk itself (daily loss limit, full slots, a strategy paused by PM, no paper balance left) is traded anyway in a separate book: same entry, same exit rules, fixed 0.1 SOL, up to 10 open. Ghost trades never touch the balance, the exam or the track record. COACH (exit reviews and follow-ups 5m to 7d), the dev-sell prior and the entry shadows learn from them; PM lets a paused strategy back in early when its last 4 ghost trades made money.
- Track record: a "ghost" tab with every ghost trade in full detail (same trade view as real trades).
- Desk: a banner when the daily loss limit is hit, with how many signals the ghost desk is following.
- Exam: the drawdown check now covers the last 30 trades instead of all time, so one bad stretch can't lock the exam forever. The daily loss limit (25%) stays as it is.
- Sim with a 3% loss limit: the ghost desk took 37 trades the real desk was blocked from, 0 errors.

## v0.1.7 · The film room
- PULSE warm-up: needs 3 hours of history before it calls anything rising (on the first night every topic looked like it was rising), at least 8 weighted posts in 15 minutes, and a longer list of common words it ignores (have, says, today, people...). The desk shows when it will be ready.
- WIRE (15th agent): tracks X accounts whose posts spawn coins (seed list of 52: leaders, Elon and his orbit, founders, KOLs, news), via twitterapi.io webhooks. Every launch is matched against the last hour of posts (links the post, ticker or name), 30 seconds later the leader among the copies is picked, its tape read, farms dropped, and it goes to the desk as its own strategy for trusted accounts. Trust per account is learned from results; the list grows by itself (authors of posts that bonded coins link to, accounts the tracked ones amplify) and mutes dead accounts. Coin pages show the post a coin was born from. King v0.3: +8 for a coin born from a tracked post. Sim: 10 posts, 41 tweet coins, every one matched, the leader picked once per post.
- J7Tracker feed for WIRE: J7's main list, its free shared pool (added to the feed hourly), Truth Social, Instagram, TikTok and YouTube, and contract addresses detected in posts. A tracked account posting the CA of a coin the rats know sends it to the desk at once. twitterapi.io now only covers accounts J7 doesn't. Every account on the feed gets its own trust score.
- PULSE (17th agent): rising narratives on X, minute by minute, weighted by reach, with a mood per narrative. King v0.3 adds +5 for a launch named after one.
- PM (16th agent): the desk runs King calls, early reads and tweet coins as separate sleeves, each sized by its own risk-adjusted record, with a 2-hour brake after a bad run. Tweet coins get their own 2 slots.
- Bot coins (King v0.2): 3 or fewer wallets trading, wash loops and micro-buys now count as farms (45-point penalty, never sent to the desk). Tape reads go to minute-5 calls first, and no coin reaches the desk without its trades read. Sim: every bot coin that was read was flagged, 0 of 66 real bonds wrongly flagged, 0 bot coins or farms bought.
- Track record in full: every trade shows entry and exit market cap, change, peak while held, coin age at the buy, curve at the buy, market cap at the call, call-to-buy time, price vs the call, every VET check with its value, what the rats saw (trades, traders, bundle, snipers, dev, funder, smart wallets, socials), FLOW and BUZZ at entry, the chart and every fill with its market cap.
- Coin pages: "the desk on this coin" with every trade in full, the last VET verdict with every check, and every line the agents wrote about the coin.
- Why this call: the strongest reasons for and against every call, on coin pages and call lists.
- COACH follows every closed trade 5m, 15m, 1h, 2h, 6h, 1d and 7d after the exit, and when a coin ran 50%+ past the exit it records what was behind it (migration, a big single buy, a volume wave, paid DexScreener promotion, X posts). Shown per trade and as a table on /desk.
- FILM, the 14th agent: the film room. Every King call meets its outcome (bonds the King didn't call are logged as misses, BOND calls that died as false BONDs) and every reason the King gave is scored. Every VET, FLOW and never-chase skip is followed 30m, 2h and 24h later and graded per rule: right, missed a run, average move, verdict.
- Priors (starting hints, not laws): holding_floor skips coins 40%+ under their high since launch; dev_exit is off on memes, so the desk holds through dev sells. Every case is followed in shadow and COACH switches each prior by itself when the data disagrees.
- SIZE caps every buy by the coin's liquidity (max 6% price impact on the curve), so the desk scales without aping into tiny coins.
- On-chain receipts: every hour the SHA-256 of all counted calls is written on-chain in a memo. /receipts verifies it in the browser; each call links to its receipt.
- Hall of fame: the BOND calls that ran furthest from the call, on the homepage and the King page; share cards show the call-to-peak multiple.
- Telegram call channel (optional): every counted King BOND call posted the moment it lands, and again when it bonds.
- Pre-launch: "$RAT is not live, the CA will only be posted on @Ratnetdev" on every page. The hit rate shows the date the clean record started.

## v0.1.6 · Fair rounds, steady desk
- Earning rules (Crawlnet-proven): the bag that counts is the LOWEST $RAT held during the round (sampled every 5 minutes, burns added back), so buying right before the close adds nothing. Multipliers are linear between the tiers (no cliffs). Every next rat from the same wallet costs 30% less (70,000).
- Pups: 25,000 $RAT, ride with an adult rat (pick one or auto), paid whenever their rat is paid at ×0.25 weight; 80% to the pup's owner, 20% to the rat's owner. 1,000 in total. Spawn page has rat/pup tabs, the earnings table has a pup row, rules and README updated.
- Payouts credit every rat and pup with exactly what it earned (used for the 2x cap), instead of an even split per owner.
- RPC limiter rebuilt: strict rolling 1-second window with headroom (never a burst over the plan), batched requests counted per call (how Helius counts), three lanes: desk, then dig, then historian (max 40%).
- The desk no longer waits for the dig: positions keep their 2-second beat while the rats dig next to it. Wallet balance read every 15s instead of every beat.
- Trade reads scaled to the RPC plan: 2 coins per dig with a smaller sample on Helius free (10/s), up to 12 with the full sample from 50/s.
- Desk cards: an error older than 10 minutes fades to a muted "earlier" note instead of staying red, and LEDGER logs "back to normal" when the desk recovers from an error.
- Header: X button shows only the X logo.
- Homepage: guaranteed gap under the burn bar.
- Tests: sim/payout.ts (all earning rules), sim/limiter.ts (rate, lanes).
- Calls fixed (why the King hit rate and BOND calls stayed at 0): the minute-5 checkpoints were read oldest first, so with a backlog every call landed far past the 15-minute window and none counted. Checkpoints are now read freshest first; anything too old to count is skipped and shown as "missed (rats behind)" next to the hit rate instead of clogging the queue.
- Homepage: Rat King panel with a "BOND calls" tab (default) next to "all calls". Every counted BOND call shows the second it lands.
- Track record: every paper (and later live) trade as a round trip on the homepage and /desk: return, trades closed, win rate, realized SOL, best/worst, average hold. Click a trade on /desk for the call behind it, entry type, peak while held, exit, what was left on the table, a price chart with the entry line, sells and peak, and every fill with its reason (Solscan link when live).
- Agents: click any of the 13 desk agents for its own panel: what it does and the rules it works by, what it is doing right now, actions today and all time, good vs bad outcomes, a 24-hour activity chart and its full history with links to the coins.
- Alerts: moved to the top right, under the header, with padding on every side and safe-area insets, on every screen size. Root cause of the glitch: the newest alert used the same class name as the sticky header, so it was pinned behind it.

## v0.1.5 · Clean track
- Graduation proof: a coin counts as BONDED only when it migrated into its canonical PumpSwap pool (the pool only pump.fun's migration can create). Full curves that never migrate are resolved as not bonded after 30 minutes and are never learned. This removes the false graduations of v0.1.4 (coins showing a $10 market cap as "bonded").
- Market caps straight from the chain: curve account for coins on the curve, canonical pool vaults for graduated coins (one RPC call per 50 coins). Runner peaks, coin pages, radar and the desk all use it. DexScreener only adds volume and flow, fetched in parallel with a 2.5s cap, and junk side pools are filtered out.
- Real numbers: a market cap under $1,000 is shown as it is ($10), never rounded up to "$1K".
- Clean data reset (runs once on deploy): scoreboard, models, wallet and cluster records, runner and historian state are wiped and relearned with the migration proof. Stored coin records with a false graduation are relabelled in the background. Rats, litters, burns, rounds, sniffs, settings and the desk wallet are untouched.
- Historian: same proof for past launches, post-bond candles from the canonical pool only.
- RPC rate limiter shared by the desk, the rats and the historian (RPC_RPS, default 10). Desk and dig first, historian on spare capacity, automatic backoff on 429. A failed beat no longer ends the desk session, which was why the early-read counters and the desk stayed at 0.
- Desk: signals older than 3 minutes are dropped quietly and the newest calls are vetted first. Normal skips are shown as neutral "skipped" lines instead of red errors.
- Desk "right now" panel: the three steps (paper trading, exam, own wallet), what the desk is doing this moment, today's checked and passed signals with the top reasons for skipping, what is still needed to pass the exam, and the background learning (historian replay, nano, minute-1 entries, pullback entries).
- Positions in a coin whose curve completed but never migrated are written off after 30 minutes instead of hanging.
- Alerts: the newest alert shows in full, older ones collapse to one line (click to bring back), and the stack always fits inside the screen.
- Homepage: space between the burn bar and the stats.
- Live fee pool: $RAT creator fees are read straight from pump.fun's fee vaults (curve vault before bond, PumpSwap vault after), every 30s. "This round's pool so far" and an estimate per rat show on the homepage, Spawn and Ledger while the round fills. Claims mid-round are carried, fees from before the round never count.
- Spawn page: "what a rat earns this round" table per bag size (multiplier, SOL by close, SOL a day, days to pay back the spawn) and the rules in one list (price, work, bag, cap, share, pool, sniff).
- Ledger: money flow from creator fees to the 60/40 split, this round's pool, owners paid (wallets, rounds) and a spawn entry.
- Phones: app-style bottom tab bar (feed, coins with a live count, king, desk with its live/paper dot, spawn).
- Every page opens with its terminal command line (~/ratnet ❯ radar --live, desk status --live, ...), matching the homepage.
- Fee tracker test (sim/fees.ts): accrual, a claim that empties the vault, more fees after bond.
- Simulators: ghost coins (full curve, no migration), canonical pools with vaults, and junk side pools; desk sim confirms 0 of 107 ghosts counted and 286 of 286 real graduations detected; historian sim confirms 0 of 33 ghosts learned with a clean leak check.

## v0.1.4 · The learning desk
- HISTORIAN: replays past pump.fun launches in time order (default 14 days) and trains every model before live data piles up. Rebuilds minute 1 and minute 5 from on-chain history only, credits records only when the replay clock reaches them, scores each launch before learning it (honest backtest in the Lab).
- TAPE: reads the trades on every coin that is moving: trade speed, unique traders, SOL per buy, buy share, bundle wallets, snipers, top-5 concentration, dev sells.
- GRAPH: traces each dev to the wallet that funded it and scores that funder's record; learns smart wallets from scratch (wallets that keep getting in early on coins that bond or hit $1M).
- META: hot narrative of the moment and a copycat flag.
- BUZZ: X mentions of the CA (optional X_BEARER_TOKEN) and paid DexScreener boosts/profiles.
- Early read at minute 1 with its own model and scoreboard. The desk may trade it only after its record beats the minute-5 King.
- Nano grows from 14 to 28 features. Every lesson waits for one 2-hour label so fast winners can't fool the models.
- Runner model: follows every bond for 7 days and learns P(next market cap milestone) from $25K to $50M.
- Post-bond visibility: peak market cap, market cap at the King's call and the multiple, on graduations, coin pages and a new Runners board.
- Exits rebuilt: initials at 2x, 20% moonbag, milestone ladder only when P(next) is weak, trailing stop that widens from 30% to 50% as the coin runs, instant exit when the dev or insiders dump (their bags are read every 4s), smart migration rule.
- Entries: never chase (+60% over the call means wait), bundle, cluster and copycat checks, pullback entries that unlock only when proven in shadow.
- COACH: reviews every exit and every entry and retunes trails and entries from what really happened.
- Desk grows to thirteen agents; new "what the desk learned" and stalking panels; tape and graph panels on coin pages.
- The paper desk mirrors the real desk wallet: on first sight it restarts from the wallet's actual balance, deposits and withdrawals move the start line instead of counting as profit, and the wallet with its balance is shown on /desk.
- X handle @Ratnetdev set as the default X link and on share cards. No domain needed: the site falls back to the Vercel production URL.
- /api/desk/run answers the pinger instantly and keeps working in the background (Vercel waitUntil), so cron-job.org never times out. Add &wait=1 to see the full result.
- FARM detector: block-0 bundle that pumps the curve with no organic buyers after it, bundle-run coins, and volume-bot trading (same wallets, same sizes). Farms take a 45-point penalty in the King's score (v0.1), are tagged FARM in the feed, and never reach the desk. Real block-0 launches with organic buyers pass. The same signals are nano features.
- Faster learning: experience replay of recent lessons every run, and market-shift detection (recent loss vs long-run) that raises the learning rate 2.5x for 400 lessons.
- Seasons: every lesson carries its regime (SOL 24h and 7d trend, pump.fun launch rate). Season panel in the Lab.
- HISTORIAN now walks backwards: today first, then yesterday, and so on (default 30 days). Older lessons weigh less (21-day half-life). Record features are masked in replayed lessons, so walking backwards never leaks the future.
- Homepage: "self-trading agent, in training" banner with live exam progress and the wallet it will take over.
- Alerts rebuilt as trade cards: King and nano score rings, market cap, 5m change, volume, traders, live curve, smart-wallet/dev/bundle/farm flags, one-click buy on GMGN, BullX, pump.fun or DexScreener, copy CA, keyboard shortcuts (B, C, O, P, Esc), pin, hover to hold, desk-buy alerts.
- Header: X button (@Ratnetdev) next to search. Menu rebuilt: Feed and Desk (with a live/training dot) up front, then Coins, Rat King, Rats and Docs as dropdowns where every item says what it does. On mobile a full-screen menu with the same groups and a Follow on X button.
- Explainers everywhere: every panel title, stat, table column and desk rule has a small info mark with a plain-language explanation (about 190 across coin pages, desk, Lab, Calls, Explore, Radar, Rats, Ledger, Dataset, Sniff and alerts). Hover on desktop, tap on mobile; the popup floats above tables so it is never cut off.
- Homepage burn economy, like Crawlnet: a strip under the hero (rat owners split 40% of all fees every 12h, live round countdown, last round pool and per-rat payout, spawn cost, Buy and Spawn buttons) and an "own a rat" section (burn, dig, earn in 3 steps, 60/40 fee split, round countdown, paid to owners, rats alive, $RAT burned, litter progress, bag multipliers, earn cap, sniff option).
- /api/rats also returns the last payout round, total paid to owners and the $RAT mint.
- Simulators: full desk market (bundles, rugs, factory devs, smart wallets, power-law runners) and a historian replay with a look-ahead leakage check.

## v0.1.3 · The Desk
- The Desk (/desk): eight agents (Scout, King, Vet, Flow, Size, Exec, Risk, Ledger) turn King BOND calls into trades, every step shown live.
- Agent cards with each agent's last move, the Den scene where the rats work, speech bubbles and a coin rolling down the pipeline on every buy.
- Fast loop: positions re-read from the bonding curve every 2 seconds; exits on take profit, stop loss, graduation, time stop, or when sellers drain the curve.
- Flow check before every buy: live curve pressure over 3 seconds plus the last hour of buys vs sells.
- Paper first, then the live exam: the desk promotes itself to the funded wallet once it passes every check, and demotes itself back to paper at -40%.
- Balance chart, open positions with live mini charts, trade log (Solscan links when live), and desk.config.ts showing every rule plus how the last coin scored on each.
- One cron (/api/desk/run every minute) now runs both the desk and the rats.
- Admin: desk config, close all, reset.
- New README: full public documentation of the project (architecture, rats, launch lifecycle, Rat King v0 and nano, public metrics, the Desk and its exam, economy, tokenomics, dataset schema, open API, roadmap, self-hosting) with diagrams in docs/assets.
- New Rat King pixel mark as the site icon.

## v0.1.2 · Rat Cam hero, alerts, market data
- Home hero rebuilt: headline on the left, a large live Rat Cam on the right with a bigger tunnel, a longer terminal and a colour legend.
- Two live proof numbers under the headline: how many times more often King BOND calls graduate than random, and the average head start before graduation.
- Hover "?" tooltips on every key term and panel instead of extra text.
- Alerts: bell in the header, sound and popup when the King or nano calls BOND, a coin nears graduation or graduates. Volume, desktop notifications, tab badges.
- Market data: market cap, 5m/1h/24h volume, price change, liquidity and buy/sell flow on coin pages, the Radar and Explore.
- Search: press / or Cmd+K anywhere to jump to any coin, CA or page.
- Graduations show how long before graduation the King called BOND; coin pages too.
- King page: graduation rate per score bucket (v0 and nano) and a 24h hit rate vs random chart.
- Nano now also learns from coins that graduated before the 5-minute call.
- Animated counters, one shared live connection for the whole app.

## v0.1.1 · Real-time engine, Rat King nano, Rat Cam, Explore
- Hot watch: filling curves re-checked every run, graduations detected within seconds.
- Radar page and live graduations list.
- Dev memory: launches and bonds per creator on every coin, radar row and sniff report.
- Rat King nano: model learning from scratch on every outcome, public loss curve and weights in the Lab.
- Early DIED rule at the 1h check, honest hit rate and base rate formulas.
- Coin pages with X share cards, open API page, tunnels on the dataset page, top rats leaderboard.
- CDN caching on all public reads.
- Rat Cam: live corner terminal with a pixel rat digging a tunnel. Every launch, King call and graduation streams in as it happens, each line links to the coin.
- Explore page: every coin the King or nano rated BOND or WATCH in the last 24h, plus every bond. Filter by King call, min score, nano call, King + nano agree, outcome, dev record, socials, time window and search. Sort by newest, King score, nano score, live curve, peak or fastest bond. Shows how often each filter actually bonded. Filters live in the URL.
- One-click presets: King says BOND, King + nano agree, Climbing now, Graduated, Fastest bonds, King missed it.
- New 24h coin index maintained by the rats, served from one CDN-cached endpoint (/api/coins).

## v0.1.0 · Launch MVP
- Rats dig every pump.fun launch live, checkpoints at 5m, 1h and 24h.
- Rat King v0 transparent scorer with public hit rate.
- Spawn rats and sniff orders by burning $RAT, verified on chain.
- 12h payout rounds, ledger, daily dataset drops, admin panel.
