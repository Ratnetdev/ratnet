// Every agent board on /desk in one answer (v0.1.38): FLASH, CATCH, the BOARD, MOMO, MIND, HOUND and LENS used to be
// seven requests on their own timers (every 1.5 to 15 seconds per viewer). Public views only: CATCH's weights and
// HOUND's full book stay admin-only on their own endpoints. Built at most every 3s per server instance and cached 3s
// on the CDN, so all viewers share it.
import { flashView } from "@/lib/flash";
import { catchView } from "@/lib/catcher";
import { boardTop } from "@/lib/board";
import { momoView } from "@/lib/momo";
import { mindView } from "@/lib/mind";
import { houndView } from "@/lib/hound";
import { lensView } from "@/lib/lens";
import { memo } from "@/lib/memo";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

const part = <T,>(p: Promise<T>) => p.catch(() => null);

export async function GET() {
  try {
    const v = await memo("api:boards", 3_000, async () => {
      const [flash, ct, board, momo, mind, hound, lens] = await Promise.all([part(flashView()), part(catchView()), part(boardTop()), part(momoView()), part(mindView()), part(houndView(false)), part(lensView())]);
      return {
        at: Date.now(),
        flash,
        catch: ct ? { ...ct, model: { ...(ct as any).model, w: [] }, features: [] } : null,
        board,
        momo: momo || { at: null, hot: [] },
        mind,
        hound,
        lens,
      };
    });
    return cached(v, 3);
  } catch (e) {
    return fail(e, 500);
  }
}
