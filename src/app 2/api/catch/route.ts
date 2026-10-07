import { catchView } from "@/lib/catcher";
import { fail } from "@/lib/http";
import { serve } from "@/lib/private";

export const dynamic = "force-dynamic";

// CATCH on /desk: what it is looking at, its honest record by score band, recent labels. Weights are admin only.
export async function GET(req: Request) {
  try {
    return serve(req, await catchView(), (d) => ({ ...d, model: { ...d.model, w: [] }, features: [] }), 4);
  } catch (e) {
    return fail(e, 500);
  }
}
