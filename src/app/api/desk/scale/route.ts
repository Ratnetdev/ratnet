import { getDesk } from "@/lib/desk";
import { readSite } from "@/lib/site";
import { getSettings } from "@/lib/settings";
import { fail } from "@/lib/http";
import { scaleOf, atRisk, bookOf, LADDER, type ScaleCfg } from "@/lib/scale";

export const dynamic = "force-dynamic";

// v0.1.121 DESK SCALE: the desk's limits at its bank now, what is at risk, and the ladder of limits per bank size.
export async function GET() {
  try {
    const [d, s] = await Promise.all([readSite("desk", 5_000, 45_000, getDesk) as Promise<any>, getSettings()]);
    const cfg = s.desk as unknown as ScaleCfg;
    const eq = Array.isArray(d?.equity) && d.equity.length ? Number(d.equity[d.equity.length - 1].eq) : NaN;
    const bank = Number.isFinite(eq) ? eq : 0;
    const pos: any[] = Array.isArray(d?.positions) ? d.positions : [];
    const books: Record<string, number> = {};
    for (const p of pos) books[bookOf(p)] = +((books[bookOf(p)] || 0) + atRisk(p)).toFixed(4);
    const r = (x: number) => (Number.isFinite(x) ? +x.toFixed(3) : null);
    const view = (b: number) => {
      const sc = scaleOf(b, cfg);
      return { bank: b, maxSol: r(sc.maxSol), maxOpen: sc.maxOpen, momoMaxOpen: sc.momoMaxOpen, maxBags: sc.maxBags, deployMax: r(sc.deployMax), bookMax: r(sc.bookMax) };
    };
    return Response.json({
      on: cfg.scale !== false,
      now: view(+bank.toFixed(4)),
      atRisk: r(pos.reduce((a, p) => a + atRisk(p), 0)),
      open: pos.length,
      books,
      ladder: LADDER.map(view),
      note: "size cap, slots and exposure grow with the bank; the coin's liquidity (curve or pool) still caps every buy",
    });
  } catch (e) {
    return fail(e, 500);
  }
}
