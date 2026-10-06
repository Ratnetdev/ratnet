import { exportDay, getExports } from "@/lib/exporter";
import { isCron } from "@/lib/admin";
import { fail, json } from "@/lib/http";
import { dayKey } from "@/lib/redis";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Daily: bundle the last fully resolved days into public JSONL files.
// A launch resolves 24h after creation, so day D is complete on day D+2.
export async function GET(req: Request) {
  if (!isCron(req)) return fail("unauthorized", 401);
  const done = new Set((await getExports()).map((e) => e.day));
  const out: Record<string, unknown> = {};
  for (const back of [2, 3]) {
    const day = dayKey(Date.now() - back * 86_400_000);
    if (done.has(day)) continue;
    try {
      out[day] = await exportDay(day);
    } catch (e) {
      out[day] = String((e as Error).message);
    }
  }
  return json(out);
}
