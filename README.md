<p align="center">
  <img src="docs/assets/banner.jpg" alt="RATNET: the model raised in the trenches" width="100%">
</p>

<p align="center">
  <img src="docs/assets/mark.png" alt="RATNET" width="96">
</p>

<h1 align="center">RATNET</h1>

<p align="center">
  <b>Pretraining the first model on the trenches.</b><br>
  A swarm of rats digs every pump.fun launch, the Rat King learns, then trades its own calls on chain.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-v0.1.3-8cff5a?style=flat-square&labelColor=060807" alt="version">
  <img src="https://img.shields.io/badge/chain-Solana-8cff5a?style=flat-square&labelColor=060807" alt="Solana">
  <img src="https://img.shields.io/badge/source-pump.fun-ffb547?style=flat-square&labelColor=060807" alt="pump.fun">
  <img src="https://img.shields.io/badge/model-trained%20from%20scratch-7fd1ff?style=flat-square&labelColor=060807" alt="from scratch">
  <img src="https://img.shields.io/badge/license-MIT-c8d3cc?style=flat-square&labelColor=060807" alt="MIT">
</p>

<p align="center">
  <a href="https://ratnet.fun">App</a> ·
  <a href="https://ratnet.fun/desk">Desk</a> ·
  <a href="https://ratnet.fun/king">Rat King</a> ·
  <a href="https://ratnet.fun/lab">Lab</a> ·
  <a href="https://ratnet.fun/developers">API</a> ·
  <a href="https://ratnet.fun/dataset">Dataset</a>
</p>

---

## Contents

1. [Overview](#1-overview)
2. [Why RATNET](#2-why-ratnet)
3. [System architecture](#3-system-architecture)
4. [The rats: data acquisition](#4-the-rats-data-acquisition)
5. [Launch lifecycle and outcomes](#5-launch-lifecycle-and-outcomes)
6. [The Rat King: models](#6-the-rat-king-models)
7. [Measuring the King in public](#7-measuring-the-king-in-public)
8. [The Desk: autonomous trading](#8-the-desk-autonomous-trading)
9. [Economy: rats, sniffs and rounds](#9-economy-rats-sniffs-and-rounds)
10. [Tokenomics](#10-tokenomics)
11. [The open dataset](#11-the-open-dataset)
12. [Open API](#12-open-api)
13. [Product surfaces](#13-product-surfaces)
14. [Roadmap](#14-roadmap)
15. [Self-hosting](#15-self-hosting)
16. [Repository layout](#16-repository-layout)
17. [Security and transparency](#17-security-and-transparency)

---

## 1. Overview

RATNET is pretraining the first model native to the trenches.

A swarm of crawler **rats** indexes every pump.fun launch in real time: metadata, socials, dev history, bonding curve flow and the final outcome. Everything goes into a live, open dataset.

The **Rat King** is a model trained from scratch on that dataset alone. It scores each launch at minute 5 on one target: **will this coin bond?** Every call is frozen the moment it is made, then graded by the chain. Hits and misses stay on the board forever.

The **Desk** is an autonomous team of eight agents that turns the King's calls into trades with its own wallet, on chain, in public. It trades on paper until it passes its own exam, then promotes itself to live. Nobody flips the switch.

> Other agents talk about markets. RATNET learns from them and trades them.

---

## 2. Why RATNET

**The trenches are the largest unlabelled dataset in crypto.** pump.fun produces 10,000+ new tokens a day. Around one percent of them complete their bonding curve. Every one of them is a fully observable experiment: who launched it, how it was presented, how the curve filled, and how it ended. Nobody is learning from all of it.

**AI agents in crypto cannot be checked.** Most agents produce opinions, threads and vibes. There is no target, no score and no record. You cannot tell a good one from a lucky one.

RATNET is built around three rules:

| Rule | What it means |
|---|---|
| **One target** | Every launch is scored on a single, binary question: will it bond. The chain answers it. |
| **No hindsight** | The call is made at minute 5 and frozen. A call made later than 15 minutes after birth never counts. |
| **Everything public** | Hit rate, base rate, calibration, model weights, loss curve, trades and the dataset itself. |

The data never runs out. Every new launch is a new training sample, so the King gets one lesson richer every few seconds, around the clock.

---

## 3. System architecture

<p align="center">
  <img src="docs/assets/architecture.png" alt="RATNET system architecture" width="100%">
</p>

| Layer | Component | Responsibility |
|---|---|---|
| Source | pump.fun program | Every launch is signed by the pump.fun mint authority, so its signature history is a clean stream of new tokens. |
| Crawl | The rats (`src/lib/digger.ts`, `src/lib/solana.ts`) | Decode create transactions, read bonding curves, fetch off-chain metadata, track checkpoints and resolve outcomes. |
| Data | Upstash Redis + Vercel Blob | Hot state, sorted watch sets, 24h coin index, resolved rows and daily JSONL drops. |
| Model | Rat King v0 + nano (`src/lib/king.ts`, `src/lib/nano.ts`) | Score every launch at minute 5. Nano learns online from every resolved launch. |
| Execution | The Desk (`src/lib/desk.ts`) | Vet, size, buy, manage and sell positions. Paper or live. |
| Interface | Next.js 14 app + open API | Live feed, radar, explore, desk, lab, coin pages, share cards. |

One scheduled ping per minute drives the whole system. Each ping opens a ~55 second session in which the desk re-reads open positions every 2 seconds and the rats dig every 10 seconds.

---

## 4. The rats: data acquisition

The rats watch the pump.fun mint authority `TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM`. Every pump.fun create transaction is signed by it, so reading its signature history yields every new launch without scanning the whole program.

For each launch the rats:

1. **Decode** the `create` or `create_v2` instruction: mint, name, ticker, metadata URI, creator and the dev's initial buy.
2. **Read** the bonding curve account: virtual and real reserves, completion flag, quote mint. Curve progress, market cap and price are derived on chain, not from third parties.
3. **Fetch** off-chain metadata: description, X, Telegram and website links.
4. **Remember** the dev: every creator's past launches and past bonds are stored, so a serial launcher is recognised on sight.
5. **Schedule** checkpoints and add the coin to the watch sets.

**Hot watch.** Every curve above 2% is re-read on every run (the top 200 by curve plus a rotating slice of the rest). Graduations are detected within seconds instead of at the next checkpoint. The watch reads only curve accounts and two sorted sets, so it stays cheap at full pump.fun volume.

**Market data.** Market cap, volume, price change, liquidity and buy/sell counts come from DexScreener, cached for 30 seconds and shown next to the on-chain curve data.

**Simulation.** `sim/run.ts` replays hours of synthetic pump.fun traffic through the real engine with a mock RPC and an in-memory Redis. A 30 hour run at ~21,000 launches a day caught every bond with an average lag of 9 seconds and zero errors.

---

## 5. Launch lifecycle and outcomes

<p align="center">
  <img src="docs/assets/lifecycle.png" alt="Launch lifecycle" width="100%">
</p>

| Checkpoint | Time after birth | What happens |
|---|---|---|
| Dig | 0s | Launch decoded, curve read, metadata fetched, dev history attached. |
| Call | 5m | Rat King v0 and nano score the launch. Features are frozen. |
| Window | 15m | Calls made after this point are marked late and never count toward the hit rate. |
| Check | 1h | Early death rule applied. |
| Resolve | 24h | Final outcome recorded and the call is graded. |

| Outcome | Rule |
|---|---|
| **BONDED** | The bonding curve completed. Can happen at any moment and is caught by the hot watch. |
| **DIED** (early) | At the 1h check the curve is under 1% and its peak never passed 3%. |
| **DIED** | At 24h the curve is under 5%. |
| **ALIVE** | At 24h the curve is 5% or more but has not completed. |

The early death rule exists so the model sees losers as fast as it sees winners. Without it, the first day of training would contain almost only bonds.

---

## 6. The Rat King: models

The King runs two models side by side. Both score every launch at minute 5, and both are graded on the same board.

### Rat King v0: the transparent baseline

A hand-written scorer with every weight public. It exists to give the learned model something honest to beat.

| Signal | Max points |
|---|---|
| Curve filled at call (full points at 30%) | 45 |
| Curve growth since first dig (full points at +15%) | 15 |
| X link present | 8 |
| Website present | 6 |
| Description of 40+ characters | 5 |
| Dev buy between 0.5 and 5 SOL (over 5 SOL: 2 points) | 5 |
| Telegram present | 4 |
| Clean ticker (2 to 8 letters or digits) | 4 |
| Name of 24 characters or less, not a test | 3 |

The raw total (max 95) is normalised to 0 to 100.

| Verdict | Score |
|---|---|
| **BOND** | 60 and above |
| **WATCH** | 30 to 59 |
| **DUST** | below 30 |

### Rat King nano: learning from zero

Nano is a model trained from scratch, live, on nothing but what the rats dig. No pretrained weights and no outside data.

- **Model:** logistic regression trained online with SGD, one step per resolved launch.
- **Features (14):** bias, curve at 5m, curve climb since dig, dev buy (log SOL), X, Telegram, website, real description, clean ticker, short name, dev past launches (log), dev past bond rate, UTC hour (sin and cos).
- **Class balance:** bonds are rare, so they are weighted 8x. Otherwise the model would learn to say "dies" every time.
- **Regularisation:** L2 at 1e-4, learning rate 0.05.
- **Warm-up:** nano calls only count after 200 lessons.
- **Learns from what it missed:** coins that bond before the 5 minute call are still turned into lessons, so the King learns from the bonds it never got to call.
- **Fully public:** current weights, sample count and the loss log are served at `/api/king/weights` and charted in the Lab.

### Rat King v1: pretraining (roadmap)

A sequence model pretrained from scratch on the daily dataset drops. It runs next to v0 and nano on the same board, with a public loss curve and weights published on Hugging Face after the first epoch. See [Roadmap](#14-roadmap).

---

## 7. Measuring the King in public

Every number on the site is computed from frozen calls and on-chain outcomes.

| Metric | Definition |
|---|---|
| **BOND hit rate** | BOND calls that bonded ÷ all counted BOND calls. Pending calls count as misses until they resolve. |
| **Base rate** | Launches that bonded ÷ all launches dug. What random picking would get. |
| **Lift** | Hit rate ÷ base rate. How many times more often a King BOND call graduates than a random coin. |
| **Head start** | Average time between the King's BOND call and the actual graduation. |
| **Calibration** | Graduation rate per score bucket, for v0 and nano separately. |
| **Hourly hit rate** | Hit rate against base rate per hour over the last 24h. |

Calls are never deleted, edited or re-scored. If the King is wrong, the board says so.

---

## 8. The Desk: autonomous trading

<p align="center">
  <img src="docs/assets/desk.png" alt="The Desk" width="100%">
</p>

The Desk is a team of eight agents that turns BOND calls into trades. Every step each agent takes is logged and shown live on `/desk`, together with the balance chart, open positions with live mini charts, the trade log and the full rule set.

| Agent | Role |
|---|---|
| SCOUT | Digs every launch. |
| KING | Calls it at minute 5. |
| VET | Checks the dev and the curve. |
| FLOW | Reads live buy and sell pressure. |
| SIZE | Decides how much. |
| EXEC | Buys and sells. |
| RISK | Takes profit and cuts losses. |
| LEDGER | Keeps the books. |

### Entry: every rule must pass

| Rule | Default |
|---|---|
| Curve window | between 8% and 70% |
| Dev not a serial launcher | not 5+ launches with 0 bonds |
| Dev buy sane | at most 5 SOL |
| Live order flow | curve did not drop 5%+ in a 3 second read, and buys are at least 55% of recent trades |
| Daily loss limit | equity not down 25% on the day |
| Open positions | at most 5 |
| Nano agrees | optional, off by default |

**Sizing:** 5% of equity per trade, between 0.05 and 0.5 SOL.

### Exit: the first rule that fires

| Exit | Default |
|---|---|
| Take profit 1 | sell 50% at +60% |
| Take profit 2 | sell the rest at +150% |
| Stop loss | -35% |
| Sellers took over | real SOL in the curve drops 20%+ within 40 seconds |
| Graduation | sold into the migration |
| Time stop | 60 minutes |

Positions are re-read from the bonding curve every 2 seconds, so exits react to the chain, not to a delayed price feed.

### The exam: paper to live

The desk starts on paper, with fills simulated including pump.fun fees and slippage. It promotes itself to live only when every check passes:

| Check | Requirement |
|---|---|
| Paper round trips | at least 30 |
| Win rate | at least 40% |
| Paper profit | at least +10% |
| Worst drawdown | at most 30% |
| Funded desk wallet | at least 0.5 SOL |

Once live, a 40% drawdown from the live starting balance sends the desk back to paper to re-take the exam. The exam and its current state are public on `/desk`.

### Execution

Live swaps are routed through Jupiter with a `veryHigh` priority fee and 15% max slippage. Signed transactions are rebroadcast every 1.5 seconds until confirmed, so buys and sells land during congestion. Every live trade links to Solscan.

---

## 9. Economy: rats, sniffs and rounds

<p align="center">
  <img src="docs/assets/economy.png" alt="Economy" width="100%">
</p>

**Rats.** Burn 100,000 $RAT to spawn a rat. Rats come in weekly litters of 100. Every burn is verified on chain and each transaction signature can only be used once. Rats that do not fit in the current litter queue for the next one.

**Sniff orders.** Burn 10,000 $RAT to have the Rat King score any CA, with the dev's history, nano's read and a short report of what helps and what hurts.

**Rounds.** Every 12 hours the claimed creator fees are split:

| Share | Use |
|---|---|
| 60% | Compute: digging, training and calls. |
| 40% | Rat owners. |

A rat must dig at least 50 launches in a round to earn. The owner share is weighted by each rat's work and the owner's bag per rat:

| $RAT held per rat | Multiplier |
|---|---|
| 100,000 | 1x |
| 500,000 | 1.25x |
| 1,000,000 | 1.5x |
| 2,500,000 | 2x |

Owners holding less than 100,000 $RAT per rat earn up to 2x their rat's cost. Every payout is published on the Ledger with a Solscan link.

---

## 10. Tokenomics

<p align="center">
  <img src="docs/assets/tokenomics.png" alt="Tokenomics" width="100%">
</p>

| Allocation | Share | Notes |
|---|---|---|
| Public | 80% | Fair launch on pump.fun. |
| Team | 8% | Locked for 6 months. |
| Marketing | 7% | Listings, partnerships and growth. |
| Airdrop | 5% | First rat owners and early sniff users. |

Total supply is fixed at 1,000,000,000 $RAT. Every spawn and every sniff burns $RAT permanently.

---

## 11. The open dataset

Every resolved launch becomes one row. Rows are grouped per day and published as JSONL on Vercel Blob. Day D is published on D+2, once every row in it has a final outcome.

| Field | Description |
|---|---|
| `mint`, `created_at` | Token address and birth time. |
| `name`, `symbol`, `description` | As launched. |
| `twitter`, `telegram`, `website` | Social links from metadata. |
| `creator`, `dev_prior_launches`, `dev_prior_bonded` | The dev and their record at launch time. |
| `dev_buy_sol` | The dev's initial buy. |
| `curve_at_dig`, `curve_5m`, `curve_1h`, `curve_24h`, `curve_peak` | Bonding curve progress at each checkpoint. |
| `mcap_sol_5m`, `mcap_sol_1h` | Market cap in SOL. |
| `king_v0_score`, `king_v0_verdict`, `king_nano_score`, `king_counted` | What the King said and whether it counted. |
| `features` | The exact feature vector frozen at the call. |
| outcome | BONDED, ALIVE or DIED, with timing. |

The schema and all drops are listed on `/dataset`. Three tunnels are open today. Three more are sealed and open with later litters (see the [Roadmap](#14-roadmap)).

---

## 12. Open API

All read endpoints are public, JSON, and cached at the edge for a few seconds.

| Endpoint | Returns |
|---|---|
| `GET /api/live` | Counters, latest digs, latest calls, desk summary. |
| `GET /api/radar` | Live launches sorted by curve, with calls, dev record and market data. |
| `GET /api/graduations` | Every bond, time to bond and what the King said, with head start. |
| `GET /api/king?page=0` | The King's calls. Add `verdict=BOND` for BOND calls only. |
| `GET /api/king/weights` | Nano weights, sample count and loss log. |
| `GET /api/proof` | Calibration buckets, hourly hit rate vs base rate, head start, receipts. |
| `GET /api/coins` | 24h index of every BOND or WATCH call plus every bond. |
| `GET /api/coin/{CA}` | Everything RATNET knows about one coin. |
| `GET /api/market` | Cached DexScreener market data. |
| `GET /api/desk` | Desk state, exam, positions, trades and agent log. |
| `GET /api/ledger` | Rounds and payouts. |
| `GET /api/og/{CA}` | 1200x630 share card for any coin. |

Full documentation with examples lives at `/developers`.

---

## 13. Product surfaces

| Page | What it shows |
|---|---|
| `/` | Live Rat Cam, proof numbers, live feed, radar, graduations and calls. |
| `/desk` | The Desk: agents, the Den, exam, balance, positions and trades. |
| `/radar` | Every live launch sorted by curve, with filters. |
| `/explore` | Filter and sort every rated coin of the last 24h. Filters live in the URL. |
| `/king` | Latest calls, BOND calls, graduations, calibration. |
| `/lab` | Nano loss curve and weights, v0 vs nano. |
| `/rats` | Litter, spawn, top rats, rat screens. |
| `/sniff` | Score any CA. |
| `/ledger` | Rounds and payouts with Solscan links. |
| `/dataset` | Schema, tunnels and daily drops. |
| `/c/{CA}` | Coin page with market strip and share card. |

Also built in: sound and desktop alerts for BOND calls, near-graduations and graduations; `/` or Cmd+K search; and hover explanations on every key term.

---

## 14. Roadmap

| Phase | Milestone |
|---|---|
| **Now** | Rats live on every pump.fun launch, King v0 and nano calling in public, Desk trading on paper with a self-promoting exam, open API and dataset. |
| **Rat King v1** | Sequence model pretrained from scratch on the daily drops. Public loss curve, weights on Hugging Face after epoch 1, graded on the same board. |
| **Call bots** | Telegram and X bots posting every BOND call with its share card, and every graduation it called. |
| **Litter 2: Tunnel 4** | First-hour trade flow per launch: buyers, sellers, sizes and timing. |
| **Litter 3: Tunnel 5** | Post-migration life: what happens after a coin bonds. |
| **Tunnel 6** | Other launchpads, chosen by holder vote. |
| **Rat King v2** | Trained on trade flow, with hit rate tracked per version. |
| **Graduation** | The Rat King talks: chat with it about any coin, in trench voice. |

---

## 15. Self-hosting

RATNET is open source. To run your own instance, deploy on Vercel, add Upstash Redis and Vercel Blob (public) under Storage, and set:

| Variable | Description |
|---|---|
| `HELIUS_RPC_URL` | Helius mainnet RPC URL with key. |
| `ADMIN_PASSWORD` | Password for `/admin`. |
| `CRON_SECRET` | Random string. Also the key for the scheduler ping. |
| `PAYOUT_WALLET_SECRET` | Base58 secret of the wallet that pays rat owners. |
| `NEXT_PUBLIC_SITE_URL` | Public URL, for example `https://ratnet.fun`. |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Set automatically by the Upstash integration. |
| `BLOB_READ_WRITE_TOKEN` | Set automatically by the Blob integration. |
| `DESK_WALLET_SECRET` | Optional. Base58 secret of the desk wallet. Without it the desk stays on paper. |
| `JUPITER_API_KEY` | Optional. Key from portal.jup.ag for live swaps. |

Ping `GET /api/desk/run?key=<CRON_SECRET>` every minute with any external scheduler. Each ping runs the rats and the desk for ~55 seconds.

To replay the engine offline: `npx tsx sim/run.ts` (synthetic pump.fun, mock RPC, in-memory Redis) and `npx tsx sim/desk.ts` for the desk.

---

## 16. Repository layout

```
src/
  app/                 Next.js pages and API routes
  components/          UI: Rat Cam, Desk board, Den scene, Explore, Radar, Alerts
  config/site.ts       Constants, checkpoints, fee split, bag tiers, desk defaults
  lib/
    digger.ts          Dig loop, checkpoints, hot watch, calls, resolution
    solana.ts          Create tx decoding, bonding curve parsing
    king.ts            Rat King v0 scorer
    nano.ts            Rat King nano: features, online training, prediction
    desk.ts            The Desk: agents, exam, sizing, exits, Jupiter execution
    stats.ts           Hit rate, base rate, calibration, proof
    market.ts          DexScreener market data
    burns.ts           Burn transaction builder and verification
    rounds.ts          Payout math and transfers
    exporter.ts        Daily dataset drops
sim/                   Offline replay of pump.fun through the real engine
docs/assets/           Images used in this document
```

---

## 17. Security and transparency

- **Keys stay on the server.** Wallet secrets are environment variables, never shipped to the browser.
- **Burns are verified on chain.** Spawns and sniffs are only accepted after the burn transaction is confirmed, and every signature is single-use.
- **Calls are immutable.** A call is stored with its frozen features the moment it is made and is never edited.
- **Money is public.** Payouts and live trades link to Solscan.
- **The model is public.** Weights, features, loss log and the full scoring logic are in this repository and on the site.

---

<p align="center">
  <img src="docs/assets/mark.png" alt="" width="48"><br>
  <sub>RATNET is experimental software. Nothing here is financial advice. Calls and trades can and will be wrong.<br>MIT licensed.</sub>
</p>
