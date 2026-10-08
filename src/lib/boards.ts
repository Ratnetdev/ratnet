// Every agent board on /desk in one answer (v0.1.38): FLASH, CATCH, the BOARD, MOMO, MIND, HOUND and LENS. Public
// views only: CATCH's weights and HOUND's full book stay admin-only on their own endpoints.
// v0.1.40: built by the worker every ~20s and stored as one key (lib/site.ts); pages build it only when the worker is
// down. Each build reads ~1MB from Redis, and every server instance used to build it every 8s.
import { flashView } from "./flash";
import { catchView } from "./catcher";
import { boardTop } from "./board";
import { momoView } from "./momo";
import { mindView } from "./mind";
import { houndView } from "./hound";
import { lensView } from "./lens";

const part = <T,>(p: Promise<T>) => p.catch(() => null);

export async function buildBoards() {
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
}
