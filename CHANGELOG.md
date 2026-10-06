# Changelog

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
