import { K, redis } from "@/lib/redis";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// The desk's equity, one point a minute (last ~2 days), for the track record charts.
export async function GET() {
  try {
    const eq = ((await redis().lrange<{ t: number; eq: number; live?: boolean }>(K.deskEq, -2880, -1)) || []) as { t: number; eq: number; live?: boolean }[];
    return cached({ points: eq.filter((x) => x && Number.isFinite(x.t) && Number.isFinite(x.eq)).map((x) => ({ t: x.t, eq: x.eq, live: !!x.live })) }, 15);
  } catch (e) {
    return fail(e, 500);
  }
}
