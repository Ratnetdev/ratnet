import { getNano } from "@/lib/stats";
import { loadModel } from "@/lib/digger";
import { K } from "@/lib/redis";
import { NANO_FEATURES } from "@/lib/nano";
import { fail } from "@/lib/http";
import { serve } from "@/lib/private";

export const dynamic = "force-dynamic";

// Rat King nano. Public: samples, loss and the training log. The weights themselves are admin only (?full=1).
export async function GET(req: Request) {
  try {
    const [{ model, log, min }, early] = await Promise.all([getNano(), loadModel(K.nano1)]);
    return serve(
      req,
      {
        model: "rat-king-nano",
        kind: "logistic regression, online SGD, trained from scratch on RATNET outcomes",
        samples: model.n,
        bonded_samples: model.pos,
        loss_ema: model.loss,
        acc_ema: model.acc,
        counted_calls_from: min,
        updated_at: model.updatedAt,
        weights: NANO_FEATURES.map((f, i) => ({ feature: f.key, label: f.label, w: model.w[i] ?? 0 })),
        log,
        early_model: {
          model: "rat-king-early",
          kind: "same features, read at minute 1; the desk may act on it only once its record beats the minute-5 King",
          samples: early.n,
          bonded_samples: early.pos,
          loss_ema: early.loss,
          weights: NANO_FEATURES.map((f, i) => ({ feature: f.key, w: early.w[i] ?? 0 })),
        },
      },
      (d: any) => ({ ...d, weights: [], early_model: { ...d.early_model, weights: [] }, private: "weights are private" }),
      15
    );
  } catch (e) {
    return fail(e, 500);
  }
}
