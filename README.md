# RATNET ($RAT)

Pretraining the first model raised in the trenches. Rats dig every new pump.fun launch, the Rat King scores each one 0 to 100 on "will it bond", and every call is checked against the chain.

## What runs on launch day
- **Live rat feed**: every pump.fun create tx (create + create_v2) read from Solana via the pump.fun mint authority, decoded on the fly (name, ticker, uri, creator, dev buy) plus off-chain metadata (description, socials).
- **Checkpoints**: bonding curve read at dig, 5m, 1h, 24h. Outcome BONDED (curve complete), ALIVE or DIED (<5% at 24h).
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
