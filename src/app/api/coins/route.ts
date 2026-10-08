import { K, redis } from "@/lib/redis";
import type { IdxRow } from "@/lib/digger";
import { memo } from "@/lib/memo";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

type Row = IdxRow & { cur: number | null; pk: number | null };
let mem: { at: number; body: unknown } | null = null; // warm-instance cache on top of the CDN cache

// Every coin the King or nano liked in the last 24h, plus every coin that bonded. Filtered client-side.
export async function GET() {
  try {
    if (mem && Date.now() - mem.at < 15_000) return cached(mem.body, 15);
    const r = redis();
    // v0.1.40: the coin index (a day of calls, hundreds of KB) at most every 2 minutes per server instance; the live
    // curve numbers below stay fresh
    const h = await memo("api:coins:idx", 120_000, async () => ((await r.hgetall<Record<string, IdxRow>>(K.idx)) || {}) as Record<string, IdxRow>);
    const rows = Object.values(h).sort((a, b) => b.t - a.t);
    const pending = rows.filter((x) => !x.o).map((x) => x.m);
    const [cur, pk] = pending.length
      ? await Promise.all([r.zmscore(K.radar, pending), r.zmscore(K.peak, pending)])
      : [null, null];
    const live: Record<string, [number | null, number | null]> = {};
    pending.forEach((m, i) => (live[m] = [cur?.[i] != null ? Number(cur[i]) : null, pk?.[i] != null ? Number(pk[i]) : null]));
    const out: Row[] = rows.map((x) => ({ ...x, cur: x.o === "B" ? 100 : live[x.m]?.[0] ?? null, pk: x.o === "B" ? 100 : live[x.m]?.[1] ?? null }));
    const body = { rows: out, now: Date.now() };
    mem = { at: Date.now(), body };
    return cached(body, 15);
  } catch (e) {
    return fail(e, 500);
  }
}
