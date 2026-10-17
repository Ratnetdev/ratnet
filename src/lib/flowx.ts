// v0.1.105 EXIT FLOWS record, v0.1.108 FLOW EXIT learner.
//
// Every GRID LIVE paper position watches its coin's flow after the buy. Each trigger below notes, the first time it
// fires, what selling right then would have made. At the position's real close the record holds the actual result and
// those notes. From that record every exit variant (a trigger and how much to sell) is scored on the same trips:
//   result = share x (the trigger's note) + (1 - share) x (the actual result), or the actual result if it never fired.
// (The partial case assumes the rest of the position ends where the real one did: an approximation, stated here.)
// The learner ranks the variants on the latest trips and keeps doing so: our suggestions are the starting menu, the
// record decides which one the twin books run, and it switches when another variant proves better.
export type Trig = "kol1" | "kol2" | "e30" | "e50" | "e70";
export const TRIGS: { id: Trig; label: string }[] = [
  { id: "kol1", label: "a KOL that bought sells" },
  { id: "kol2", label: "2 KOLs that bought sell" },
  { id: "e30", label: "30% of the first 20 buyers have sold" },
  { id: "e50", label: "half of the first 20 buyers have sold" },
  { id: "e70", label: "70% of the first 20 buyers have sold" },
];
export const SHARES = [0.5, 1] as const;
export const VARIANTS = TRIGS.flatMap((t) => SHARES.map((s) => `${t.id}-${Math.round(s * 100)}`));
/** Our starting suggestion (before the record has enough trips): half out when a KOL that bought sells. */
export const FLOW_SEED = "kol1-50";
export const LEARN_N = 300; // the learner looks at the latest 300 trips
export const LEARN_MIN = 30; // ...and a variant needs 30+ trips on record
export const LEARN_FIRED = 10; // ...of which 10+ where its trigger fired

export type Flow = { kx: number | null; e20: number | null };
export function fired(t: Trig, f0: Flow | null | undefined, f: Flow | null | undefined): boolean {
  if (!f) return false;
  const k0 = f0?.kx ?? 0;
  if (t === "kol1") return f.kx != null && f.kx - k0 >= 1;
  if (t === "kol2") return f.kx != null && f.kx - k0 >= 2;
  const thr = t === "e30" ? 0.3 : t === "e50" ? 0.5 : 0.7;
  // crosses the line after the buy (a coin already past it at the buy never fires this trigger)
  return f.e20 != null && f.e20 >= thr && (f0?.e20 == null || f0.e20 < thr);
}
export const parseVariant = (v: string) => {
  const [t, s] = String(v || "").split("-");
  const trig = TRIGS.find((x) => x.id === t)?.id;
  const share = Number(s) / 100;
  return trig && (share === 0.5 || share === 1) ? { trig, share } : null;
};
export const variantText = (v: string) => {
  const p = parseVariant(v);
  return p ? `${p.share === 1 ? "all out" : "half out"} when ${TRIGS.find((x) => x.id === p.trig)!.label}` : v;
};

export type FlowX = { k: string; mint: string; at: number; act: number; flag: number; why: string; fl?: Partial<Record<Trig, number>> };
export function flowxStats(xs: FlowX[]) {
  const n = xs.length;
  const avg = (f: (x: FlowX) => number) => (n ? Math.round((xs.reduce((a, x) => a + f(x), 0) / n) * 10) / 10 : null);
  return { n, actAvg: avg((x) => x.act), flagAvg: avg((x) => x.flag), flagBetter: xs.filter((x) => x.flag > x.act).length, byWhy: { e20: xs.filter((x) => x.why === "e20").length, kol: xs.filter((x) => x.why === "kol").length } };
}

export type VarStat = { v: string; n: number; fired: number; uplift: number; lessTop2: number; better: number };
/** Every variant scored on the same trips (records from v0.1.108 on carry a note per trigger). */
export function learnTable(recs: FlowX[], take = LEARN_N): VarStat[] {
  const xs = recs.filter((x) => x && x.fl && !String(x.k).includes("~fx:")).slice(0, take); // twins run a flow exit: left out
  return VARIANTS.map((v) => {
    const p = parseVariant(v)!;
    const ups: number[] = [];
    let f = 0;
    let better = 0;
    for (const x of xs) {
      const note = x.fl?.[p.trig];
      if (note == null) {
        ups.push(0);
        continue;
      }
      f++;
      const res = p.share * note + (1 - p.share) * x.act;
      ups.push(res - x.act);
      if (res > x.act) better++;
    }
    const sum = ups.reduce((a, b) => a + b, 0);
    const top = [...ups].sort((a, b) => b - a);
    const n = ups.length;
    return { v, n, fired: f, uplift: n ? Math.round((sum / n) * 10) / 10 : 0, lessTop2: n > 2 ? Math.round(((sum - Math.max(0, top[0]) - Math.max(0, top[1])) / (n - 2)) * 10) / 10 : 0, better };
  }).sort((a, b) => b.uplift - a.uplift);
}
/** The learner's choice: the best variant that holds up (enough trips, positive, still positive without its 2 best). */
export function chooseVariants(table: VarStat[], k = 2): { picks: string[]; learned: boolean } {
  const ok = table.filter((s) => s.n >= LEARN_MIN && s.fired >= LEARN_FIRED && s.uplift > 0 && s.lessTop2 > 0);
  if (ok.length) return { picks: ok.slice(0, k).map((s) => s.v), learned: true };
  return { picks: [FLOW_SEED], learned: false };
}
