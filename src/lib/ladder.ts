// v0.1.127 TP LADDER. A live GRID follow takes profit in fixed steps as the coin climbs, instead of 70% at 2x with the
// rest on a 50% trail. Steps are [multiple, share of the original position]: "1.5:40,2:30,3:20,5:10" sells 40% at 1.5x,
// 30% at 2x, 20% at 3x and the last 10% at 5x. A price that jumps past several steps in one tick sells them all at once.
// Steps that add up to under 100% leave a bag on the strategy's own trail. The stop and the time limit stay as they are.
//
// Every GRID LIVE paper trip also runs a set of ladders as shadows on its own ticks (SHADOWS below), so the review shows
// which one would have made the most, on the same coins, split by entry market cap.

export type Step = [number, number]; // [multiple, share of the original position, 0..1]
export const LADDER_DEF = "1.5:40,2:30,3:20,5:10";

/** "1.5:40,2:30" -> [[1.5,0.4],[2,0.3]]. Off, empty or invalid -> null. */
export function parseLadder(s: unknown): Step[] | null {
  if (typeof s !== "string") return null;
  const t = s.trim().toLowerCase();
  if (!t || t === "off" || t === "0") return null;
  const out: Step[] = [];
  for (const part of t.split(",")) {
    const m = part.trim().match(/^(\d+(?:\.\d+)?)x?\s*:\s*(\d+(?:\.\d+)?)%?$/);
    if (!m) return null;
    const lv = Number(m[1]);
    const sh = Number(m[2]) / 100;
    if (!(lv >= 1.05 && lv <= 100) || !(sh > 0 && sh <= 1)) return null;
    out.push([lv, sh]);
  }
  if (!out.length || out.length > 8) return null;
  out.sort((a, z) => a[0] - z[0]);
  for (let i = 1; i < out.length; i++) if (out[i][0] === out[i - 1][0]) return null;
  const sum = out.reduce((a, x) => a + x[1], 0);
  if (sum > 1.0001) return null;
  return out;
}

export const ladderText = (l: Step[] | null) => (l ? l.map(([x, s]) => `${Math.round(s * 100)}% at ${x}x`).join(", ") : "off");

/**
 * The steps a price reaches from step `from` on: the new index and the share of the ORIGINAL position they sell.
 * `left` is the share still held (tokens / tokens0): the result `frac` is the part of what is held to sell now.
 */
export function ladderHit(steps: Step[], from: number, xr: number, left: number): { to: number; share: number; frac: number } | null {
  let i = from;
  let share = 0;
  while (i < steps.length && xr >= steps[i][0]) share += steps[i++][1];
  if (!share) return null;
  const last = i >= steps.length && steps.reduce((a, x) => a + x[1], 0) >= 0.9999;
  const frac = last || share >= left - 1e-6 ? 1 : Math.min(1, share / Math.max(left, 1e-9));
  return { to: i, share, frac };
}

// ---- shadows on paper trips
// "book" = the strategy's own exit (first target, then its trail), run by the same engine, so all rows compare alike
export const SHADOWS: Record<string, Step[] | "book" | "desk" | { bag: number }> = {
  book: "book",
  desk: "desk", // the ladder the live desk is set to right now
  all2: [[2, 1]],
  all15: [[1.5, 1]],
  lad13: [[1.3, 0.5], [2, 0.3], [3, 0.2]],
  lad15: [[1.5, 0.4], [2, 0.3], [3, 0.2], [5, 0.1]],
  lad2: [[2, 0.5], [3, 0.2], [4, 0.15], [6, 0.15]],
  lad2b: [[2, 0.4], [3, 0.2], [5, 0.2]], // 20% bag on the trail
  // v0.1.137 BAG STUDY: the desk's own ladder on 90/80/70% of the position; the last 10/20/30% (the bag) rides a
  // BAG_TRAIL trail off the peak for up to BAG_HOURS, past the strategy's own close (lib/gridlive.ts rides)
  bag10: { bag: 0.1 },
  bag20: { bag: 0.2 },
  bag30: { bag: 0.3 },
};
export const BAG_TRAIL = 0.5;
export const BAG_HOURS = 24;
export const BAG_IDS = ["bag10", "bag20", "bag30"] as const;
export const bagOf = (id: string) => {
  const v = SHADOWS[id];
  return v && typeof v === "object" && !Array.isArray(v) ? v.bag : null;
};
/** The desk's ladder scaled to keep a bag (e.g. 0.2: every step sells 80% of its share). */
export const bagLadder = (l: Step[] | null, bag: number): Step[] | null => (l && bag > 0 && bag < 1 ? l.map(([x, sh]) => [x, Math.round(sh * (1 - bag) * 1e4) / 1e4] as Step) : l);
let DESK: Step[] | null = parseLadder(LADDER_DEF);
export const setDeskLadder = (l: Step[] | null) => (DESK = l);
export const deskLadder = () => DESK;

export type Shadow = { i: number; s: number; g: number; d?: 1 }; // next step, share sold, multiples taken, done
export const newShadows = (): Record<string, Shadow> => Object.fromEntries(Object.keys(SHADOWS).map((k) => [k, { i: 0, s: 0, g: 0 }]));

function stepsOf(id: string, x: { initials: number; keep?: number; hours?: number }, first: number): Step[] | null {
  const v = SHADOWS[id];
  if (v === "book") return [[x.initials, first]];
  if (v === "desk") return DESK;
  if (v && typeof v === "object" && !Array.isArray(v)) return bagLadder(DESK, v.bag);
  return (v as Step[]) ?? null;
}

/** One tick for every shadow: xr = price / fill, pk = peak / fill. */
export function shadowTick(sh: Record<string, Shadow>, x: { initials: number; trail: number; stop: number; keep?: number; hours?: number }, first: number, xr: number, pk: number) {
  for (const id of Object.keys(sh)) {
    const st = sh[id];
    if (st.d) continue;
    const steps = stepsOf(id, x, first);
    if (!steps) {
      st.d = 1;
      st.g = NaN;
      continue;
    }
    while (st.i < steps.length && xr >= steps[st.i][0] && st.s < 1 - 1e-9) {
      const sh2 = Math.min(steps[st.i][1], 1 - st.s);
      st.g += sh2 * xr;
      st.s += sh2;
      st.i++;
    }
    if (st.s >= 1 - 1e-9) {
      st.d = 1;
      continue;
    }
    // the stop holds before and after the first step (as on the desk); the trail once a step sold. A bag shadow whose
    // steps are all sold rides the wide bag trail (as the live desk's bag does)
    const riding = bagOf(id) != null && st.i >= steps.length;
    if (xr <= 1 - x.stop || (st.s > 0 && xr <= pk * (1 - (riding ? BAG_TRAIL : x.trail)))) {
      st.g += (1 - st.s) * xr;
      st.s = 1;
      st.d = 1;
    }
  }
}

/** The trip closed (any reason): whatever a shadow still holds is sold at the close price. Returns multiples per shadow. */
export function shadowClose(sh: Record<string, Shadow>, xr: number, keepRiding = false): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, st] of Object.entries(sh)) {
    if (Number.isNaN(st.g)) continue;
    if (keepRiding && ridingBag(id, st)) continue; // v0.1.137: settled later, by its ride
    const g = st.d ? st.g : st.g + (1 - st.s) * xr;
    out[id] = Math.round(g * 1000) / 1000;
  }
  return out;
}

/** A bag shadow with every ladder step sold and its bag still held: it keeps riding after the strategy closes. */
export function ridingBag(id: string, st: Shadow) {
  const b = bagOf(id);
  if (b == null || st.d || Number.isNaN(st.g)) return false;
  const steps = bagLadder(DESK, b);
  return !!steps && st.i >= steps.length && st.s < 1 - 1e-9;
}
/** A riding bag after the close: one price tick (xr = price / fill, pk = peak / fill). Returns true when it sold. */
export function rideTick(st: Shadow, xr: number, pk: number) {
  if (st.d) return true;
  if (xr <= pk * (1 - BAG_TRAIL)) {
    st.g += (1 - st.s) * xr;
    st.s = 1;
    st.d = 1;
    return true;
  }
  return false;
}

// ---- the study: per shadow, the average result a trip (gross, before costs), on all trips and by entry market cap,
// older 70% vs newest 30%
export type LadTrip = { closedAt: number; k: string; sh?: Record<string, number>; mc0?: number };
export const LOW_MC = 5; // SOL: under this at the buy = "low cap"
export function ladderStudy(trips: LadTrip[], lead: string | null, now = Date.now()) {
  const xs = trips.filter((t) => t.sh && Object.keys(t.sh).length).sort((a, z) => a.closedAt - z.closedAt);
  const group = (a: LadTrip[]) => {
    const cut = Math.floor(a.length * 0.7);
    const avg = (b: LadTrip[], id: string) => {
      const v = b.map((t) => t.sh![id]).filter((x) => typeof x === "number" && Number.isFinite(x));
      return v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length - 1) * 1000) / 10 : null;
    };
    // bag shadows are left out here: a riding bag settles later (the BAG study in lib/gridlive.ts has the full record)
    const rows = Object.keys(SHADOWS).filter((id) => bagOf(id) == null).map((id) => ({ id, all: avg(a, id), old: avg(a.slice(0, cut), id), new: avg(a.slice(cut), id) }));
    const base = rows.find((r) => r.id === "book");
    // best = beats the strategy's own exit on both halves and has the highest average
    const best = a.length >= 60 && base ? rows.filter((r) => r.id !== "book" && r.old != null && r.new != null && base.old != null && base.new != null && r.old > base.old && r.new > base.new).sort((x, z) => (z.all ?? -1e9) - (x.all ?? -1e9))[0]?.id ?? null : null;
    return { n: a.length, rows, best };
  };
  const low = xs.filter((t) => (t.mc0 ?? 99) < LOW_MC);
  const rest = xs.filter((t) => (t.mc0 ?? 99) >= LOW_MC);
  const mine = lead ? xs.filter((t) => t.k === lead) : [];
  return { at: now, desk: ladderText(DESK), lead, all: group(xs), low: group(low), rest: group(rest), leader: group(mine) };
}
