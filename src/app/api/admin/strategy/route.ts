import { KING_V1 } from "@/lib/kingcal";
import { getDesk, LEARN_RULES, EXAM } from "@/lib/desk";
import { getNano } from "@/lib/stats";
import { feedbackSummary } from "@/lib/feedback";
import { KING_VERSION, VERDICTS, WEIGHTS } from "@/lib/king";
import { NANO_FEATURES, NANO_MIN } from "@/lib/nano";
import { LENS_PRI } from "@/lib/lens";
import { isAdmin } from "@/lib/admin";
import { loadCal } from "@/lib/kingcal";
import { getStats } from "@/lib/stats";
import { lessonBook, mindRecord, mindUnlocked } from "@/lib/mind";
import { llmModel, llmOn } from "@/lib/llm";
import { pickerView } from "@/lib/picker";
import { exitProfiles } from "@/lib/pm";
import { labView } from "@/lib/exitlab";
import { fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";

// The whole playbook in one place, admin only: every rule and threshold, every prior and what COACH made of it,
// the King's rules and nano's weights, FILM's grades, the PM sleeves, WIRE's best accounts and your feedback.
export async function GET() {
  if (!isAdmin()) return fail("unauthorized", 401);
  try {
    const [d, nano, fb, cal, stats, book, mrec, unlock, picker] = await Promise.all([getDesk(), getNano(), feedbackSummary(), loadCal(), getStats(), lessonBook(), mindRecord(), mindUnlocked(), pickerView()]);
    const execLog = ((await (await import("@/lib/redis")).redis().lrange<any>("rn:exec:log", 0, 19)) || []) as any[];
    const worker = Number((await (await import("@/lib/redis")).redis().get("rn:worker:at")) || 0);
    const profiles = await exitProfiles((d.cfg as any).initialsAt, (d.cfg as any).timeStop);
    const exitLab = await labView().catch(() => null);
    const l: any = d.learn;
    const mean = (x: { n: number; sum: number } | undefined) => (x?.n ? Math.round((Math.exp(x.sum / x.n) - 1) * 1000) / 10 : null);
    const direct = l.arms?.find((a: any) => a.arm === 0);
    return json({
      cfg: d.cfg,
      exitLab,
      exam: EXAM,
      rules: LEARN_RULES,
      priors: [
        { key: "holding_floor", on: l.floorOn !== false, what: `skip coins ${LEARN_RULES.floorMax}%+ under their high`, n: l.floor?.n ?? 0, need: LEARN_RULES.floorMin, skippedAvg: mean(l.floor), boughtAvg: direct?.mean ?? null },
        { key: "has_socials", on: l.socialsOn !== false, what: "skip coins with no X, website or Telegram (tweet-linked coins and 2+ smart wallets pass)", n: l.socials?.n ?? 0, need: LEARN_RULES.socialsMin, skippedAvg: mean(l.socials), boughtAvg: direct?.mean ?? null },
        { key: "post_traction", on: l.tractionOn !== false, what: "tweet coins: the post must have spawned a wave (3+ coins or 25+ SOL across them), unless the author posted the CA", n: l.traction?.n ?? 0, need: LEARN_RULES.tractionMin, skippedAvg: mean(l.traction), boughtAvg: direct?.mean ?? null },
        { key: "dev_exit", on: !!l.devExitOn, what: "sell when the dev sells (off on memes until COACH proves it)", n: l.devStat?.n ?? 0, need: LEARN_RULES.devMin, saved: l.devStat?.saved ?? 0 },
      ],
      picker,
      profiles,
      speed: { worker: Date.now() - worker < 90_000, rps: Number(process.env.RPC_RPS || 10), exec: execLog, avgMs: execLog.length ? Math.round(execLog.reduce((a, x) => a + x.ms, 0) / execLog.length) : null, fast: execLog.filter((x) => x.path === "fast").length },
      learned: { trailBy: l.trailBy || {}, trailK: l.trailK, reviews: l.reviews, early: l.early, late: l.late, good: l.good, stalkOn: l.stalkOn, stalkArm: l.stalkArm, earlyOn: l.earlyOn, earlyStat: l.earlyStat, arms: l.arms, shadows: l.shadows, reviewing: l.reviewing },
      king: { version: cal?.ready ? KING_V1 : KING_VERSION, verdicts: VERDICTS, rules: WEIGHTS, cal, honest: (stats as any).honest },
      mind: { on: llmOn(), model: llmModel(), record: mrec, unlock, lessons: book },
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
      wire: d.wire ? { accounts: (d.wire.accounts || []).slice(0, 25), callers: (d.wire.accounts || []).filter((a: any) => a.calls > 0).sort((a: any, b: any) => b.calls - a.calls).slice(0, 25), pulse: d.wire.pulse } : null,
      lens: { priority: LENS_PRI, perHour: 60 },
      feedback: fb,
    });
  } catch (e) {
    return fail(e, 500);
  }
}
