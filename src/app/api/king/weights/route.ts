import { getNano } from "@/lib/stats";
import { NANO_FEATURES } from "@/lib/nano";
import { cached, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// Public weights of the Rat King nano. Anyone can run it: p = sigmoid(sum(w_i * x_i)).
export async function GET() {
  try {
    const { model, log, min } = await getNano();
    return cached(
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
      },
      15
    );
  } catch (e) {
    return fail(e, 500);
  }
}
