# Changelog

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
