import { metrics } from "@/lib/metrics";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// Charts behind the feed's stat cards. ?range=24h | 72h | 30d
export async function GET(req: Request) {
  try {
    const q = new URL(req.url).searchParams.get("range");
    const range = q === "72h" || q === "30d" ? q : "24h";
    return cached(await metrics(range), 30);
  } catch (e) {
    return fail(e, 500);
  }
}
