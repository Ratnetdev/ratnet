# RATNET ($RAT)

Pretraining the first model raised in the trenches. Rats dig every new pump.fun launch, the Rat King scores each one 0 to 100 on "will it bond", and every call is checked against the chain.

## What runs on launch day
- **Live rat feed**: every pump.fun create tx (create + create_v2) read from Solana via the pump.fun mint authority, decoded on the fly (name, ticker, uri, creator, dev buy) plus off-chain metadata (description, socials).
- **Checkpoints**: bonding curve read at dig, 5m, 1h, 24h. Outcome BONDED (curve complete), DIED early (<1% at 1h, peak <3%), else ALIVE or DIED (<5%) at 24h.
- **Hot watch**: every filling curve is re-checked each run (top 200 by curve + a rotating slice of the rest), so graduations land in near real time. Only curve accounts and two sorted sets are read, so it stays cheap.
- **Radar**: live launches sorted by curve %, with call and dev record. **Graduations**: every bond, time to bond, and what the King said.
- **Dev memory**: launches and bonds per creator, used in reports, the radar and the learner.
- **Rat King nano**: online logistic regression trained from scratch on every resolved launch (`src/lib/nano.ts`), loss log and weights public at `/api/king/weights`. Calls count after 200 lessons.
- **Explore** `/explore`: client-side filters over a 24h index (`rn:idx`) of every call the King or nano rated BOND/WATCH plus every bond. Filters live in the URL.
- **Rat Cam**: large live tunnel + terminal in the home hero, small floating version on other pages (`src/components/RatCam.tsx`).
- **Proof**: `/api/proof` serves score-bucket calibration, hourly hit rate vs base rate, average lead time and receipts.
- **Alerts**: client-side sound + popup + desktop notifications on BOND calls, near-graduation and graduations (`src/components/Alerts.tsx`).
- **Market data**: DexScreener per coin, cached 30s in Redis (`src/lib/market.ts`, `/api/market`).
- **Coin pages** `/c/{CA}` with a 1200×630 share card at `/api/og/{CA}`.
- **Open API** documented at `/developers`. Read endpoints are CDN-cached for a few seconds.
- **Rat King v0**: transparent scorer (`src/lib/king.ts`), call at 5m, hit rate tracked. Calls later than 15m after birth are marked late and never count.
- **Rats**: burn 100K $RAT to spawn (verified on chain, signature single-use). Weekly litters, overflow queues for the next litter.
- **Sniff orders**: burn 10K $RAT to score any CA. Free preview (5/hour per IP) until the CA is set.
- **Rounds**: 12h. Claimed creator fees are split 60% compute / 40% owners, applies min 50 digs, bag multiplier, 2x cap; pays from the payout wallet with Solscan links.
- **Dataset**: daily JSONL drops on Vercel Blob (day D published on D+2 when every row has an outcome).

## Run your own
Deploy on Vercel, add Upstash Redis and Vercel Blob (public) under Storage, set the env vars below.

| Variable | What |
|---|---|
| `HELIUS_RPC_URL` | Helius mainnet RPC URL with key |
| `ADMIN_PASSWORD` | /admin password |
| `CRON_SECRET` | random string; also the key for the external dig pinger |
| `PAYOUT_WALLET_SECRET` | base58 secret of the wallet that pays rat owners |
| `NEXT_PUBLIC_SITE_URL` | e.g. https://ratnet.fun |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | auto from Upstash storage |
| `BLOB_READ_WRITE_TOKEN` | auto from Blob storage |

Keep digging 24/7: ping `GET /api/dig?key=<CRON_SECRET>` every minute. Open pages also trigger digs.

## Roadmap
- Rat King v1: pretrained from scratch on the daily dataset drops, public loss curve, weights on Hugging Face after the first epoch.
- Telegram and X bot posting the King's calls.
- Weekly litters (2, 3, ...).
- Rat King v2 with first-hour trade flow, hit rate per version.
- Graduation: chat with the Rat King about any coin.

## Files
- `src/lib/digger.ts` dig loop, checkpoints, calls, resolution
- `src/lib/solana.ts` create tx decoding, bonding curve parsing
- `src/lib/king.ts` scorer v0
- `src/lib/burns.ts` burn tx builder + verification
- `src/lib/rounds.ts` payout math + transfers
- `src/lib/exporter.ts` dataset drops
