# Changelog

## v0.1.39 · Platform and final verification (Run 8)
- Next.js 15.5 and React 19 (was Next 14 and React 18): admin checks read cookies the new async way, dynamic routes take their params async, ref and JSX types updated. Every page and API route checked after the upgrade.
- The paper desk resets once on deploy for the final verification (never while live): the old record is archived, everything learned is kept, and strategies paused before the reset start unpaused.
- Safer outside fetches: the connection itself now refuses private and internal addresses, so a hostile DNS server can no longer pass the first check with a public address and connect to a private one (DNS rebinding).
- Redis: every growing key has a limit. Daily stat hashes expire after 120 days, the per-post copy sets after 3 days, and the LENS and MIND queues keep their 300 most urgent coins (they could only grow while X credits ran out).
- A real "page not found" page with a way back (it was Next's plain 404 text).
- API docs list /api/boards, /api/desk/record and /api/px. README updated for the current setup: price feed, paced budget and lane limits, the X hard cap, X_RULE_FILTER, BACKFILL_MS, PUMPPORTAL_API_KEY and what runs without it.
- Verified locally: 16 pages on desktop and phone width (no errors, nothing wider than the screen), every GET API route (no 500s), admin login and full views, all 29 test suites.

## v0.1.38 · Speed and consistency (Run 7)
- Polling diet (lib usePoll):
  - components asking for the same data share one request and one answer (the desk page asked /api/desk, /api/rats and /api/king two or three times over);
  - nothing polls faster than every 5 seconds (LENS was 1.5s, MIND 2.5s, FLASH and the radar 3s);
  - FLASH, CATCH, MOMO, MIND, HOUND and LENS stop polling while they are off-screen;
  - every request has a 10-second timeout and is cancelled when nothing shows it any more; a page never shows the previous page's data;
  - a "data paused · reconnecting" chip appears when answers stop, so frozen numbers never pass for live ones.
- One request for every agent board: FLASH, CATCH, the BOARD, MOMO, MIND, HOUND and LENS come from /api/boards (built every 3s, cached 3s for all viewers). They were seven requests per viewer on their own timers. The old endpoints stay for the API docs and the admin views.
- Site prices from the worker: /api/px reads the worker's price cache and notes which coins viewers want; the worker prices them on its budgeted lane (at most every 8s per coin). Vercel no longer reads the chain for page prices (those reads used the same Helius key, outside the daily budget). A coin not priced yet shows DexScreener's price for a few seconds. The browser's PumpPortal trade socket is off (PumpPortal sends trades only to a funded key); pages refresh prices every 4s.
- Numbers show as they are on first load (they used to roll up from 0 on every page load).
- The Den and the Rat Cam stop drawing when they are off-screen or the tab is in the background; the Den is capped at ~30 frames a second.
- One format for every number: USD and market caps ($950, $12.4K, $1.25M), SOL, signed percents; fill times say UTC. Six private copies of the USD formatter are gone.
- Tables: every numeric column is right-aligned automatically, on every page.
- Navigation: the phone tab bar now has the same order and names as the top menu (feed, desk, coins, king, rats); Receipts and Status count as King pages. The desk page has a section bar (right now, record, balance, agents, signals, den, film room) that stays under the header.
- The "right now" panel no longer runs wider than a phone screen.
- One King call per coin: each call claims the coin in Redis first, so two passes can no longer both call it (the King called $FLY twice within 4 seconds on 7 Oct).
- Redis diet: the rats' fast lane reads the models every 15s, the calibration every 60s and the epoch every 5 minutes instead of every second; the SOL price is written once an hour instead of every pass; settings are read at most every 3s per process; the desk heartbeat is written every 5s instead of every beat.

## v0.1.37 · Hotfix: honest track record, lighter desk reads
- Track record P&L now matches the balance:
  - a trade's cost includes the tip, priority fee, base fee and token-account rent (it counted only the size). On 8 Oct the record showed +0.009 SOL realized and 33% wins while the balance was down 3.9%; with the fees counted it was -0.016 SOL and 22%, the same as the exam;
  - an open position is valued at what selling it would bring after every cost (the balance's own rule), not at the mid price;
  - older trades take their cost from their own sells, so the history is corrected too; buys now store their full cost.
- Desk panel: "Why no new buys" explains the paced budget (reads are spread evenly over 24 hours, the rats resume within minutes); the historian shows when it waits for the budget; minute-1 entries say "not better than minute 5 yet" instead of "1490 / 50 reads".
- Desk chain reads in three speeds: positions and buy candidates as before (live feed, chain at most every 2s), pullback and re-entry watches every 5s, learning reviews every 30s. They were all read every 2s: about 1.4 reads a second, 40% of the plan's daily share, for the desk alone.

## v0.1.36 · Phone and UI foundations (Run 6)
- Track record:
  - phones: a card per trade (coin, P&L in SOL and %, entry to exit market cap, change, when, how long, why it exited). Tap a card for the full trade detail at full width. A sort menu replaces the column headers;
  - desktop: no more scroll box inside the page (it scrolled both ways). 50 trades at a time with "show more", the coin column stays in view, numbers right-aligned in fixed-width digits;
  - a live market cap keeps its width when the live dot comes or goes (columns no longer jump every few seconds).
- Every wide table (radar, explore, runners, grads, ledger, rats, desk): the first column stays put while the table scrolls sideways. On phones no inner scroll boxes: the page scrolls, tables only sideways.
- Stability: the Rat Cam, alerts, CA bar and tab bar each sit in their own error boundary, and a bad /api/live answer never replaces the last good one. A trade with a missing time or field no longer crashes the page; its detail says it could not be drawn.
- Phones:
  - CA bar shows the short address with a copy button;
  - inputs and selects at 16px (iOS no longer zooms in on tap);
  - buttons at least 44px tall, header buttons 40px, the LIVE dot 44px;
  - every label at least 12px;
  - the Rat Cam sits above the tab bar; panel headers wrap instead of squeezing;
  - viewport-fit cover with safe-area insets; menus and popups never scroll the page behind them; alerts popup has a max height.
- Desk "right now" panel: a "Why no new buys" box says what is holding buys back, in plain words: King calls paused by the day's chain budget, or a strategy paused by PM after a bad run (until when, and that the ghost desk takes its signals meanwhile). On 8 Oct both happened at once and the desk looked dead with no reason shown.
- Chain budget:
  - the rats' chain backfill (launches the stream missed) runs every 10 seconds instead of every second (~78K credits a day saved; the stream delivers nearly every launch within a second). BACKFILL_MS changes it;
  - launches older than 10 minutes are never back-read (past their minute-1 read and minute-5 call). At 00:00 UTC on 8 Oct the rats read the whole night's gap and used the day's head start in 9 minutes (10.8K credits), then paused again;
  - the historian stops at 75% of the day's pace and the agents at 95% (were 90% and 100%), so King calls keep their room;
  - /status, Chain reads: the top RPC methods per lane this hour, so a lane that eats the budget shows what it does.
- Accessibility: visible keyboard focus on every control, brighter secondary text (dim 5.4:1, hints 3.4:1, were 4.3:1 and 2.0:1), reduced motion respected (CSS animations, number roll, Den and Rat Cam canvases), charts let the page scroll vertically on touch and clear their tooltip after a tap.

## v0.1.35 · Hotfix: the X budget is enforced
- The cause: X_CREDITS_PER_HOUR only limited RATNET's own reads. twitterapi.io bills the filter rules on its side (15 credits per check, 15 per post they return), so with the budget at 10K an hour the account still spent ~45K: 9 rules checked every minute (8.1K) and ~2,400 posts an hour from 104 accounts.
- Hard cap: once this hour's spend reaches the budget, every paid rule is switched off until the next UTC hour (J7 keeps watching for free). A rule that will not switch off is deleted and rebuilt the next hour. WIRE posts when it happens.
- The paid list is sized on real costs: the webhook counts posts per account per hour, the rules may use ~60% of the budget, and accounts posting more than 20 times an hour that never led to a pick are left to J7.
- Rules leave reposts out (-is:retweet, change with X_RULE_FILTER). Reposts are billed like posts and carry nothing to make a coin from.
- The rules resync on their own when the budget changes and every 6 hours.
- /status:
  - X reads: shows when the budget is reached and what the rules are expected to cost;
  - Live stream: no warning for missing trades without a PumpPortal key (that is the plan since v0.1.34); shows the price feed's accounts and prices;
  - Chain budget: says which lanes wait and when it resets;
  - Desk heartbeat: describes how positions are priced now.

## v0.1.34 · Hotfix: fits the Helius plan
- The cause: following launches through Helius transaction messages cost 1.3M to 5.7M credits a day (~50 KB per message). The plan's daily share is ~330K. On 7 Oct the day's budget ran out by evening and the rats, agents and historian stood still until midnight UTC.
- The Helius feed now prices open positions only, real and ghost, through account updates:
  - a coin on the curve: its curve account; a migrated coin: its canonical pool's two vaults;
  - one update is ~340 bytes (was ~50 KB), sent only when the price moves;
  - a pool price is taken only when both vaults are from the same slot (no half-updated swaps);
  - while the feed follows a coin, no update means the same price: the desk uses it up to a minute, and checks the chain every 15 seconds.
- The desk reads a position from the chain at most every 2 seconds (every beat used to read every position, ~370K credits a day alone). Right before a buy the chain is always read.
- Transactions are asked for as version 1 directly. Trying version 0 first cost a refused, billed call on every version 1 transaction (509K errors on Helius in one day).
- Launch tapes come from the chain, so the rats read trades only for launches with at least 8% of the curve at minute 5 and 5% at minute 1 (was 5% and 3%). Saved settings below that are lifted. The historian uses the same floors, so the models learn on what live sees.
- FLASH pauses while no trade messages arrive (it read launches from trades alone, and a launch with no trades would be learned as dead). It comes back by itself with a PumpPortal key.
- /status: the Live stream tile shows the feed's accounts followed, prices received and credits a day.

## v0.1.33 · Live-safe execution and scam walls (Run 5)
- Signing:
  - every swap is checked before the key touches it, with every address resolved through the lookup tables;
  - SOL may only go to a Jito tip account or the wallet's own wSOL account;
  - top-level token instructions may only sync, open or close the wallet's own accounts (no transfers, approvals or authority changes);
  - associated accounts may only be created for the wallet;
  - the swap's output must land in the wallet's own account.
- Books from the chain: a live buy books the tokens received and the SOL really spent (tip, fees and rent included); a live sell books the SOL really received. Jupiter's quote is only a fallback.
- A pending record is written before every live swap. While one is unsettled no new buy is made, and the wallet check settles it.
- Wallet check (live): every balance read tells deposits and withdrawals apart from trades (they move the drawdown baseline, not the P&L). Every 5 minutes the wallet's tokens are compared with the open positions: a position the wallet no longer holds is closed, a wrong amount is corrected, unknown tokens are reported.
- A failed balance read keeps the last good balance. It used to read as 0, which looked like a -100% wallet and demoted the desk.
- The wallet key works on the worker only. Vercel ignores DESK_WALLET_SECRET (unless DESK_ON_VERCEL=1). A process without the key never "sells" a live position on paper and never buys while live.
- FLASH scam walls from the first seconds of trades: share bought in the first 2 seconds, top-3 buyers' share, number of wallets, dev holding. A check that could not be read counts as failed.
- FLASH's label is now "doubled from the look and still held it at one hour" (it was "bonded within an hour", which rewarded coins that bonded and then dumped below the entry). Its record starts over; the old one is kept.
- Webhooks:
  - the X hook accepts twitterapi.io's X-API-Key header or an own X_HOOK_SECRET, no longer a key derived from CRON_SECRET (a forged post could make WIRE buy). Refused calls are counted on /status;
  - the Telegram bot takes commands only from TELEGRAM_ADMIN_IDS.
- Trade feed cost: following every hot coin was ~300 trades a second (~5M credits a day). The feed now follows open positions, every launch for its first ~100 seconds, and a launch up to its minute-5 tape only once its curve has ~3% in it. When the day runs ahead of pace, only positions and first seconds. /status shows the feed's credits a day.
- Track record: the Opened, Entry MC, Exit / now MC, Change, P&L and Held columns sort on click (newest or largest first, click again to reverse).
- The live feed and alert popups no longer cover the page:
  - on screens 1880px and wider they dock in the empty margins (live feed right, alerts left);
  - on smaller screens the live feed starts as the small LIVE dot (remembered), and one compact alert sits at the bottom.

## v0.1.32 · Hotfix: trade feed from Helius
- PumpPortal now streams trades only to a funded API key: "'subscribeTokenTrade' and 'subscribeAccountTrade' methods are only available when connecting with an API key funded with at least 0.02 SOL", at 0.01 SOL per 10,000 messages (about 1 SOL a day for what RATNET follows). Since that change no trades arrived: stream tapes held only the dev's buy, the desk had no stream prices, and FLASH and CATCH's live tape were blind.
- New trade feed (lib/heliusfeed.ts) on the Helius plan already paid for:
  - one websocket, one transactionSubscribe for every followed coin's bonding curve and canonical PumpSwap pool;
  - small messages (keys and balances only);
  - each transaction becomes the same trade message as before (side, SOL, tokens, trader, curve reserves, market cap), so tapes, desk prices, FLASH and CATCH work unchanged;
  - a new launch is added to the feed within a second;
  - the feed's data is billed by Helius by volume (2 credits per 0.1 MB) and counted against the day's budget on /status.
- PumpPortal still brings launches and migrations (free). With PUMPPORTAL_API_KEY set, PumpPortal streams the trades instead.
- /status: the Live stream tile shows the feed (up or down, addresses followed, trades received, any error).

## v0.1.31 · Honest paper desk (Run 4)
- Paper pays what live pays (lib/costs.ts), in the real desk, the ghost desk and the exit lab:
  - venue fee 1.25% on the curve, PumpSwap's market-cap tiers after migration (1.25% down to 0.30%);
  - Jito tip, priority fee (paperPrioritySol, 0.0005 SOL) and base fee on every transaction;
  - token-account rent on the buy, refunded on the full exit (live now closes the empty account);
  - slippage from the trade's size against the curve or pool, plus a 1% latency slip, on buys and sells.
  Before: a flat 1% fee and 2% slip per side, no fixed costs. At 0.05 SOL a curve round trip really costs ~8%.
- Fills at a fresh price read after VET, SHIELD, FLOW and BUZZ. A coin that ran past the slippage limit during the checks is not chased, and a paper buy past the limit is refused, as live would be.
- The exam, on one window (the last 30 round trips):
  - realized profit after every cost;
  - profit factor without the best trade (one 10x can no longer pass it alone);
  - win rate and worst drawdown on the same 30.
  Equity is the liquidation value of the bags, after costs, not the mid price.
- False prints: a stream price more than 3x away from the last chain read is not used until the chain confirms it. On 7 Oct a ghost position "sold" $XP at ~1,400x on a side-pool print (a $1.7B wick). That trade is removed from the exit lab, PM and the ghost record.
- DexScreener prices (fallback only) never count as a migration and are never learned from. Shadows, COACH's after-exit paths, COACH and FILM follow-ups tell "no read" (tried again) apart from "dead" (the chain says so). A failed read used to be scored as -100%.
- Learning switches flip only on evidence, with hysteresis:
  - dev and sell-off exits: Wilson interval;
  - priors: two-sample t (1.5 to overrule, 1.0 to restore);
  - pullback and early entries: a lower bar to stay on than to switch on.
  Dev-sell and sell-off moments are scored the same way whether the desk sold or held: the price 30 minutes later.
- COACH's after-exit review waits for a 2x or the full window. A 40% dip used to decide it ($FLY: "exit held up", then +688%). The trail steps the same size both ways.
- Exit lab:
  - every replay pays the trade's costs;
  - it re-learns only on new paths;
  - a new setting must also win on the newest third of paths, held out;
  - it alone owns the trail once it has learned a bucket.
- $FLY findings:
  - The King's BOND 99 call was skipped at 74% curve ("curve window"). That limit is now a learned prior (curve_not_late), followed in shadow.
  - MOMO stops sit outside the coin's own last-minute swing for the first 10 minutes (1.2x, up to -45%; default -25%).
  - A MOMO or King trade stopped out is bought back once if the coin reclaims its entry within 30 minutes. Re-entries switch themselves off if their last 20 average below zero.
- Ops:
  - settings from the admin apply within 5 seconds;
  - close-all stays on until the book is empty;
  - a reset stops a running desk session before it can write old books back.
- Redis: a position's price path is its own append-only list. The position is written without it.
- The paper desk resets once (under the desk lock, never while live). The old track record is archived. Everything learned is kept.
- Stream trades: since v0.1.28, tapes have come from the PumpPortal stream's trades. On 7 Oct the stream delivered launches but no trades, so every stream tape held just the dev's buy ("1 trade, 1 trader") and the King scored launches on an empty picture. Now:
  - with no trade message in the last minute, stream tapes are refused and the chain is read instead;
  - /status shows when the last trade arrived, PumpPortal's own notices, and the field names of the messages it sends (to see a format change);
  - parsing tolerates a renamed type or signature field, and a launch without its signature is still stored;
  - PUMPPORTAL_API_KEY (optional) connects to PumpPortal's keyed stream.

## v0.1.30 · Hotfix: version 1 transactions
- Since early October most pump.fun creates and many trades are version 1 transactions. web3.js only asks for version 0, so the RPC refused them ("Transaction version (1) is not supported"). Every one of them was lost or retried:
  - the rats' backfill failed on ~2 of 3 launches and retried each one 3 times (~30 chain calls a second, most of the day's budget);
  - tapes read from the chain, funder lookups, the historian's replays and its bond scan, HOUND's wallet reads and the burn checks all silently dropped those transactions.
- Every transaction read now tries version 0 first (same cost as before). On a version error it asks again with maxSupportedTransactionVersion 1 and shapes the answer like web3.js's parsed transaction, so every parser works unchanged. A real failure (timeout, rate limit) still counts as a failure.
- nano is warm-started once more: the v0.1.28 code ran on the new v1.1 model for a few minutes on 7 Oct (a reverted push) and trained it the old way. The archived v1 model is left as it was.
- Run 4 (honest paper desk) follows as v0.1.31.

## v0.1.29 · CATCH off the curve, King v1.1 (nano rebuilt)
- 7 Oct, 22:00 to 23:15: the paper desk went from +32% to -19%. Almost all of it was CATCH: 20 real trades, 1 winner, -0.21 SOL. It bought $5K-20K curve coins on its starting score, before its model had earned anything, and those coins dumped 60-80% within seconds (stops filled at -40% to -80%). MOMO and WIRE were flat to positive.
  - CATCH trades real money only on what it has proven: migrated coins once its model has earned a score band, and curve coins only once its last 30 closed curve trades (ghost and real, after fees) average +5% or better with 30%+ winners. It locks again as soon as they fall below that. The ghost desk keeps following every signal, so the record keeps building. Progress shows on every skipped signal.
  - CATCH's old record counted every look (one coin, 12 looks, 12 hits) and graded today's model. It is moved aside (rn:ct:rec:v1) and starts over on the v0.1.28 honest grading.
  - No double buys: one coin can only be entered once at a time ($MEMEBER was bought twice within a second).
  - CATCH and FLASH buys are labelled as such (they showed as "King undefined undefined").
- Chain reads:
  - The desk is never stopped by the daily budget. It must always price and exit what it holds.
  - The rats' backfill only reads launches at least 20s old. v0.1.28 read the youngest ones while the stream was still storing them, so most launches were paid for twice. Failed reads show their reason on /status. The strike counter of failing reads is never wiped.
- King v1.1, the nano learner rebuilt (Run 3):
  - Inputs are standardized, so a 0-1 flag and a log count weigh on the same scale.
  - Adam with a small rate and a hard cap per step (v1: rate 0.05 x class weight up to 50 x boost 2.5, so one bond could swing the model).
  - One class weight for every source (live, replays, historian), from the model's own base rate.
  - Non-finite inputs or steps are refused, shorter inputs are padded, weights are never truncated.
  - The market-shift boost needs a real shift on the class-weighted loss, lasts 200 lessons and fires at most once a day.
  - Migration once at worker boot: v1 models kept (rn:nano:v1, rn:nano1:v1), v2 warm-started on the last 4,000 live lessons. The historian walks its window again with the clean labels. The runner model starts over on the same learner.
  - New calibration and board version v1.1. v0 rules make the calls until v1.1's own lines are calibrated (1,500 lessons with 15 bonds in the last 7 days). v1.0's record stays on the board.
  - The runner model is trained only under its own lock, on the latest copy (the slow lane and the historian used to overwrite each other's lessons).
- The site address is trimmed of a trailing slash (NEXT_PUBLIC_SITE_URL ending in "/" broke the Telegram webhook with a // redirect).

## v0.1.28 · Stream first, fits the 10M plan, clean data
- Helius ran at ~39 calls a second (~100M a month) on a 10M-a-month plan. Most of it was paid for data the PumpPortal stream already delivers. Now:
  - Launch tapes (minute-1 and minute-5 trades) are built from the stream's own trades for every launch the worker saw from birth: no chain reads. The chain is read only for launches the stream missed, and for the insider check when the desk buys.
  - Desk prices come from the stream's latest quote, with a chain check of each coin every 10 seconds. The desk loop runs every 0.5s on a paid plan, insider holdings every 5s.
  - A paced daily budget (RPC_CALLS_PER_DAY, default 300K): when spending runs ahead of the day's pace the historian pauses first, then the agents, then the rats. The desk can go 15% over so it can always price and exit. A worker restart picks up the day's count from Redis. Historian default cap lowered to 60K a day.
  - /status: a Chain budget tile (today vs budget and pace, historian share) and the monthly pace from the live rate. Before, the monthly figure was today's count spread over the whole day and read far too low.
- Clean data (labels the models learn from):
  - Lost launches: a launch is marked seen only after it is stored, and the chain backfill no longer moves past a launch it failed to read (retried, given up after 3 failed passes). A failed curve read no longer drops the batch.
  - Historian bond time is the migration transaction's time. It was the curve's newest signature (any later activity), so coins that bonded in 40 minutes could be labelled "not within 2 hours". The bond scan now stays inside the replay window.
  - Busy coins (1000+ transactions): the tape pages back to the create, so bundles, snipers and early buyers are measured on the real first trades.
  - Same picture live and in history: the historian takes the same trade sample as the live read (first 28, newest 14), counts only successful transactions, and has no tape below the same curve minimum. When the minute-5 trade read fails, the call's model sees "no tape" instead of the minute-1 tape.
  - Coins that bonded before their call are no longer learned as one-sided "winner" lessons.
  - Late calls: only calls made by minute 7 count on the board, the calibration, the desk and the lessons (made up to minute 15, shown as late).
  - /lab v0 calibration uses v0's own score (it mixed in nano's once v1 made the call).
  - Graduation proof: the canonical pool existing is the proof (only pump.fun's migration can create it). A pool dumped under 20 SOL right after migrating used to make the coin count as DIED.
  - CATCH: every snapshot keeps its own peak from the moment it was taken (a new snapshot used to reset the coin's peak and erase an earlier hit). The record is graded on the score given at the look and counts each coin once. FLASH graded on its stored score too.
  - Runner ladder: milestones crossed in the same hourly candle (history) or the same read (live) teach nothing; they used to be instant "yes" lessons.
- Redis growth: dev, wallet and funder tables, the funder cache, CATCH's last looks, finished runs and the near set are trimmed every 6 hours (one-off entries first).
- Speed panel: PumpPortal's delivery lag (sampled against block time, 1 launch in 50).

## v0.1.27 · /desk crash fix, error pages
- /desk crashed ("Application error") after v0.1.26: the page's new exam cache used the same Redis key as the homepage's exam summary, so each overwrote the other and the desk payload arrived without its exam. The full exam now has its own key, and the page tolerates a missing exam.
- Error pages: one page that fails to draw no longer blanks the whole site. The header and menu stay, the page offers a retry and a link to /status; an error in the layout itself shows a plain reload screen.

## v0.1.26 · Redis bandwidth diet, outage alerts
- 7 Oct: Upstash hit its plan limit (60 GB of bandwidth in one day) and every page and loop went down. The causes, all fixed:
  - Open positions (each carries its price path, ~20KB) and the ghost book were read whole and written back twice a second. They now live in the desk's memory between beats and go to Redis at most every 10s, at once after a trade. Entry checks use the same memory copy, so a coin bought earlier in the same beat is seen at once.
  - WIRE read its whole account list (5,000+ accounts, ~800KB) on every post the J7 feed delivered, every slow-lane pass and every /desk page poll; per-account weights read every account's counters. The list is read at most once a minute per process, weights read only the two counters they need, account curation runs every 10 minutes, and the pile of one-off @mentions is pruned.
  - The live tape hash was rewritten whole every second; only coins that traded are written now, and coins no longer watched are removed.
  - The desk's shadow and after books (with price paths) were read about once a second; every 15s now.
  - Page reads: the exam (up to 2,000 trades and 3,000 equity points) is computed once per 30s for all visitors, the track record once per 15s per server, the desk payload once per 2s per server, sparklines are sent with 90 points instead of 360, and HOUND's wallet book is cached for a minute.
- Outage alerts in Telegram (the private ideas chat): Redis failing (with the exact error, like the plan limit), chain reads failing (more than half failing over 20s), the public site API failing. Two failed checks in a row open an incident, a reminder every 30 minutes while it lasts, one line when it is back. These run without Redis, so they work exactly when Redis is the problem. While Redis is down the worker does not restart itself (a restart cannot fix the database).

## v0.1.25 · One system, no overlaps
- A second system ran on every page visit: each open page POSTed /api/dig every 15s, which ran a full dig on Vercel next to the worker, on its own lock and its own RPC limiter. Due checkpoints, lessons and calls could be processed twice, and the two limiters together went far over the Helius plan (the 429 storms). The page nudge is gone; the fallback dig only runs while the worker is down and then holds the worker's own lane locks.
- The minute ping (/api/desk/run) now steps aside whenever the worker process is up (it restarts itself when a loop hangs) or a desk holds the lock. Before, a late desk beat during a 429 storm made it start a whole second system on Vercel. Takeovers are counted on /status.
- Desk lock: renewed on its own 10s timer, not only once per beat (a beat with a 120s swap confirmation could outlive the 75s lock and let a second desk in). Every real-money swap checks the lock in Redis first, and a desk that lost its lock never writes the books.
- Owned locks everywhere: MIND, LENS, OVERSEER, the historian and both rat lanes use renewing, owner-only locks. A session that ran long used to delete the next session's lock, so two or three ran side by side.
- Model training never runs without its lock: when the trainer is busy, lessons are parked and the next holder learns them (before, it trained unlocked after 3s, the lost-lessons bug again). A trainer that lost its lock mid-way parks its lessons instead of overwriting.
- Every outside call has a deadline (20s unless it sets its own): a hung price API or Telegram call used to freeze a whole worker lane. Upstash retries once instead of five times.
- Worker: the watchdog never restarts in the middle of a real-money swap (waits up to 3 minutes), every restart is recorded with its reason, stray errors are logged and counted instead of crashing. The swap confirmation no longer reads a failed block-height call as height 0.
- Live stream: 30s without a PumpPortal message means a dead socket; it reconnects (before, a half-open socket stopped FLASH, intake and the live tape while /status stayed green). Only pump.fun launches are taken from the stream. A J7 drop ends its session at once instead of a silent gap.
- Chain reads per day per lane, with the monthly pace, on /status. The historian has a daily cap (HISTORIAN_CALLS_PER_DAY, default 400K).
- Telegram alert in the private ideas chat when a loop stalls, and one line when it is back.
- /status: worker tile (uptime, starts, last restart and why, minute-ping takeovers, stream reconnects). Tweet-link reads count against the X budget too.

## v0.1.24 · Watertight: no starved loops, sell-off exit fixed, X budget, link preview
- Sell-off exit: it sold $EVE at +5.5% on a healthy pullback ("sellers took over: curve -22% in 40s") while the price sat only a few % under its high, then the coin ran to 22K. The exit now needs the price to confirm it (15%+ off its 40-second high, SOL leaving the curve, and the position under +25%). COACH scores every sell-off exit per strategy (did the coin run 30%+ after?) and switches it off for a strategy once holding through pullbacks does better; while off it keeps scoring what selling would have done, so it can switch back on.
- Chain reads: the plan was oversubscribed and three loops starved. The desk and the rats could take 70% + 80% of the plan between them, so CATCH, HOUND, MIND, the rats' slow lane and the historian waited for minutes (silent 6-19m on /status). Every lane now has a guaranteed floor (desk 30%, rats 30%, agents 20%, historian 10%), the rest goes by priority.
- Big reads: a tape read asks for ~42 transactions in one batch. It could wait forever behind its own lane's ceiling, and it hit the plan as one burst. Batches now go out in slices of 10, and a lane that has sent nothing this second may always send.
- 429s: the plan answered "Too Many Requests" and the worker kept going at full rate. Now every 429 lowers the live ceiling by a fifth; it climbs back one call per second every 10 quiet seconds.
- No more pile-ups: a rats pass that ran past 45s was left running while the next one started, so passes stacked on the same lane and slowed each other ("fast pass ran past 45s" on every beat). The fast lane, the slow lane and the historian now wait for their own pass; a pass stuck too long restarts the worker (watchdog on all three).
- Historian, bonds first: a failed read (429) skipped that bond for good, which is why the scan showed 0 bonds found. Failed reads are retried, and it pauses when most of a chunk fails.
- "Pipeline is empty": the slow lane's migration check threw on every beat where no coin had migrated yet. Empty Redis batches are now a no-op everywhere.
- Fast bonders: a coin that bonded in minutes was only marked complete when a rat re-read its curve, so some were learned as misses (FLASH had 0 bonds in 532 looks). A migration seen on the live stream now marks the curve complete at once; the pool check still proves it.
- Exam: "paper round trips" counted a position after its first partial sell (22 on the exam vs 20 closed on the track record). It now counts closed positions only, since this desk started, and a coin bought twice counts twice.
- X credits: 111K credits an hour on twitterapi.io. Every found account had its own paid rule (~650 accounts, ~50 rules checked every minute). Paid live watching is now earned: the seeds plus the found accounts with the best results, sized to an hourly budget (X_CREDITS_PER_HOUR, default 25K, rules get about half: ~100 accounts). The rest are still read for free through J7 and tweet links. LENS: 20 dossiers an hour (was 60) and it stops at 80% of the budget. Every paid read is metered.
- /status: new tiles for X credits (this hour, last hour, budget, accounts watched live) and chain reads (calls per second, 429s, the slowest lane's wait). The systems panel shows which of the 25 agents each loop runs, and when something is off, the reason under it (no hover needed on phones).
- Link preview: links to ratnet.network had no image on X, Telegram and Discord. Every page now carries the 1200x630 banner.
- /desk payload: 1.1MB every 5s (the whole WIRE account list). Now the top 40 plus counts: about 90KB.
- The desk wallet balance on the pages is read once per 20s for everyone, and a failed read shows the last balance instead of 0.
- Pages opened in a background tab load their live data right away.

## v0.1.23 · Learning integrity, historian 24/7, status page, charts
- Lost lessons fixed. Three trainers (the rats' fast and slow lanes and the historian) each loaded the live model, trained their own copy for up to a minute and saved it over the others: whole batches of lessons disappeared, and the sample counter jumped back and forth. That is the zigzag at the end of the training-loss line on /lab. Now every lesson goes into the live models through one locked step on the latest saved copy, so nothing is overwritten and the counter only goes up. The chart also draws points in sample order, one per sample count.
- Historian: it had stalled (0.2% of its 30 days, no progress in a minute of watching). It only ran inside the agents' minute, its RPC lane was served only when nothing else waited, and one of its chain reads bypassed the RPC limiter with no deadline (one stalled call could freeze it). Now it runs in its own loop around the clock, every read goes through the limiter with an 8s deadline, and it gets its fair share of the plan (v0.1.22 lanes).
- Historian, bonds first: it pages pump.fun's migration account back in time, so every graduation of the last 30 days is found with about one call each (~750 a day) instead of parsing all ~50,000 launches a day to find them. Bonds are the rare lessons the models need most. The launch-by-launch scan keeps running behind it for the dev records and the non-bonded samples, and a bond is never learned twice. /lab shows how far back the bond scan has reached and the historian's last error.
- All systems panel on /desk: every loop and agent (desk, rats fast and slow, live stream, FLASH, historian, CATCH, MOMO, HOUND, MIND, LENS, OVERSEER, WIRE, J7, receipts, telegram) with when it last finished a pass. Red = silent for 3x its normal pace, amber = its last pass reported an error. Railway logs now include LENS and OVERSEER results too.
- Every stat card on the feed opens its chart: launches dug and graduations (bars), the trench base rate, and the King's BOND hit rate against the base rate, per hour (24h, 72h) or per day (30d), with a crosshair and the exact numbers on hover. New daily counters (rn:dayh) keep 120 days.
- The track record's numbers on /desk open their charts too: equity since start, realized P&L trade by trade, the win rate over the last 10 trades against the exam's 40% bar, every trade's result (green and red bars) and hold time per trade.
- /status (Rat King menu and the search): one health page for the whole protocol: loops and agents, desk heartbeat, the live stream, speed (launch dug, first read, minute-1 read, King call, signal to fill), learning (historian, King v1, CATCH, FLASH) and the desk exam, green / amber / red, plus the all-systems grid.
- BOARD rows line up on one grid: coin, count, chips always start at the same place; on phones the chips wrap under the coin.
- Agent grid on /desk: 5 columns for the 25 agents (no lone tile on the last row). Copy: twenty-five agents.
- Pages that open in a background tab load the moment they become visible (they waited for the next poll). The live toast shows the first update at once instead of "waking the rats".

## v0.1.22 · Fair lanes, LP check
- The rats' fast lane got stuck right after v0.1.21 went live (the watchdog restarted the worker). Cause: every agent read the chain in the desk's lane, and one heavy agent (HOUND digging a breakout's whole curve, CATCH, MOMO, LENS) could keep the rats waiting for their RPC turn for minutes. Now four lanes in priority order, each with a ceiling on its share while others wait: desk 70%, rats 80%, agents 50%, historian 40% (75% when idle). Alone, a lane may use the whole plan. A fast pass that runs past 45s is left to finish on its own and the lane moves on.
- SHIELD, new hard check "lp_burned": a migrated coin must trade in the pool pump.fun's own migration created (LP burned). $ALLOX was not a pump.fun launch at all: a hand-made PumpSwap pool with 100% of its LP held by one wallet (removable at any moment), and $533K of 5-minute volume on a $52K market cap. Not a honeypot (no mint or freeze authority, no transfer fee, sells go through), but a rug waiting to happen, with a chart walked up by bots.
- SHIELD, new soft check "real_volume": 5-minute volume over 4x the market cap is wash trading.
- Speed panel: "first read" is now the 15-second look only (it showed the median of all three looks).

## v0.1.21 · Speed
- Found the biggest delay in the whole protocol: launches were dug about 12 minutes after they were born (measured live: median 709s). The rats read new launches from the chain in one combined pass that also re-read hot curves, resolved coins and trained the models, and that pass ran only every few minutes. So the minute-1 read never happened (too late) and the "minute-5" call was made at minute 12 with minute-12 data, while the desk only takes signals under 3 minutes old.
- Launches now come straight from the PumpPortal stream: dug about one second after they are born (metadata waits 1.5s at most). The chain read stays as a backfill and skips every launch the stream already brought, so it costs almost nothing and never falls behind.
- The rats run in two lanes in the worker: a fast lane every second (backfill, WIRE picks, and the minute-1 read and minute-5 call the moment they are due) and a slow lane every ~4 seconds (the 200 hottest curves re-read, migrations, lessons, runners). Hot curves used to be re-read every few minutes.
- FLASH (25th agent): every launch is streamed for its first ~100 seconds and read at 15, 45 and 90 seconds from the trades alone (no chain reads): curve fill, wallets, net SOL, the dev's buy and whether the dev sold, how much was bought in the launch block and the first 2 seconds, concentration, pace, plus the dev's record, socials and the post. One model learns all three look times from "bonded within the hour", each look time has its own honest record, and a look time trades only once its record earns it (a score band with 30+ looks, 10%+ bonded and 5x the base rate). Own sleeve and slots; a signal older than 6 seconds or a coin that ran 40%+ since the look is skipped. flash* in the desk JSON.
- CATCH passes every 5-6 seconds (was 10-12). Live tape flushed every second (was 2).
- SHIELD is faster on young coins: a mint that passed its authority checks is cached, the holder read waits until a curve is 3 minutes old (it says nothing earlier and is the slowest call), and the "nobody sells" honeypot test waits too (in the first minutes nobody has sold yet, and a pump curve always buys back).
- /desk shows the speed: seconds from a launch's birth to the first read, the minute-1 read, the King call, and signal to fill.
- Layout: no content can stretch a column or push a page sideways any more, on any page. Every grid column is bounded (minmax(0, ...)), long log lines are cut with an ellipsis, the page never scrolls sideways, buttons never wrap or get squeezed. Fixes the home page glitch where a long Rat Cam line squeezed the left column into one word per line.
- Tests: sim/v021test.ts.

## v0.1.20 · Admin fixes
- Admin buttons can no longer break the layout on any admin tab: small buttons have their own size and never wrap or shrink, status tables wrap long text instead of pushing the buttons past the panel edge, wide tables scroll inside their panel, and on phones each status row stacks (label, value, button).
- "fill now" (HOUND) and "sync now" (X) run in the background: the button answers at once and the rows refresh by themselves for a minute. Before, the fill ran longer than the request was allowed to (FOMO, every roster, proof checks, then the webhook), so the page showed "failed" even though the wallets were added and only the final webhook push was cut off. Any other error now shows the real reason (status code, timeout) instead of a bare "failed". Buttons are disabled while a job is starting.
- MadeOnSol roster read up to 2,000 wallets (it pages at 500).

## v0.1.19 · Live flow, every pool, faster learning
- Desk heartbeat fixed. The desk shared one session with every agent, so after each minute it sat idle until the slowest agent (historian, LENS, MIND) finished: gaps of 30-90 seconds with no price reads, exits or entries. The worker now runs the desk in its own loop (5-minute sessions, back to back) next to the agents' loop, and the watchdog checks both. Inside the desk, the learning pass (shadows, COACH reviews, the exit lab, FILM) runs beside the beat instead of in front of it, and its Redis writes go in one batch instead of one per item. The /desk page reads the desk through a 2s cache (it could show data up to 18s old).
- X credits: twitterapi.io bills every rule check. A sync only deleted the rules it remembered, so a delete that failed once left old rules running and billing, and each later sync stacked a new set on top. Now every sync lists all rules on the account and deletes every ratnet-wire-* rule before adding the current set. Default check interval 60s (was 20s, X_RULE_INTERVAL). Admin > Setup shows the interval and how many old rules were removed.
- HOUND fills its book. MadeOnSol's roster field is wallet_address (we read wallet/address, so nothing was ever added); every roster wallet now joins the book at once (two rosters = likely, one = unconfirmed) and the proof check upgrades 10 an hour. FOMO: reads /positions by userId (up to 200), and the 30-day and 7-day leaderboard top 25 are tracked as a new class, FOMO top trader, even without a full profile (HOUND keeps a copy record per class, so the desk learns whether they pay). A failed read retries in 15 minutes instead of waiting 6-12 hours. Admin > Setup shows the book size, what each source returned on its last run, and a "fill now" button.
- CATCH reads the live trade stream. The worker streams trades for every open position, the 100 hottest curves, every migration of the last 2 hours and every coin CATCH watches, and keeps a 60-second flow picture per coin: buys, sells, distinct wallets, net SOL, sell share, first-time wallets, the biggest buy, market cap change. These are 8 new model inputs.
- POOL WATCH: every migration of the last 2 hours is read in its PumpSwap pool once a minute (DexScreener, 30 coins per call): liquidity, 5-minute volume, buys and sells, price change. CATCH used to see the pool stage only for the ~25 coins on MOMO's list; now every migration gets the same look, which is where the slow 30-60 minute migrators that send to $200-500K show up. 4 more model inputs.
- CATCH's model grows from 34 to 46 inputs without forgetting: the learned weights are kept and the new inputs start at zero. Feature reads run 12 at a time (240 coins per pass).
- Faster labels: a second CATCH model asks "does it hit within 2 hours?". Its labels arrive 3x sooner than the 6-hour ones, it learns from replayed history too, and it has its own honest record. Either model trades once its own record earns a band.
- Send ladder for CATCH trades: 40% sold at 2x (the exit lab tunes the level), a wider trail while it runs, 30% of the original bag sold at the target ($300K or 2x the entry market cap), the last 30% trails like any house-money bag. catchFirstFrac and catchSendFrac in the desk JSON.
- Historian: parses 16 launches at a time (was 4), rebuilds 6 at a time (was 3) in bigger batches, and may use 75% of the RPC plan while the desk and the rats have nothing waiting (was a fixed 40%).
- Tests: sim/v019test.ts.

## v0.1.18 · SHIELD
- SHIELD (24th agent): the scam guard. Every buy from every strategy passes it right before the money moves. Hard blocks: mint or freeze authority still set; Token-2022 traps (transfer fee, transfer hook, permanent delegate, non-transferable, frozen by default); no route back to SOL for our size or under half back (honeypot, Jupiter quote); 20+ buys and not one sell (live tape or MOMO's counts). Soft stops (starting priors, FILM follows every coin they stop): a price drawn in a straight smooth line with no pullbacks (1-minute candles: fit >= 0.97, dips < 5%, < 15% red candles, +30%), one wallet holding 12%+ or the top 10 45%+, a block-0 farm or bundle. Every stop is on the coin's BOARD (stance -1) and in the agent log.
- Positions are re-read twice a second on a paid RPC plan (was once a second).
- Tests: sim/shieldtest.ts.

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
