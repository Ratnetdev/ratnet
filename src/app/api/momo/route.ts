import { momoView } from "@/lib/momo";
import { memo } from "@/lib/memo";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// MOMO: the pump.fun coins pulling the most volume right now, and which ones have the traction the desk buys.
export async function GET() {
  try {
    return cached((await memo("api:momo", 10_000, momoView)) || { at: null, hot: [] }, 10);
  } catch (e) {
    return fail(e, 500);
  }
}
