import { flashView } from "@/lib/flash";
import { memo } from "@/lib/memo";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// FLASH on /desk: its record per look time (15s, 45s, 90s), whether a look time has earned trading, the latest looks.
export async function GET() {
  try {
    return cached(await memo("api:flash", 5_000, flashView), 5);
  } catch (e) {
    return fail(e, 500);
  }
}
