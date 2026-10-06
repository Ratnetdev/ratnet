// The Rat Desk: eight agents that turn Rat King calls into trades.
// Paper first. When it passes its own public exam and finds a funded wallet, it promotes itself to live.
// Positions are re-read from the bonding curve every 2 seconds inside the desk loop, so sells are fast.

import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { K, dayKey, redis } from "./redis";
import { conn, getCurves, safeErr, CurveView } from "./solana";
import { getMarket } from "./market";
import { getSettings } from "./settings";
import type { Launch } from "./digger";

export type Agent = "SCOUT" | "KING" | "VET" | "FLOW" | "SIZE" | "EXEC" | "RISK" | "LEDGER";
export const AGENTS: { id: Agent; role: string }[] = [
  { id: "SCOUT", role: "digs every launch" },
  { id: "KING", role: "calls it at minute 5" },
  { id: "VET", role: "checks the dev and the curve" },
  { id: "FLOW", role: "reads buy and sell pressure" },
  { id: "SIZE", role: "decides how much" },
  { id: "EXEC", role: "buys and sells" },
  { id: "RISK", role: "takes profit, cuts losses" },
  { id: "LEDGER", role: "keeps the books" },
];

export type Tone = "ok" | "bad" | "info" | "win" | "loss";
export type DeskEv = { agent: Agent; at: number; mint?: string; symbol?: string; text: string; tone: Tone };
export type Sample = [number, number, number]; // [time, price SOL, real SOL in curve]
export type Pos = {
  mint: string;
  symbol: string;
  name: string;
  openedAt: number;
  entryPx: number;
  costSol: number;
  tokens: number; // tokens still held
  tokens0: number;
  soldSol: number;
  tp1Done: boolean;
  lastPx: number;
  peakPx: number;
  king: number;
  nano: number | null;
  live: boolean;
  series: Sample[];
};
export type Trade = {
  id: string;
  mint: string;
  symbol: string;
  side: "buy" | "sell";
  at: number;
  sol: number;
  tokens: number;
  px: number;
  reason: string;
  pnlSol?: number;
  pnlPct?: number;
  live: boolean;
  sig?: string;
};
export type DeskState = {
  live: boolean;
  cash: number; // paper cash
  start: number;
  startedAt: number;
  realized: number;
  closed: number; // positions fully closed
  wins: number;
  dayKey: string;
  dayStart: number;
  peakEq: number;
  maxDD: number; // worst drawdown seen, %
  liveStart: number | null;
  promotedAt: number | null;
  demotions: number;
  lastEqAt: number;
  equity: number;
};
export type Exam = { trades: number; winRate: number; pnlPct: number; maxDD: number; walletSol: number | null; checks: { label: string; need: string; now: string; ok: boolean }[]; passed: boolean };

export const EXAM = { trades: 30, winRate: 40, pnlPct: 10, maxDD: 30, minWallet: 0.5, liveMaxDD: 40 };
const FEE = 0.01; // pump.fun fee per side
const PAPER_SLIP = 0.02; // assumed slippage per side on paper
const WSOL = "So11111111111111111111111111111111111111112";
const LOOP_MS = 2000;

// ---------------------------------------------------------------- state

async function loadState(start: number): Promise<DeskState> {
  const s = await redis().get<DeskState>(K.deskState);
  if (s) return s;
  return { live: false, cash: start, start, startedAt: Date.now(), realized: 0, closed: 0, wins: 0, dayKey: dayKey(), dayStart: start, peakEq: start, maxDD: 0, liveStart: null, promotedAt: null, demotions: 0, lastEqAt: 0, equity: start };
}

export async function resetDesk() {
  const r = redis();
  const s = await getSettings();
  await r.del(K.deskState, K.deskPos, K.deskTrades, K.deskEv, K.deskQ, K.deskEq, K.deskAgent, K.deskVet);
  await loadState(s.desk.start);
}

function wallet(): Keypair | null {
  const sec = process.env.DESK_WALLET_SECRET;
  if (!sec) return null;
  try {
    return Keypair.fromSecretKey(sec.trim().startsWith("[") ? Uint8Array.from(JSON.parse(sec)) : bs58.decode(sec.trim()));
  } catch {
    return null;
  }
}
export function deskWalletAddress() {
  return wallet()?.publicKey.toBase58() || null;
}

// ---------------------------------------------------------------- jupiter (live execution)

const JUP = process.env.JUPITER_API_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1";
const jupHeaders = (): Record<string, string> => (process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {});

async function swap(kp: Keypair, inputMint: string, outputMint: string, amountRaw: bigint, slippageBps: number) {
  const q = await fetch(`${JUP}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`, {
    headers: jupHeaders(),
    cache: "no-store",
  });
  if (!q.ok) throw new Error(`no route (${q.status})`);
  const quote = await q.json();
  if (!quote?.outAmount) throw new Error("no route");
  const s = await fetch(`${JUP}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json", ...jupHeaders() },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: kp.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 3_000_000, priorityLevel: "veryHigh" } },
    }),
    cache: "no-store",
  });
  if (!s.ok) throw new Error(`swap build failed (${s.status})`);
  const { swapTransaction } = await s.json();
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([kp]);
  const raw = tx.serialize();
  const c = conn();
  const sig = await c.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  // rebroadcast every 1.5s until confirmed or 25s pass
  const t0 = Date.now();
  while (Date.now() - t0 < 25_000) {
    const st = await c.getSignatureStatuses([sig]);
    const v = st.value[0];
    if (v?.err) throw new Error(`tx failed ${sig.slice(0, 8)}`);
    if (v?.confirmationStatus === "confirmed" || v?.confirmationStatus === "finalized") return { sig, outRaw: BigInt(quote.outAmount) };
    await c.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error(`not confirmed ${sig.slice(0, 8)}`);
}

async function tokenBalanceRaw(owner: PublicKey, mint: string): Promise<bigint> {
  const res = await conn().getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });
  return res.value.reduce((a, acc: any) => a + BigInt(acc.account.data.parsed?.info?.tokenAmount?.amount || "0"), 0n);
}

// ---------------------------------------------------------------- logging

type Batch = { ev: DeskEv[]; trades: Trade[] };
function log(b: Batch, agent: Agent, text: string, tone: Tone = "info", coin?: { mint: string; symbol: string }) {
  b.ev.push({ agent, at: Date.now(), text, tone, mint: coin?.mint, symbol: coin?.symbol });
}
async function flushLog(b: Batch) {
  if (!b.ev.length && !b.trades.length) return;
  const p = redis().pipeline();
  if (b.ev.length) {
    p.lpush(K.deskEv, ...b.ev);
    p.ltrim(K.deskEv, 0, 299);
    const last: Record<string, DeskEv> = {};
    for (const e of b.ev) last[e.agent] = e;
    p.hset(K.deskAgent, last);
    // the Rat Cam and the main feed show desk moves too
    const feed = b.ev
      .filter((e) => e.agent === "EXEC" || e.agent === "RISK" || (e.agent === "LEDGER" && e.tone !== "info"))
      .map((e) => ({ kind: "desk", rat: `DESK·${e.agent}`, mint: e.mint || "", symbol: e.symbol || "", name: "", at: e.at, text: e.text }));
    if (feed.length) {
      p.lpush(K.feed, ...feed);
      p.ltrim(K.feed, 0, 299);
    }
  }
  if (b.trades.length) {
    p.lpush(K.deskTrades, ...b.trades);
    p.ltrim(K.deskTrades, 0, 499);
  }
  await p.exec();
  b.ev = [];
  b.trades = [];
}

const pct = (a: number, b: number) => (b ? ((a - b) / b) * 100 : 0);
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

// ---------------------------------------------------------------- exam

export async function exam(state: DeskState, walletSol: number | null): Promise<Exam> {
  const trades = ((await redis().lrange<Trade>(K.deskTrades, 0, 499)) || []).filter((t) => t.side === "sell" && !t.live && t.pnlSol != null);
  // a position can close in several sells; group by mint+open to count each round trip once
  const byPos: Record<string, number> = {};
  for (const t of trades) byPos[t.mint] = (byPos[t.mint] || 0) + (t.pnlSol || 0);
  const rounds = Object.values(byPos);
  const last = rounds.slice(0, 50);
  const wins = last.filter((x) => x > 0).length;
  const winRate = last.length ? (wins / last.length) * 100 : 0;
  const pnlPct = pct(state.equity, state.start);
  const checks = [
    { label: "paper round trips", need: `≥ ${EXAM.trades}`, now: String(rounds.length), ok: rounds.length >= EXAM.trades },
    { label: "win rate", need: `≥ ${EXAM.winRate}%`, now: `${winRate.toFixed(0)}%`, ok: winRate >= EXAM.winRate },
    { label: "paper profit", need: `≥ +${EXAM.pnlPct}%`, now: fmtPct(pnlPct), ok: pnlPct >= EXAM.pnlPct },
    { label: "worst drawdown", need: `≤ ${EXAM.maxDD}%`, now: `${state.maxDD.toFixed(0)}%`, ok: state.maxDD <= EXAM.maxDD },
    { label: "funded wallet", need: `≥ ${EXAM.minWallet} SOL`, now: walletSol == null ? "none" : `${walletSol.toFixed(2)} SOL`, ok: walletSol != null && walletSol >= EXAM.minWallet },
  ];
  return { trades: rounds.length, winRate, pnlPct, maxDD: state.maxDD, walletSol, checks, passed: checks.every((c) => c.ok) };
}

// ---------------------------------------------------------------- the loop

async function priceOf(mints: string[]) {
  const curves = mints.length ? await getCurves(mints) : {};
  const done = mints.filter((m) => !curves[m] || curves[m]!.complete);
  const mkt = done.length ? await getMarket(done).catch(() => ({} as Record<string, any>)) : {};
  const px: Record<string, { px: number; real: number; curve: CurveView | null; grad: boolean }> = {};
  for (const m of mints) {
    const c = curves[m];
    if (c && !c.complete && c.priceSol > 0) px[m] = { px: c.priceSol, real: c.realSol, curve: c, grad: false };
    else if (mkt[m]?.pn) px[m] = { px: mkt[m].pn, real: 0, curve: c, grad: true };
  }
  return px;
}

/**
 * One desk session: loops every 2s for up to `budgetMs`, handling entries from the queue and exits for every position.
 * Called by the cron pinger (budget ~50s) so coverage is continuous with one ping a minute.
 */
export async function deskSession(budgetMs = 50_000, onBeat?: () => Promise<unknown>) {
  const r = redis();
  const got = await r.set("rn:lock:desk", Date.now(), { nx: true, ex: Math.ceil(budgetMs / 1000) + 8 });
  if (!got) return { skipped: "busy" };
  const t0 = Date.now();
  let loops = 0;
  const b: Batch = { ev: [], trades: [] };
  try {
    const s = await getSettings();
    const cfg = s.desk;
    if (cfg.mode === "off") return { off: true };
    let state = await loadState(cfg.start);
    const kp = wallet();
    let lastBeat = 0;
    const recent: Record<string, Sample[]> = {}; // 2s samples kept in memory for the flow read

    while (Date.now() - t0 < budgetMs) {
      loops++;
      const now = Date.now();
      if (onBeat && now - lastBeat > 10_000) {
        lastBeat = now;
        await onBeat().catch(() => {});
      }
      const posMap = (await r.hgetall<Record<string, Pos>>(K.deskPos)) || {};
      const positions = Object.values(posMap);
      const queued = (await r.zrange<string[]>(K.deskQ, 0, 9)) || [];

      // --- promotion / demotion
      const walletSol = kp ? (await conn().getBalance(kp.publicKey).catch(() => 0)) / 1e9 : null;
      if (!state.live && (cfg.mode === "live" || cfg.mode === "auto") && kp && !positions.length) {
        const ex = cfg.mode === "live" ? { passed: walletSol != null && walletSol >= EXAM.minWallet } : await exam(state, walletSol);
        if (ex.passed) {
          state.live = true;
          state.liveStart = walletSol;
          state.promotedAt = now;
          state.peakEq = walletSol || 0;
          log(b, "LEDGER", `exam passed. going live with ${walletSol?.toFixed(3)} SOL`, "win");
        }
      }

      const closeAll = !!(await r.get("rn:desk:closeall"));
      if (closeAll) await r.del("rn:desk:closeall");

      // --- prices for everything we hold or might buy
      const px = await priceOf(Array.from(new Set([...positions.map((p) => p.mint), ...queued])));

      // --- exits (RISK)
      for (const p of positions) {
        const q = px[p.mint];
        if (!q) continue;
        p.lastPx = q.px;
        p.peakPx = Math.max(p.peakPx, q.px);
        const rs = (recent[p.mint] ||= []);
        rs.push([now, q.px, q.real]);
        while (rs.length && now - rs[0][0] > 60_000) rs.shift();
        const lastS = p.series[p.series.length - 1];
        if (!lastS || now - lastS[0] >= 10_000) p.series.push([now, q.px, q.real]);
        if (p.series.length > 360) p.series = p.series.slice(-360);
        const gain = pct(q.px, p.entryPx);
        const age = (now - p.openedAt) / 60_000;
        // selling pressure: SOL leaving the curve over the last ~40s
        const back = rs.filter((x) => now - x[0] <= 40_000);
        const drain = back.length > 3 && back[0][2] > 0 ? pct(q.real, back[0][2]) : 0;
        let sellFrac = 0;
        let reason = "";
        if (closeAll) [sellFrac, reason] = [1, "manual close"];
        else if (q.grad && cfg.sellOnGrad) [sellFrac, reason] = [1, "graduated, sold into the migration"];
        else if (gain <= cfg.sl) [sellFrac, reason] = [1, `stop loss ${fmtPct(gain)}`];
        else if (!p.tp1Done && gain >= cfg.tp1) [sellFrac, reason] = [cfg.tp1Frac, `take profit 1 at ${fmtPct(gain)}`];
        else if (gain >= cfg.tp2) [sellFrac, reason] = [1, `take profit 2 at ${fmtPct(gain)}`];
        else if (drain <= -20 && gain < cfg.tp1) [sellFrac, reason] = [1, `sellers took over: curve ${drain.toFixed(0)}% in 40s`];
        else if (age >= cfg.timeStop) [sellFrac, reason] = [1, `time stop ${Math.round(age)}m at ${fmtPct(gain)}`];
        if (sellFrac > 0) {
          const ok = await sell(b, state, p, sellFrac, q.px, reason, cfg.slippageBps, kp);
          if (ok && sellFrac < 1) p.tp1Done = true;
        }
        if (p.tokens > 0) await r.hset(K.deskPos, { [p.mint]: p });
        else await r.hdel(K.deskPos, p.mint);
      }

      // --- entries (VET -> FLOW -> SIZE -> EXEC)
      const eq = await equity(state, kp, px);
      if (eq.dayKey !== state.dayKey) {
        state.dayKey = eq.dayKey;
        state.dayStart = eq.value;
      }
      for (const m of queued) {
        await r.zrem(K.deskQ, m);
        const rec = await r.get<Launch>(K.launch(m));
        if (!rec || rec.outcome || !rec.call) continue;
        const coin = { mint: m, symbol: rec.symbol };
        const q = px[m];
        const curve = q?.curve?.progress ?? 0;
        const open = (await r.hlen(K.deskPos)) || 0;
        const checks = [
          { rule: "king_or_nano_bond", ok: rec.call.verdict === "BOND" || rec.call.nano?.verdict === "BOND", v: `${rec.call.verdict} ${rec.call.score}` },
          { rule: "nano_agrees", ok: !cfg.needNano || rec.call.nano?.verdict === "BOND", v: rec.call.nano ? `${rec.call.nano.verdict} ${rec.call.nano.score}` : "learning" },
          { rule: "curve_window", ok: curve >= cfg.minCurve && curve <= cfg.maxCurve, v: `${curve}%` },
          { rule: "dev_not_serial", ok: !((rec.devN ?? 0) >= cfg.serialDev && (rec.devB ?? 0) === 0), v: `${rec.devN ?? 0} launches, ${rec.devB ?? 0} bonded` },
          { rule: "dev_buy_sane", ok: rec.devBuySol <= cfg.maxDevBuy, v: `${rec.devBuySol} SOL` },
          { rule: "fresh_call", ok: now - rec.call.at < 3 * 60_000, v: `${Math.round((now - rec.call.at) / 1000)}s old` },
          { rule: "open_slots", ok: open < cfg.maxOpen && !posMap[m], v: `${open}/${cfg.maxOpen}` },
          { rule: "daily_loss_ok", ok: pct(eq.value, state.dayStart) > -cfg.dailyLoss, v: fmtPct(pct(eq.value, state.dayStart)) },
        ];
        const fail = checks.find((c) => !c.ok);
        await r.set(K.deskVet, { mint: m, symbol: rec.symbol, at: now, checks }, { ex: 3600 });
        if (fail) {
          log(b, "VET", `passed on $${rec.symbol}: ${fail.rule.replace(/_/g, " ")} (${fail.v})`, "bad", coin);
          continue;
        }
        log(b, "VET", `$${rec.symbol} clean: curve ${curve}%, dev ${rec.devN ?? 0}/${rec.devB ?? 0}`, "ok", coin);

        // FLOW: live pressure on the curve over a few seconds plus the last hour of trades
        const before = q?.real ?? 0;
        await new Promise((res) => setTimeout(res, 3000));
        const again = (await getCurves([m]))[m];
        const delta = again && before ? pct(again.realSol, before) : 0;
        const mk = (await getMarket([m]).catch(() => ({} as any)))[m];
        const tot = (mk?.b1 || 0) + (mk?.s1 || 0);
        const buyShare = tot ? mk.b1 / tot : null;
        if (delta <= -5 || (buyShare != null && tot >= 8 && buyShare < cfg.minFlow)) {
          log(b, "FLOW", `$${rec.symbol} selling: curve ${delta.toFixed(1)}% in 3s${buyShare != null ? `, buys ${(buyShare * 100).toFixed(0)}% of flow` : ""}`, "bad", coin);
          continue;
        }
        log(b, "FLOW", `$${rec.symbol} bid: curve ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}% in 3s${buyShare != null ? `, buys ${(buyShare * 100).toFixed(0)}%` : ""}`, "ok", coin);

        // SIZE
        const avail = state.live ? (walletSol ?? 0) - 0.02 : state.cash;
        const size = Math.min(cfg.maxSol, Math.max(cfg.minSol, (eq.value * cfg.sizePct) / 100), avail * 0.95);
        if (size < cfg.minSol * 0.99) {
          log(b, "SIZE", `no room for $${rec.symbol}: ${avail.toFixed(3)} SOL free`, "bad", coin);
          continue;
        }
        log(b, "SIZE", `${size.toFixed(3)} SOL on $${rec.symbol} (${cfg.sizePct}% of desk)`, "info", coin);

        // EXEC
        const entryPx = again?.priceSol || q?.px || 0;
        if (!entryPx) continue;
        const pos = await buy(b, state, rec, size, entryPx, cfg.slippageBps, kp, again?.realSol ?? 0);
        if (pos) await r.hset(K.deskPos, { [m]: pos });
      }

      // --- books
      const eq2 = await equity(state, kp, px);
      state.equity = eq2.value;
      state.peakEq = Math.max(state.peakEq, eq2.value);
      const dd = state.peakEq ? -pct(eq2.value, state.peakEq) : 0;
      state.maxDD = Math.max(state.maxDD, dd);
      if (state.live && state.liveStart && pct(eq2.value, state.liveStart) <= -EXAM.liveMaxDD) {
        state.live = false;
        state.demotions++;
        state.cash = state.start;
        state.maxDD = 0;
        state.peakEq = state.start;
        log(b, "LEDGER", `live drawdown hit ${EXAM.liveMaxDD}%. back to paper to re-take the exam`, "loss");
      }
      if (now - state.lastEqAt >= 60_000) {
        state.lastEqAt = now;
        await r.rpush(K.deskEq, { t: now, eq: r4(eq2.value), live: state.live });
        await r.ltrim(K.deskEq, -3000, -1);
      }
      await r.set(K.deskState, state);
      await flushLog(b);
      const wait = LOOP_MS - (Date.now() - now);
      if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    }
    return { loops };
  } catch (e) {
    log(b, "LEDGER", `desk error: ${safeErr(e)}`, "bad");
    await flushLog(b).catch(() => {});
    return { error: safeErr(e), loops };
  } finally {
    await r.del("rn:lock:desk");
  }
}

async function equity(state: DeskState, kp: Keypair | null, px: Record<string, { px: number }>) {
  const pos = Object.values((await redis().hgetall<Record<string, Pos>>(K.deskPos)) || {}).filter((p) => p.live === state.live);
  const held = pos.reduce((a, p) => a + p.tokens * (px[p.mint]?.px ?? p.lastPx) * (1 - FEE), 0);
  const cash = state.live && kp ? (await conn().getBalance(kp.publicKey).catch(() => 0)) / 1e9 : state.cash;
  return { value: cash + held, dayKey: dayKey() };
}

async function buy(b: Batch, state: DeskState, rec: Launch, sol: number, px: number, slip: number, kp: Keypair | null, real: number): Promise<Pos | null> {
  const coin = { mint: rec.mint, symbol: rec.symbol };
  let tokens = 0;
  let sig: string | undefined;
  let fillPx = px;
  if (state.live && kp) {
    try {
      const res = await swap(kp, WSOL, rec.mint, BigInt(Math.floor(sol * 1e9)), slip);
      tokens = Number(res.outRaw) / 1e6;
      sig = res.sig;
      fillPx = sol / Math.max(tokens, 1e-9);
    } catch (e) {
      log(b, "EXEC", `buy $${rec.symbol} failed: ${safeErr(e)}`, "bad", coin);
      return null;
    }
  } else {
    fillPx = px * (1 + PAPER_SLIP);
    tokens = (sol * (1 - FEE)) / fillPx;
    state.cash -= sol;
  }
  const now = Date.now();
  b.trades.push({ id: `${now}${rec.mint.slice(0, 4)}b`, mint: rec.mint, symbol: rec.symbol, side: "buy", at: now, sol: r4(sol), tokens, px: fillPx, reason: `King ${rec.call?.verdict} ${rec.call?.score}`, live: state.live, sig });
  log(b, "EXEC", `bought $${rec.symbol} for ${sol.toFixed(3)} SOL${state.live ? "" : " (paper)"}`, "ok", coin);
  return {
    mint: rec.mint,
    symbol: rec.symbol,
    name: rec.name,
    openedAt: now,
    entryPx: fillPx,
    costSol: sol,
    tokens,
    tokens0: tokens,
    soldSol: 0,
    tp1Done: false,
    lastPx: px,
    peakPx: px,
    king: rec.call?.score ?? 0,
    nano: rec.call?.nano?.score ?? null,
    live: state.live,
    series: [[now, px, real]],
  };
}

async function sell(b: Batch, state: DeskState, p: Pos, frac: number, px: number, reason: string, slip: number, kp: Keypair | null) {
  const coin = { mint: p.mint, symbol: p.symbol };
  const amt = frac >= 1 ? p.tokens : p.tokens * frac;
  let proceeds = 0;
  let sig: string | undefined;
  if (p.live && kp) {
    try {
      const have = await tokenBalanceRaw(kp.publicKey, p.mint);
      const raw = frac >= 1 ? have : (have * BigInt(Math.round(frac * 1000))) / 1000n;
      if (raw <= 0n) {
        p.tokens = 0;
        return true;
      }
      const res = await swap(kp, p.mint, WSOL, raw, slip);
      proceeds = Number(res.outRaw) / 1e9;
      sig = res.sig;
    } catch (e) {
      log(b, "RISK", `sell $${p.symbol} failed, retrying next beat: ${safeErr(e)}`, "bad", coin);
      return false;
    }
  } else {
    proceeds = amt * px * (1 - PAPER_SLIP) * (1 - FEE);
    state.cash += proceeds;
  }
  const costPart = p.costSol * (amt / p.tokens0);
  const pnl = proceeds - costPart;
  p.tokens -= amt;
  p.soldSol += proceeds;
  state.realized += pnl;
  const now = Date.now();
  const pnlPct = pct(proceeds, costPart);
  b.trades.push({ id: `${now}${p.mint.slice(0, 4)}s`, mint: p.mint, symbol: p.symbol, side: "sell", at: now, sol: r4(proceeds), tokens: amt, px, reason, pnlSol: r4(pnl), pnlPct: Math.round(pnlPct * 10) / 10, live: p.live, sig });
  log(b, "RISK", `${reason}: sold ${frac >= 1 ? "all" : `${Math.round(frac * 100)}%`} of $${p.symbol}`, pnl >= 0 ? "win" : "loss", coin);
  if (p.tokens <= 1e-9) {
    p.tokens = 0;
    state.closed++;
    const total = p.soldSol - p.costSol;
    if (total > 0) state.wins++;
    log(b, "LEDGER", `closed $${p.symbol} ${total >= 0 ? "+" : ""}${total.toFixed(3)} SOL (${fmtPct(pct(p.soldSol, p.costSol))})`, total >= 0 ? "win" : "loss", coin);
  }
  return true;
}

// ---------------------------------------------------------------- read side

export async function getDesk() {
  const r = redis();
  const s = await getSettings();
  const p = r.pipeline();
  p.get(K.deskState);
  p.hgetall(K.deskPos);
  p.lrange(K.deskTrades, 0, 59);
  p.lrange(K.deskEv, 0, 59);
  p.lrange(K.deskEq, -720, -1);
  p.hgetall(K.deskAgent);
  p.get(K.deskVet);
  const [st, pos, trades, ev, eqs, agents, vet] = (await p.exec()) as any[];
  const state: DeskState = st || (await loadState(s.desk.start));
  const addr = deskWalletAddress();
  const walletSol = addr ? (await conn().getBalance(new PublicKey(addr)).catch(() => 0)) / 1e9 : null;
  const ex = await exam(state, walletSol);
  return {
    mode: s.desk.mode,
    live: state.live,
    wallet: state.live ? addr : null,
    walletReady: !!addr,
    cfg: s.desk,
    state,
    exam: ex,
    positions: Object.values(pos || {}),
    trades: trades || [],
    events: ev || [],
    equity: eqs || [],
    agents: agents || {},
    vet: vet || null,
  };
}
