import { K, redis } from "@/lib/redis";
import { cached, fail } from "@/lib/http";
import { memo } from "@/lib/memo";

export const dynamic = "force-dynamic";

// The desk's equity, one point a minute (last ~2 days), for the track record charts.
export async function GET() {
  try {
    // v0.1.41: one point a minute, so it is read at most once a minute per server instance
    const eq = (await memo("api:desk:equity", 60_000, async () => ((await redis().lrange<{ t: number; eq: number; live?: boolean }>(K.deskEq, -2880, -1)) || []) as { t: number; eq: number; live?: boolean }[]));
    return cached({ points: eq.filter((x) => x && Number.isFinite(x.t) && Number.isFinite(x.eq)).map((x) => ({ t: x.t, eq: x.eq, live: !!x.live })) }, 60);
  } catch (e) {
    return fail(e, 500);
  }
}
