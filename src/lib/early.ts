// v0.1.115 EARLY: every launch, read at 2 minutes old, before any call.
//
// 17 Oct, 3.1K King calls over 14 days: buying at the call lost after costs, whatever the signals said. GRID SCORE's
// top calls migrated 7.8x more often and still lost (the migration was priced in by the call), the PROFIT SCORE found
// more small wins and a worse average trade. If there is an edge, it is earlier: before the King's call, before the move.
//
// So every launch that is still alive at 2 minutes (5%+ up its curve) is read from the firehose at that moment: the
// curve, the last minute's buyers and buy share, whales, proven wallets, KOL flow, the first 20 buyers, the dev, its
// origin (first or copy, creator) and DexScreener orders. The read is archived (early_reads), and its price is followed
// from then on (every 10 seconds for the first hour, then a minute for a day, and the pool after a migration), for
// every coin read: the ones that died too. That is what the EARLY search (GRID on these reads) needs to be honest: no
// coin is picked by what happened after its read. GRID LIVE's EARLY books trade the same read on live launches (paper).
import type { GCoin } from "./grid";
import { RUN_MS } from "./grid";
import { archiveEarly, archivePoolTick, archiveTick, runTrack } from "./archive";

export const EARLY_SECS = () => Math.max(30, Number(process.env.EARLY_SECS ?? 120) || 120);
const MIN_PROG = () => Math.max(0, Number(process.env.EARLY_MIN_PROG ?? 5) || 0);
const PER_DAY = () => Math.max(0, Number(process.env.EARLY_PER_DAY ?? 4000) || 0);
const TRACK_MS = 62 * 60_000; // then the RUN track takes over (a price a minute, for a day)

/** The read. Unknown stays null and never passes a rule. */
export type EarlyF = {
  p: number; // curve %
  mc: number; // market cap (SOL)
  real: number; // real SOL in the curve
  r60: number | null; // curve points gained in the last minute
  pw: number | null;
  u60: number | null;
  bs60: number | null;
  wh: number | null;
  ds: boolean;
  kf: number | null;
  kmu: number | null;
  kx: number | null;
  e20: number | null;
  og: { rank: number; cr: number; alpha: 0 | 1 | null; beta: 0 | 1 | null } | null;
  dx: { paid: 0 | 1 | null; boost: number | null } | null;
  sym?: string;
};
type Curve = { progress: number; mcapSol: number; realSol: number; complete?: boolean };
type Pend = { at: number; sym: string; v?: Curve; p60?: number };
const PEND = new Map<string, Pend>();
const TRACK = new Map<string, number>(); // mint -> read time
export const earlyStats = { seen: 0, read: 0, skipped: 0, capped: 0, tracked: 0, day: "", dayN: 0 };

/** A launch (worker: the firehose create). */
export function earlyCreate(mint: string, createdAt: number, sym = "") {
  if (!mint || PEND.has(mint)) return;
  if (PEND.size > 60_000) PEND.delete(PEND.keys().next().value as string);
  PEND.set(mint, { at: createdAt, sym: sym.slice(0, 16) });
  earlyStats.seen++;
}
/** Every curve update (worker: the firehose). Keeps the last one for the read, and the path of read coins for an hour. */
export function earlyCurve(mint: string, v: Curve, now = Date.now()) {
  const p = PEND.get(mint);
  if (p) {
    p.v = v;
    if (p.p60 == null && now - p.at >= EARLY_SECS() * 1000 - 60_000) p.p60 = v.progress;
  }
  const t = TRACK.get(mint);
  if (t == null) return;
  if (now - t > TRACK_MS) return void TRACK.delete(mint);
  archiveTick(mint, { ...v, complete: !!v.complete }, now);
}

const MIG = new Map<string, number>(); // read coins that migrated within their first hour: first pool price time
/** Pool prices (worker: the firehose) of read coins that migrated within the hour (the RUN track covers the rest). */
export function earlyPool(mint: string, q: { mcSol: number; real: number }, now = Date.now()) {
  const t = TRACK.get(mint);
  if (t == null || now - t > TRACK_MS) return;
  if (!MIG.has(mint)) {
    if (MIG.size > 5_000) MIG.clear();
    MIG.set(mint, now);
  }
  archivePoolTick(mint, q, MIG.get(mint)!, now);
}

/** Every 5 seconds (worker): the launches that just turned 2 minutes old are read. Returns the reads made. */
export function earlySweep(featuresOf: (mint: string, now: number) => Omit<EarlyF, "p" | "mc" | "real" | "r60"> | null, now = Date.now()) {
  const out: { mint: string; at: number; createdAt: number; f: EarlyF }[] = [];
  const due = EARLY_SECS() * 1000;
  const day = new Date(now).toISOString().slice(0, 10);
  if (earlyStats.day !== day) (earlyStats.day = day), (earlyStats.dayN = 0);
  for (const [mint, p] of PEND) {
    if (now - p.at < due) continue;
    PEND.delete(mint);
    const v = p.v;
    if (!v || v.complete || !(v.progress >= MIN_PROG()) || now - p.at > due + 60_000) {
      earlyStats.skipped++;
      continue;
    }
    if (earlyStats.dayN >= PER_DAY()) {
      earlyStats.capped++;
      continue;
    }
    const x = featuresOf(mint, now);
    if (!x) {
      earlyStats.skipped++;
      continue;
    }
    const f: EarlyF = { ...x, p: v.progress, mc: v.mcapSol, real: v.realSol, r60: p.p60 != null ? Math.round((v.progress - p.p60) * 10) / 10 : null, sym: p.sym };
    earlyStats.dayN++;
    earlyStats.read++;
    archiveEarly(mint, now, p.at, f);
    TRACK.set(mint, now);
    if (TRACK.size > 20_000) for (const [m, t] of TRACK) if (now - t > TRACK_MS) TRACK.delete(m);
    earlyStats.tracked = TRACK.size;
    runTrack(mint, now);
    archiveTick(mint, { ...v, complete: !!v.complete }, now);
    out.push({ mint, at: now, createdAt: p.at, f });
  }
  return out;
}

/** The read as a GRID coin (no path): the same mapping for the archive (the EARLY search) and live (GRID LIVE). */
export function earlyCoin(mint: string, at: number, createdAt: number, f: EarlyF): Omit<GCoin, "t" | "mc" | "real" | "prog" | "done"> {
  return {
    mint,
    symbol: String(f.sym || ""),
    at,
    createdAt,
    verdict: "EARLY", // no King call: the call rules never pass
    score: 0,
    nano: null,
    progress: Number(f.p) || 0,
    rise60: f.r60 ?? 0,
    uniq: null,
    spb: null,
    bs: null,
    sn: null,
    sm: 0,
    ds: !!f.ds,
    soc: 0,
    pw: f.pw ?? null,
    u60: f.u60 ?? null,
    bs60: f.bs60 ?? null,
    wh: f.wh ?? null,
    kf: f.kf ?? null,
    kmu: f.kmu ?? null,
    kx: f.kx ?? null,
    e20: f.e20 ?? null,
    sx: { post: null, bigpost: null, pulse: null, lens: null, xf: null, tg: null, kol: null, ftop: null, mind: null, og: f.og ?? null, dx: f.dx ?? null },
  };
}

/** The EARLY search's coins: reads older than 70 minutes (their first hour is known), with their paths from the read on. */
export async function loadEarly(pool: any, days = 10, max = 12_000): Promise<GCoin[]> {
  const rs = await pool.query(
    `select e.mint, e.at, e.created_at, e.f, l.outcome, l.bond_secs from early_reads e left join launches l on l.mint = e.mint
     where e.at > now() - ($1 || ' days')::interval and e.at < now() - interval '70 minutes' order by e.at desc limit $2`,
    [String(days), max],
  );
  const by = new Map<string, { c: ReturnType<typeof earlyCoin> & { bonded: boolean; bondSecs: number | null }; f: EarlyF; tk: { t: number; mc: number; r: number; p: number; d: number }[] }>();
  for (const r of rs.rows) {
    const f = (typeof r.f === "string" ? JSON.parse(r.f) : r.f) as EarlyF;
    const at = new Date(r.at).getTime();
    if (!f || !Number.isFinite(at)) continue;
    const c = { ...earlyCoin(r.mint, at, new Date(r.created_at).getTime(), f), bonded: r.outcome === "BONDED", bondSecs: r.bond_secs == null ? null : Number(r.bond_secs) };
    by.set(r.mint, { c, f, tk: [] });
  }
  const mints = [...by.keys()];
  for (let i = 0; i < mints.length; i += 1000) {
    const part = mints.slice(i, i + 1000);
    const from = Math.min(...part.map((m) => by.get(m)!.c.at));
    const ts = await pool.query(`select mint, at, progress, mc_sol, real_sol, complete, pool from ticks where mint = any($1) and at >= $2 order by mint, at`, [part, new Date(from).toISOString()]);
    for (const t of ts.rows) {
      const e = by.get(t.mint);
      if (!e) continue;
      const dt = new Date(t.at).getTime() - e.c.at;
      if (dt < 0 || dt > RUN_MS + 30 * 60_000) continue;
      e.tk.push({ t: dt, mc: Number(t.mc_sol) || 0, r: Number(t.real_sol) || 0, p: Number(t.progress) || 0, d: t.pool ? 2 : t.complete ? 1 : 0 });
    }
    await new Promise((ok) => setTimeout(ok, 20));
  }
  const res: GCoin[] = [];
  for (const { c, f: fr, tk } of by.values()) {
    // the read itself is the first price; a coin nobody traded after its read could still be sold back to its curve at
    // that price (the curve is always there): flat, paying the costs. Leaving those out would keep only coins that moved
    const f0 = { t: 0, mc: 0, r: 0, p: c.progress, d: 0 };
    f0.mc = Number(fr.mc) || 0;
    f0.r = Number(fr.real) || 0;
    if (!(f0.mc > 0)) continue;
    if (!tk.length || tk[0].t > 0) tk.unshift(f0);
    if (tk.length < 3) tk.push({ ...tk[tk.length - 1], t: Math.max(tk[tk.length - 1].t, 2_500) }, { ...tk[tk.length - 1], t: Math.max(tk[tk.length - 1].t, 15 * 60_000) });
    const n = tk.length;
    const g: GCoin = { ...c, t: new Int32Array(n), mc: new Float32Array(n), real: new Float32Array(n), prog: new Float32Array(n), done: new Uint8Array(n) };
    tk.forEach((x, k) => {
      g.t[k] = x.t;
      g.mc[k] = x.mc;
      g.real[k] = x.r;
      g.prog[k] = x.p;
      g.done[k] = x.d;
    });
    res.push(g);
  }
  return res;
}

/** Tests only. */
export function _earlyReset() {
  PEND.clear();
  TRACK.clear();
  MIG.clear();
  Object.assign(earlyStats, { seen: 0, read: 0, skipped: 0, capped: 0, tracked: 0, day: "", dayN: 0 });
}
