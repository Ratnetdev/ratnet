# Changelog

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
