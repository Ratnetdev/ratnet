import { getDesk, LEARN_RULES, EXAM } from "@/lib/desk";
import { getNano } from "@/lib/stats";
import { feedbackSummary } from "@/lib/feedback";
import { KING_VERSION, VERDICTS, WEIGHTS } from "@/lib/king";
import { NANO_FEATURES, NANO_MIN } from "@/lib/nano";
import { LENS_PRI } from "@/lib/lens";
import { isAdmin } from "@/lib/admin";
import { fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";

// The whole playbook in one place, admin only: every rule and threshold, every prior and what COACH made of it,
// the King's rules and nano's weights, FILM's grades, the PM sleeves, WIRE's best accounts and your feedback.
export async function GET() {
  if (!isAdmin()) return fail("unauthorized", 401);
  try {
    const [d, nano, fb] = await Promise.all([getDesk(), getNano(), feedbackSummary()]);
    const l: any = d.learn;
    const mean = (x: { n: number; sum: number } | undefined) => (x?.n ? Math.round((Math.exp(x.sum / x.n) - 1) * 1000) / 10 : null);
    const direct = l.arms?.find((a: any) => a.arm === 0);
    return json({
      cfg: d.cfg,
      exam: EXAM,
      rules: LEARN_RULES,
      priors: [
        { key: "holding_floor", on: l.floorOn !== false, what: `skip coins ${LEARN_RULES.floorMax}%+ under their high`, n: l.floor?.n ?? 0, need: LEARN_RULES.floorMin, skippedAvg: mean(l.floor), boughtAvg: direct?.mean ?? null },
        { key: "has_socials", on: l.socialsOn !== false, what: "skip coins with no X, website or Telegram (tweet-linked coins and 2+ smart wallets pass)", n: l.socials?.n ?? 0, need: LEARN_RULES.socialsMin, skippedAvg: mean(l.socials), boughtAvg: direct?.mean ?? null },
        { key: "dev_exit", on: !!l.devExitOn, what: "sell when the dev sells (off on memes until COACH proves it)", n: l.devStat?.n ?? 0, need: LEARN_RULES.devMin, saved: l.devStat?.saved ?? 0 },
      ],
      learned: { trailK: l.trailK, reviews: l.reviews, early: l.early, late: l.late, good: l.good, stalkOn: l.stalkOn, stalkArm: l.stalkArm, earlyOn: l.earlyOn, earlyStat: l.earlyStat, arms: l.arms, shadows: l.shadows, reviewing: l.reviewing },
      king: { version: KING_VERSION, verdicts: VERDICTS, rules: WEIGHTS },
      nano: {
        n: nano.model.n,
        pos: nano.model.pos,
        loss: nano.model.loss,
        min: NANO_MIN,
        weights: NANO_FEATURES.map((f, i) => ({ key: f.key, label: f.label, w: Math.round((nano.model.w[i] ?? 0) * 1000) / 1000 })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w)),
      },
      film: d.film,
      pm: d.pm,
      coach: d.coach,
      wire: d.wire ? { accounts: (d.wire.accounts || []).slice(0, 25), pulse: d.wire.pulse } : null,
      lens: { priority: LENS_PRI, perHour: 60 },
      feedback: fb,
    });
  } catch (e) {
    return fail(e, 500);
  }
}
