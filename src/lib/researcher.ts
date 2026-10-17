// v0.1.82: RESEARCHER. Once an hour Claude reads GRID's latest search (the best rules on past calls, train and test),
// what the senders had at the call, and every GRID LIVE strategy's live record, then proposes new strategies to trade
// live on paper. It can only pick from GRID's own menu (its call filters, entry timings and exits), so every idea is
// one GRID could test and GRID LIVE can trade exactly. Bounded:
//   - 4 books of its own at most (on top of GRID's 16 and the hot strategy's family), one call an hour, only when a
//     slot is free; ANTHROPIC_API_KEY on Railway (RESEARCH_MODEL, default the MIND model)
//   - its books are exploring books: 45+ trips and positive overall, on top of the desk's exam, before the desk can
//     follow one; they are dropped by the same live rules as every other book
//   - nothing else: no settings, no money, no exam, no live/paper switch
import { redis } from "./redis";
import { pmView } from "./pm";
import { ask, json, llmOn, llmModel } from "./llm";
import { GEXITS, MODES, PREDS, exitText, keyOf, type GExit } from "./grid";
import { LIVE_VIEW, gridLiveAddResearch, researchOk, researchRoom } from "./gridlive";

const SEEN = "rn:research:seen"; // hash key -> { at, why }
const LOG = "rn:research:log";
export const RESEARCH_EVERY_MS = 3600_000;
export const researchStats = { runs: 0, added: 0, rejected: 0, lastAt: 0, lastErr: "" };

const model = () => process.env.RESEARCH_MODEL || llmModel();
const r1 = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10) / 10 : n);

/** A filter from the menu: "all", one rule, or two different rules, in GRID's own order (so records match GRID's). */
export function normFilter(f: unknown): string | null {
  const s = String(f ?? "").trim();
  if (s === "all") return "all";
  const parts = s.split("+").map((x) => x.trim()).filter(Boolean);
  if (parts.length < 1 || parts.length > 2 || new Set(parts).size !== parts.length) return null;
  const idx = parts.map((id) => PREDS.findIndex((p) => p.id === id));
  if (idx.some((i) => i < 0)) return null;
  return idx.sort((a, b) => a - b).map((i) => PREDS[i].id).join("+");
}
export function labelOf(filter: string, mode: string) {
  const m = MODES.find((x) => x.id === mode)!;
  const f = filter === "all" ? "every call" : filter.split("+").map((id) => PREDS.find((p) => p.id === id)!.label).join(" + ");
  return `${f}, buy ${m.label}`;
}
export type Idea = { filter: string; mode: string; exit: GExit; label: string; why: string; key: string };
/** One proposal from the model, checked against the menu. A string = why it was refused. */
export function checkIdea(x: any): Idea | string {
  const filter = normFilter(x?.filter);
  if (!filter) return `filter "${String(x?.filter).slice(0, 40)}" is not on the menu`;
  const mode = String(x?.mode ?? "");
  if (!MODES.some((m) => m.id === mode)) return `entry "${mode.slice(0, 20)}" is not on the menu`;
  const i = Number(x?.exit);
  if (!Number.isInteger(i) || i < 0 || i >= GEXITS.length) return `exit ${String(x?.exit).slice(0, 10)} is not on the menu`;
  const exit = GEXITS[i];
  const why = String(x?.why ?? "").replace(/\s+/g, " ").trim().slice(0, 280);
  if (!why) return "no reason given";
  return { filter, mode, exit, label: labelOf(filter, mode), why, key: keyOf(filter, mode, exit) };
}

const SYSTEM = `You are RESEARCHER, the strategy researcher of a pump.fun trading desk that trades paper first and real money only after a strict exam.
GRID searches thousands of rules on past King calls (a call = the desk's model flags a new pump.fun coin around minute 5). GRID LIVE trades the most promising rules on live coins, on paper, at real costs. A rule passes when its last 30 live trips have 40%+ won, +0.1 SOL on 0.05 SOL trades and a profit factor of 1.2+ without its best trade; your rules must also reach 45 trips and stay positive over all of them.
What outside research measured (use it as a prior, never over our own numbers): the first coin of a meme graduates ~10x more often than its copies; serial launch factories do worse, a creator's first launch better; a coin born from a big post does best when it is the first coin for that post and the post has an image or video; KOL wallets buy early and their buys mark tops for followers, and when the early buyers start selling, a rally rarely lasts; attention fades fast after a post; 73% of migrated coins fall below 0.4x within 20 minutes; paid DexScreener profiles and boosts were never measured anywhere (our lift table is the first read).
Your job: propose new rules worth a live test, built only from the menu. Look for what the data says: rules close to passing, entry timings or exits that fix a rule's weak spot, combinations of the call conditions that the senders (coins that migrated) had, and what the live records show that GRID's history does not. Never propose a rule that is already trading or one listed as ruled out.
Think before you answer if you need to, but end your answer with the JSON, nothing after it: {"ideas":[{"filter":"<id or id+id or all>","mode":"<entry id>","exit":<exit number>,"why":"<one or two sentences, plain English, the evidence>"}]}`;

/**
 * v0.1.83: the ideas object out of an answer, wherever it sits (the first live answer on 16 Oct did not parse: prose
 * around it, or cut off). Finds {"ideas": ...} and reads to its matching brace, strings respected.
 */
export function extractIdeas(text: string | null): { ideas: any[] } | null {
  if (!text) return null;
  let from = 0;
  for (;;) {
    const k = text.indexOf('"ideas"', from);
    if (k < 0) return null;
    from = k + 7;
    const a = text.lastIndexOf("{", k);
    if (a < 0) continue;
    let depth = 0;
    let str = false;
    let esc = false;
    for (let i = a; i < text.length; i++) {
      const ch = text[i];
      if (str) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') str = false;
        continue;
      }
      if (ch === '"') str = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          const j = JSON.parse(text.slice(a, i + 1));
          if (Array.isArray(j?.ideas)) return j;
        } catch {}
        break;
      }
    }
  }
}

/** The model's input: the menu and the evidence, compact. */
export function brief(grid: any, live: any, seen: Record<string, any>, room: number, desk: any = null) {
  const menu = {
    filters: PREDS.map((p) => `${p.id}: ${p.label}`),
    entries: MODES.map((m) => `${m.id}: ${m.label}`),
    exits: GEXITS.map((x, i) => `${i}: ${exitText(x)}`),
  };
  const row = (r: any) => ({ rule: `${r.filter}|${r.mode}`, exit: GEXITS.findIndex((x) => x.initials === r.exit.initials && x.trail === r.exit.trail && x.stop === r.exit.stop && x.timeMin === r.exit.timeMin && x.mig === r.exit.mig), train: { n: r.train?.n, won: r1(r.train?.winRate), avg: r1(r.train?.avgPct) }, test: { n: r.test?.n, won: r1(r.test?.winRate), avg: r1(r.test?.avgPct), pf: r1(r.test?.pfLessBest) }, pass: !!r.pass });
  const gridPart = grid
    ? {
        calls: grid.coins,
        trainCalls: grid.trainN,
        testCalls: grid.testN,
        best: (grid.rows || []).slice(0, 15).map(row),
        exploring: (grid.explore || []).slice(0, 8).map(row),
        baseline: (grid.base || []).map(row),
        senders: grid.senders || null,
      }
    : null;
  // v0.1.97: runners say so, with their whole record and the record without their 2 best trips (how they are judged)
  const book = (b: any) => ({ rule: `${String(b.key).replace(/^any:/, "every launch: ")}`, by: b.by || (b.parent ? "variant" : "grid"), live: { trips: b.total ?? b.live?.n, won: b.live?.winRate, avg: r1(b.live?.avgPct), pnl: b.live?.pnl, pf: b.live?.pfLessBest, passed: !!b.live?.passed, ...(b.live?.runner ? { runner: true, totalPnl: b.live?.totalPnl, lessTop2: b.live?.lessTop2 } : {}) }, ...(b.fills?.blocked ? { realFillsTooFarFromPaper: true } : {}) });
  const livePart = live ? { trading: (live.books || []).map(book), ruledOut: (live.past || []).map((p: any) => ({ rule: p.key, live: { trips: p.live?.total ?? p.live?.n, won: p.live?.winRate, avg: r1(p.live?.avgPct), pnl: p.live?.pnl, pf: p.live?.pfLessBest } })) } : null;
  const mine = Object.entries(seen)
    .sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0))
    .slice(0, 30)
    .map(([k, v]) => ({ rule: k, why: String(v?.why || "").slice(0, 120) }));
  return `Propose up to ${room} rule${room === 1 ? "" : "s"}.

MENU (use only these)
${JSON.stringify(menu)}

GRID (latest search on past calls; test = the newest 30% of calls, the honest column)
${JSON.stringify(gridPart)}

GRID LIVE (live paper records; "ruledOut" no longer trade)
${JSON.stringify(livePart)}

DESK, REAL MONEY (v0.1.97: what each strategy family did with live money: trips, % won, average a trip after every cost, sellGap = live sells vs paper in %, bench = taken off live money and why. What loses with real money is not worth proposing again in a nearby form)
${JSON.stringify(desk)}

YOUR EARLIER PROPOSALS (do not repeat them)
${JSON.stringify(mine)}`;
}

/** One pass (worker, hourly). Adds up to the free slots; returns what it did. */
export async function researchPass(send?: (text: string) => Promise<unknown>, now = Date.now()) {
  if (!llmOn()) return { off: "ANTHROPIC_API_KEY not set" };
  const room = researchRoom();
  if (!room) return { full: true };
  const r = redis();
  const [grid, live, seen0] = await Promise.all([r.get<any>("rn:grid:view").catch(() => null), r.get<any>(LIVE_VIEW).catch(() => null), r.hgetall<Record<string, any>>(SEEN).catch(() => null)]);
  // v0.1.85: GRID's newest run can rank nothing (no rule clears its bar), and a failed run left only its error: RESEARCHER
  // waited on "no GRID run yet" all day. Its other evidence (GRID's explorers, the senders, every live record) is enough.
  const gridOk = !!grid?.at;
  if (!gridOk && !live?.books?.length) return { wait: "no GRID run or GRID LIVE record yet" };
  const seen = (seen0 || {}) as Record<string, any>;
  researchStats.runs++;
  researchStats.lastAt = now;
  // v0.1.83: room to think (4,000 tokens; 1,200 cut the first live answer short), the JSON found wherever it is
  const desk = await pmView()
    .then((v) => v.map((s: any) => ({ family: s.sleeve, live: s.live, bench: s.bench?.why ?? null, paperAndLive: { trips: s.trades, won: s.winRate, avg: s.avg } })))
    .catch(() => null);
  const text = await ask(SYSTEM, [{ type: "text", text: brief(gridOk ? grid : null, live, seen, room, desk) }], 4000, 180_000, model()).catch(() => null);
  const j = extractIdeas(text) ?? json<{ ideas?: any[] }>(text);
  if (!Array.isArray(j?.ideas)) {
    researchStats.lastErr = text ? "answer was not the JSON asked for" : "no answer from the model";
    // what came back, start and end, so the next fix is not a guess (Redis only, never on the site)
    await r.lpush(LOG, { at: now, model: model(), error: researchStats.lastErr, head: text ? text.slice(0, 600) : null, tail: text ? text.slice(-600) : null, len: text?.length ?? 0 }).catch(() => null);
    await r.ltrim(LOG, 0, 99).catch(() => null);
    return { error: researchStats.lastErr };
  }
  const ok: Idea[] = [];
  const refused: string[] = [];
  for (const x of j.ideas.slice(0, room * 2)) {
    const c = checkIdea(x);
    if (typeof c === "string") {
      refused.push(c);
      continue;
    }
    const why = seen[c.key] ? "proposed before" : researchOk(c.key);
    if (why) {
      refused.push(`${c.key}: ${why}`);
      continue;
    }
    if (!ok.some((o) => o.key === c.key)) ok.push(c);
  }
  const added = await gridLiveAddResearch(ok.slice(0, room), now);
  for (const b of added) await r.hset(SEEN, { [b.key]: { at: now, why: b.why } }).catch(() => null);
  researchStats.added += added.length;
  researchStats.rejected += refused.length;
  researchStats.lastErr = "";
  await r.lpush(LOG, { at: now, model: model(), added: added.map((b) => ({ key: b.key, label: b.label, why: b.why })), refused: refused.slice(0, 10) }).catch(() => null);
  await r.ltrim(LOG, 0, 99).catch(() => null);
  if (added.length && send)
    await send(`🔬 <b>RESEARCHER: ${added.length} new strateg${added.length === 1 ? "y" : "ies"} on GRID LIVE</b>\n${added.map((b) => `• ${b.label.replace(/[<>&]/g, " ")}\n  ${exitText(b.exit)}\n  <i>${(b.why || "").replace(/[<>&]/g, " ")}</i>`).join("\n")}\n\nPaper first: 45 trips and the exam before the desk can follow one.`).catch(() => null);
  return { added: added.map((b) => b.key), refused };
}
