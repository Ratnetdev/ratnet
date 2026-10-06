# Changelog

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
