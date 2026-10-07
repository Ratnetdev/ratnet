// SHIELD (24th agent): the scam guard. Every buy, from every strategy, passes SHIELD first, right before EXEC.
//
// Hard checks (never overruled: these coins can take the money and not give it back):
//   - mint or freeze authority still set (more tokens can be printed, or our tokens frozen)
//   - Token-2022 traps: transfer fee, transfer hook, permanent delegate, non-transferable, frozen by default
//   - can't sell: Jupiter finds no route back to SOL for our size, or gives back under half (honeypot)
//   - nobody is selling: 20+ buys and not one sell in the live tape or the last 5 minutes (a honeypot's signature)
// Soft checks (starting priors: every coin they stop is followed by FILM, so the record shows what they cost):
//   - a drawn line: price climbing in a straight, smooth line with no pullbacks (bots walking the price up, not a
//     market), from 1-minute candles
//   - one wallet holding 12%+ or the top 10 holding 45%+ (curve or pool excluded)
//   - a block-0 farm or bundle: the curve filled in the first blocks by a few wallets (TAPE)
import { PublicKey } from "@solana/web3.js";
import { conn } from "./solana";
import { redis } from "./redis";
import { canonicalPool, readPools } from "./pool";

const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const WSOL = "So11111111111111111111111111111111111111112";
const JUP = process.env.JUPITER_API_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1";
const jupHeaders = (): Record<string, string> => (process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {});

export type ShieldCheck = { rule: string; ok: boolean; v: string; hard: boolean };
export type ShieldResult = { ok: boolean; hardFail: ShieldCheck | null; softFail: ShieldCheck | null; checks: ShieldCheck[] };

// Token-2022 extension types that can trap a holder
const BAD_EXT: Record<number, string> = { 1: "transfer fee", 6: "frozen by default", 9: "non-transferable", 12: "permanent delegate", 14: "transfer hook" };

/** Mint account: authorities and (Token-2022) extensions. */
async function mintChecks(mint: string): Promise<ShieldCheck[]> {
  const info = await conn().getAccountInfo(new PublicKey(mint)).catch(() => null);
  if (!info) return [{ rule: "mint_readable", ok: true, v: "mint not read (skipped)", hard: true }];
  const owner = info.owner.toBase58();
  const d = Buffer.from(info.data);
  const out: ShieldCheck[] = [];
  if (owner !== TOKEN && owner !== TOKEN22) return [{ rule: "real_token", ok: false, v: `mint owned by ${owner.slice(0, 6)}…`, hard: true }];
  const mintAuth = d.length >= 36 && d.readUInt32LE(0) === 1;
  const freezeAuth = d.length >= 82 && d.readUInt32LE(46) === 1;
  out.push({ rule: "no_mint_authority", ok: !mintAuth, v: mintAuth ? "more tokens can still be printed" : "revoked", hard: true });
  out.push({ rule: "no_freeze_authority", ok: !freezeAuth, v: freezeAuth ? "our tokens could be frozen" : "none", hard: true });
  if (owner === TOKEN22 && d.length > 166) {
    // TLV extensions start after the 165-byte base + 1 account-type byte
    const bad: string[] = [];
    let i = 166;
    while (i + 4 <= d.length) {
      const type = d.readUInt16LE(i);
      const len = d.readUInt16LE(i + 2);
      if (type === 0 && len === 0) break;
      if (BAD_EXT[type]) {
        // a transfer fee of 0 bps is harmless: the newer fee bps sits at the end of the extension
        if (type === 1 && len >= 108 && d.readUInt16LE(i + 4 + len - 2) === 0 && d.readUInt16LE(i + 4 + len - 20) === 0) {
          /* zero fee */
        } else bad.push(BAD_EXT[type]);
      }
      i += 4 + len;
    }
    out.push({ rule: "no_token_traps", ok: !bad.length, v: bad.length ? bad.join(", ") : "clean Token-2022", hard: true });
  }
  return out;
}

/** Can we get out? A Jupiter quote for selling roughly the size we'd buy. */
async function sellCheck(mint: string, tokensRaw: bigint, solIn: number): Promise<ShieldCheck> {
  if (tokensRaw <= 0n) return { rule: "can_sell", ok: true, v: "no size to test", hard: true };
  try {
    const r = await fetch(`${JUP}/quote?inputMint=${mint}&outputMint=${WSOL}&amount=${tokensRaw}&slippageBps=1500&restrictIntermediateTokens=true`, { headers: jupHeaders(), cache: "no-store", signal: AbortSignal.timeout(2500) });
    if (!r.ok) {
      // 400 "no route" is a real answer; anything else (rate limit, outage) is not evidence against the coin
      const txt = await r.text().catch(() => "");
      return /route|liquidity/i.test(txt) ? { rule: "can_sell", ok: false, v: "no route back to SOL", hard: true } : { rule: "can_sell", ok: true, v: "quote unavailable (skipped)", hard: true };
    }
    const q: any = await r.json().catch(() => null);
    if (q?.outAmount == null) return { rule: "can_sell", ok: true, v: "quote unreadable (skipped)", hard: true };
    const back = Number(q.outAmount) / 1e9;
    const ratio = solIn > 0 ? back / solIn : 1;
    return { rule: "can_sell", ok: ratio >= 0.5, v: `selling our size returns ${Math.round(ratio * 100)}% (price impact ${Math.round(Number(q?.priceImpactPct || 0) * 100)}%)`, hard: true };
  } catch {
    return { rule: "can_sell", ok: true, v: "quote timed out (skipped)", hard: true };
  }
}

/** A drawn line: 1-minute candles of the pool, straight smooth climb with almost no pullback. */
async function lineCheck(mint: string): Promise<ShieldCheck | null> {
  try {
    const pool = canonicalPool(mint);
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/minute?aggregate=1&limit=40&currency=usd&token=${mint}`, { headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    const j: any = await r.json();
    const c: number[][] = (j?.data?.attributes?.ohlcv_list || []).slice().sort((a: number[], b: number[]) => a[0] - b[0]);
    if (c.length < 20) return null;
    const ys = c.map((x) => Math.log(Math.max(1e-12, Number(x[4]))));
    const n = ys.length;
    const xm = (n - 1) / 2;
    const ym = ys.reduce((a, y) => a + y, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    ys.forEach((y, i) => ((sxy += (i - xm) * (y - ym)), (sxx += (i - xm) ** 2), (syy += (y - ym) ** 2)));
    const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
    const climb = Math.exp(ys[n - 1] - ys[0]) - 1;
    let hi = -Infinity, dd = 0;
    for (const x of c) {
      hi = Math.max(hi, Number(x[2]));
      dd = Math.max(dd, 1 - Number(x[3]) / hi);
    }
    const red = c.filter((x) => Number(x[4]) < Number(x[1])).length / n;
    const drawn = r2 >= 0.97 && dd < 0.05 && climb >= 0.3 && red < 0.15;
    return { rule: "not_a_drawn_line", ok: !drawn, v: `${n}m: up ${Math.round(climb * 100)}%, fit ${r2.toFixed(2)}, worst dip ${Math.round(dd * 100)}%, ${Math.round(red * 100)}% red candles`, hard: false };
  } catch {
    return null;
  }
}

/** One wallet or the top 10 holding too much (the curve or the pool vault excluded: the biggest account). */
async function holderCheck(mint: string): Promise<ShieldCheck | null> {
  const la = await conn().getTokenLargestAccounts(new PublicKey(mint)).catch(() => null);
  const amts = (la?.value || []).map((x) => Number(x.uiAmount || 0)).sort((a, b) => b - a);
  if (amts.length < 3) return null;
  const rest = amts.slice(1);
  const top1 = (rest[0] / 1e9) * 100;
  const top10 = (rest.slice(0, 10).reduce((a, x) => a + x, 0) / 1e9) * 100;
  return { rule: "holders_spread", ok: top1 < 12 && top10 < 45, v: `largest holder ${top1.toFixed(1)}%, top 10 ${top10.toFixed(1)}%`, hard: false };
}

export type ShieldInput = { mint: string; symbol: string; grad: boolean; sol: number; tokensRaw: bigint; tape?: any; buys5?: number; sells5?: number; ageMs?: number; v5?: number; mcUsd?: number };

/** Run every check in parallel (about one second). */
export async function shield(x: ShieldInput): Promise<ShieldResult> {
  const r = redis();
  const rt = (await r.hget<any>("rn:rt", x.mint).catch(() => null)) as any;
  // a mint that passed its authority checks once stays clean (authorities can be revoked, never added back), so the
  // result is cached: a second signal on the same coin skips the chain read
  const mk = `rn:shield:mint:${x.mint}`;
  const cachedMint = (await r.get<ShieldCheck[]>(mk).catch(() => null)) as ShieldCheck[] | null;
  const young = !x.grad && x.ageMs != null && x.ageMs < 3 * 60_000;
  const [mintC, sellC, lineC, holdC] = await Promise.all([
    cachedMint ? Promise.resolve(cachedMint) : mintChecks(x.mint).then(async (c) => {
      if (c.length && c.every((k) => k.ok) && !c.some((k) => /skipped/.test(k.v))) await r.set(mk, c, { ex: 6 * 3600 }).catch(() => {});
      return c;
    }).catch(() => [] as ShieldCheck[]),
    x.grad ? sellCheck(x.mint, x.tokensRaw, x.sol) : Promise.resolve(null), // the pump curve always buys back
    x.grad ? lineCheck(x.mint) : Promise.resolve(null),
    // on a curve a few minutes old the curve holds nearly everything and a handful of first buyers always look
    // "concentrated": the holder read says nothing yet and costs a slow chain call, so it waits until minute 3
    young ? Promise.resolve(null) : holderCheck(x.mint).catch(() => null),
  ]);
  const checks: ShieldCheck[] = [...mintC];
  // a migrated coin must trade in the pool pump.fun's own migration created (its LP is burned by the migration). A
  // pool someone opened by hand (any coin not launched on pump.fun, like $ALLOX: PumpSwap pool, 100% of the LP held
  // by one wallet) can be emptied by its owner at any moment: a rug waiting to happen, however good the chart looks
  if (x.grad) {
    const pr = await readPools([x.mint]).catch(() => null);
    const canon = pr?.[x.mint];
    checks.push({ rule: "lp_burned", ok: !!canon && canon.sol > 0.5, v: canon && canon.sol > 0.5 ? `pump.fun migration pool, ${Math.round(canon.sol)} SOL` : "not a pump.fun migration pool: the liquidity is held by a wallet and can be pulled", hard: true });
  }
  // wash trading: 5-minute volume several times the whole market cap is bots trading with themselves (fake volume to
  // pull buyers in), not demand
  if (x.v5 != null && x.mcUsd != null && x.mcUsd > 0) checks.push({ rule: "real_volume", ok: x.v5 <= x.mcUsd * 4, v: `$${Math.round(x.v5 / 1000)}K volume in 5m on a $${Math.round(x.mcUsd / 1000)}K market cap (${(x.v5 / x.mcUsd).toFixed(1)}x)`, hard: false });
  if (sellC) checks.push(sellC);
  // nobody selling: the live tape (worker) or MOMO's 5-minute counts
  const b = rt && Date.now() - rt.at < 60_000 ? rt.b20 : x.buys5;
  const s = rt && Date.now() - rt.at < 60_000 ? rt.s20 : x.sells5;
  // in a launch's first minutes nobody has sold yet as a rule (everyone is still buying): the honeypot test only
  // means something once the coin is a few minutes old or migrated
  if (b != null && s != null && !young) checks.push({ rule: "sells_happen", ok: !(b >= 20 && s === 0), v: `${b} buys, ${s} sells`, hard: true });
  if (lineC) checks.push(lineC);
  if (holdC) checks.push(holdC);
  const t = x.tape;
  if (t) checks.push({ rule: "no_block0_farm", ok: !t.farm?.farm && (t.bundleShare ?? 0) <= 0.6 && (t.instant ?? 0) < 40, v: t.farm?.farm ? t.farm.why : `bundle ${Math.round((t.bundleShare ?? 0) * 100)}%, ${Math.round(t.instant ?? 0)}% of the curve in blocks 0-2`, hard: false });
  const hardFail = checks.find((c) => c.hard && !c.ok) || null;
  const softFail = checks.find((c) => !c.hard && !c.ok) || null;
  return { ok: !hardFail && !softFail, hardFail, softFail, checks };
}
