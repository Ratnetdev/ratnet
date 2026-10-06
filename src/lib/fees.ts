// Live creator fees for $RAT, read straight from pump.fun's fee vaults, so the site can show this round's pool while
// it fills (not only after the round closes).
//   on the curve:  creator-vault = PDA(pump, ["creator-vault", creator])                 lamports, minus rent
//   after bond:    PumpSwap ATA(wSOL, PDA(pumpswap, ["creator_vault", creator]))       wSOL amount
// (seeds from @pump-fun/pump-sdk and @pump-fun/pump-swap-sdk). The creator is read from the $RAT curve account, so a
// fee-sharing config set as creator works the same way.
// A claim empties the vault; the claimed amount is carried so "this round so far" never drops.
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { BAG_TIERS, CAP_FREE_BAG, EARN_CAP_X, FEE_SPLIT, ROUND_MS } from "@/config/site";
import { K, redis } from "./redis";
import { bondingCurvePda, conn, pmap, ratPriceSol } from "./solana";
import { getSettings } from "./settings";
import { allRats, isActive, roundOf, roundStart } from "./rats";
import { ratBalance } from "./burns";
import { getRounds, multFor } from "./rounds";

const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_AMM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const RENT0 = 890_880; // rent-exempt minimum of an empty system account (lamports)
const LIVE = "rn:fees:live";
const RK = (id: number) => `rn:fees:r:${id}`;
const WKEY = "rn:fees:w";

export type FeesLive = { round: number; soFar: number; vault: number; at: number; creator: string | null };
export type Weights = { sum: number; n: number; capped: number; at: number };

async function creatorOf(mint: string): Promise<string | null> {
  const cached = await redis().get<string>("rn:fees:creator");
  if (cached) return cached;
  const info = await conn().getAccountInfo(new PublicKey(bondingCurvePda(mint)));
  const d = info?.data;
  if (!d || d.length < 81) return null;
  const c = new PublicKey(Buffer.from(d).subarray(49, 81)).toBase58();
  await redis().set("rn:fees:creator", c, { ex: 3600 });
  return c;
}

/** Called from the dig loop (throttled to every 30s). Reads both vaults in one RPC call. */
export async function trackFees(): Promise<FeesLive | null> {
  const r = redis();
  const s = await getSettings();
  if (!s.mint) return null;
  const prev = await r.get<FeesLive>(LIVE);
  if (prev && Date.now() - prev.at < 30_000) return prev;
  const creator = await creatorOf(s.mint).catch(() => null);
  if (!creator) return null;
  const c = new PublicKey(creator);
  const [pv] = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), c.toBuffer()], PUMP);
  const [auth] = PublicKey.findProgramAddressSync([Buffer.from("creator_vault"), c.toBuffer()], PUMP_AMM);
  const ata = getAssociatedTokenAddressSync(WSOL, auth, true, TOKEN_PROGRAM_ID);
  const [a, b] = await conn().getMultipleAccountsInfo([pv, ata]);
  const pumpSol = a ? Math.max(0, a.lamports - RENT0) / 1e9 : 0;
  const ammSol = b?.data && b.data.length >= 72 ? Number(Buffer.from(b.data).readBigUInt64LE(64)) / 1e9 : 0;
  const vault = pumpSol + ammSol;

  const now = Date.now();
  const id = roundOf(now);
  const h = ((await r.hgetall<Record<string, number>>(RK(id))) || {}) as Record<string, number>;
  let base = h.base != null ? Number(h.base) : vault; // what sat in the vault before this round started
  let claimed = Number(h.claimed || 0);
  const last = h.last != null ? Number(h.last) : vault;
  if (vault + 1e-9 < last) {
    // a claim happened: bank what this round had accrued, restart from the emptied vault
    claimed += Math.max(0, last - base);
    base = vault;
  }
  const soFar = Math.max(0, claimed + vault - base);
  const live: FeesLive = { round: id, soFar: Math.round(soFar * 1e6) / 1e6, vault: Math.round(vault * 1e6) / 1e6, at: now, creator };
  const p = r.pipeline();
  p.hset(RK(id), { base, claimed, last: vault });
  p.expire(RK(id), 14 * 86400);
  p.set(LIVE, live, { ex: 600 });
  await p.exec();
  return live;
}

/** Sum of payout weights of the rats in this round (bag multipliers), refreshed every 5 minutes. */
export async function trackWeights(): Promise<Weights | null> {
  const r = redis();
  const prev = await r.get<Weights>(WKEY);
  if (prev && Date.now() - prev.at < 5 * 60_000) return prev;
  const s = await getSettings();
  if (!s.mint) return null;
  const rats = (await allRats()).filter((x) => isActive(x, s));
  const byOwner: Record<string, number> = {};
  for (const x of rats) byOwner[x.owner] = (byOwner[x.owner] || 0) + 1;
  const owners = Object.keys(byOwner);
  const bags = await pmap(owners, 4, (o) => ratBalance(o, s).catch(() => 0));
  let sum = 0;
  let capped = 0;
  owners.forEach((o, i) => {
    const per = bags[i] / byOwner[o];
    sum += multFor(per) * byOwner[o];
    if (per < CAP_FREE_BAG) capped += byOwner[o];
  });
  const w: Weights = { sum: Math.round(sum * 100) / 100, n: rats.length, capped, at: Date.now() };
  await r.set(WKEY, w, { ex: 1800 });
  return w;
}

/** Everything the money pages need, from cache only (fast). */
export async function getEcon() {
  const r = redis();
  const s = await getSettings();
  const now = Date.now();
  const id = roundOf(now);
  const [live, w, rounds, priceSol] = await Promise.all([r.get<FeesLive>(LIVE), r.get<Weights>(WKEY), getRounds(), s.mint ? ratPriceSol(s.mint).catch(() => null) : Promise.resolve(null)]);
  const soFar = live && live.round === id ? live.soFar : 0;
  const t0 = roundStart(id);
  const elapsed = now - t0;
  const projected = live && elapsed > 30 * 60_000 ? Math.round((soFar / elapsed) * ROUND_MS * 1000) / 1000 : null;
  const pool = (projected ?? soFar) * FEE_SPLIT.owners;
  const sumW = w?.sum || 0;
  const spawnSol = priceSol ? priceSol * s.spawnCost : null;
  // what one more rat would earn at each bag tier (it joins the weights itself)
  const tiers = [{ bag: 0, label: "no bag", mult: 1, capped: true }, ...[...BAG_TIERS].sort((a, b) => a.min - b.min).map((t) => ({ bag: t.min, label: fmtBag(t.min), mult: t.mult, capped: false }))].map((t) => {
    const byClose = sumW + t.mult > 0 && pool > 0 ? (pool * t.mult) / (sumW + t.mult) : null;
    const perDay = byClose != null ? byClose * (86400_000 / ROUND_MS) : null;
    return { ...t, byClose: r4(byClose), perDay: r4(perDay), payback: perDay && spawnSol ? Math.round((spawnSol / perDay) * 10) / 10 : null };
  });
  const paid = rounds.filter((x) => x.status === "paid" || x.status === "partial");
  const wallets = new Set<string>();
  for (const x of paid) for (const p of x.payouts || []) if (p.sig) wallets.add(p.owner);
  return {
    live: !!s.mint,
    round: { id, startsAt: t0, endsAt: t0 + ROUND_MS },
    fees: { soFar, projected, owners: r4(soFar * FEE_SPLIT.owners), compute: r4(soFar * FEE_SPLIT.compute), allTime: r4(rounds.reduce((a, x) => a + (x.feesSol || 0), 0) + soFar), at: live?.at ?? null },
    perRatX1: sumW > 0 ? r4((soFar * FEE_SPLIT.owners) / sumW) : null,
    weights: w ? { sum: w.sum, n: w.n, capped: w.capped } : null,
    paid: { sol: r4(paid.reduce((a, x) => a + (x.ownersSol || 0), 0)), wallets: wallets.size, rounds: paid.length },
    spawn: { rat: s.spawnCost, sol: spawnSol != null ? r4(spawnSol) : null },
    capX: EARN_CAP_X,
    capFree: CAP_FREE_BAG,
    tiers,
  };
}

const r4 = (n: number | null) => (n == null || !isFinite(n) ? null : Math.round(n * 10000) / 10000);
const fmtBag = (n: number) => (n >= 1e6 ? `${n / 1e6}M` : `${n / 1e3}K`);
