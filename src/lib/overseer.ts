// OVERSEER: the intern with the bird's-eye view. Two jobs.
//  1. Explore. Like a crawler it walks outside sources for ideas: Reddit's memecoin and Solana boards, GitHub's newest
//     pump.fun and trading-bot repos, new papers on arXiv, and X searches on trading craft. Every finding is logged
//     (the trail is visible in admin) and never read twice.
//  2. Think. Every 6 hours it reads how the whole protocol is doing (desk P&L and exam, every strategy sleeve, FILM's
//     grades per rule, MIND's record, the King's honest scoreboard, the wallet classes' copy records, priors, your
//     feedback) next to what it found, and proposes up to 3 concrete improvements: more profit, a higher win rate,
//     lower risk, faster entries. Each idea gets a number and goes to your Telegram ideas chat. You answer /yes 12,
//     /no 12 why, or /later 12; it learns what kind of ideas you take. Approved ideas wait in admin for the team.
// It proposes; it never changes the protocol by itself.
import { redis } from "./redis";
import { ask, json, llmOn } from "./llm";
import { agentLog } from "./agents";
import { tgSend, ideasChat } from "./tgbot";
import { xOn } from "./wire";
import { xAllowed, xCost, xSpend } from "./xcredits";

const FINDS = "rn:ov:finds";
const SEEN = "rn:ov:seen";
const TRAIL = "rn:ov:trail";
const IDEAS = "rn:ov:ideas";
const NEXT = "rn:ov:next";
const THINK_AT = "rn:ov:thinkAt";
const SRC_I = "rn:ov:src";
const LOCK = "rn:ov:lock";
const UA = "Mozilla/5.0 (compatible; RATNET-OVERSEER/1.0)";

export type Finding = { src: string; title: string; url: string; text: string; at: number };
export type Idea = { id: number; at: number; title: string; problem: string; proposal: string; impact: string; risk: string; effort: string; kind: string; sources: string[]; status: "new" | "yes" | "no" | "later"; note?: string; decidedAt?: number };

async function trail(text: string, url?: string) {
  const r = redis();
  await r.lpush(TRAIL, { at: Date.now(), text, url: url || null });
  await r.ltrim(TRAIL, 0, 79);
}

async function getJson(url: string, headers: Record<string, string> = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, ...headers }, signal: ctl.signal, cache: "no-store" });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const SOURCES: { name: string; run: () => Promise<Finding[]> }[] = [
  {
    name: "reddit",
    run: async () => {
      const out: Finding[] = [];
      for (const sub of ["solana", "memecoins", "SolanaMemeCoins", "CryptoMoonShots"]) {
        await trail(`reading r/${sub}, top of the day`, `https://www.reddit.com/r/${sub}/top/?t=day`);
        const txt = await getJson(`https://www.reddit.com/r/${sub}/top.json?t=day&limit=12`);
        const j: any = txt ? JSON.parse(txt) : null;
        for (const c of j?.data?.children || []) {
          const d = c.data;
          if (!d?.title) continue;
          out.push({ src: `r/${sub}`, title: String(d.title).slice(0, 200), url: `https://www.reddit.com${d.permalink}`, text: String(d.selftext || "").slice(0, 600), at: Date.now() });
        }
      }
      return out;
    },
  },
  {
    name: "github",
    run: async () => {
      const since = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
      const out: Finding[] = [];
      for (const q of [`pump.fun pushed:>${since}`, `memecoin trading bot pushed:>${since}`, `solana sniper pushed:>${since}`]) {
        await trail(`searching GitHub: ${q}`, `https://github.com/search?q=${encodeURIComponent(q)}&type=repositories&s=updated`);
        const txt = await getJson(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=updated&per_page=8`, { accept: "application/vnd.github+json" });
        const j: any = txt ? JSON.parse(txt) : null;
        for (const x of j?.items || []) out.push({ src: "github", title: `${x.full_name} (${x.stargazers_count} stars)`, url: x.html_url, text: String(x.description || "").slice(0, 400), at: Date.now() });
      }
      return out;
    },
  },
  {
    name: "arxiv",
    run: async () => {
      await trail("checking arXiv for new memecoin and pump.fun research", "https://arxiv.org/a/search?query=memecoin");
      const xml = await getJson("https://export.arxiv.org/api/query?search_query=all:memecoin+OR+all:%22pump.fun%22+OR+all:%22meme+coin%22&sortBy=submittedDate&sortOrder=descending&max_results=8");
      if (!xml) return [];
      return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
        const e = m[1];
        const g = (tag: string) => (e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1]?.replace(/\s+/g, " ").trim() || "";
        return { src: "arXiv", title: g("title").slice(0, 200), url: g("id"), text: g("summary").slice(0, 700), at: Date.now() };
      });
    },
  },
  {
    name: "x",
    run: async () => {
      if (!xOn() || !(await xAllowed(0.7))) return [];
      const qs = ["pump.fun strategy", "how I find memecoin runners", "smart money wallets solana", "new solana launchpad", "memecoin exit strategy"];
      const q = qs[Math.floor(Date.now() / 3600_000) % qs.length];
      await trail(`searching X: "${q}"`, `https://x.com/search?q=${encodeURIComponent(q)}&f=top`);
      const txt = await getJson(`https://api.twitterapi.io/twitter/tweet/advanced_search?query=${encodeURIComponent(`${q} min_faves:50`)}&queryType=Top`, { "X-API-Key": process.env.X_API_KEY! });
      const j: any = txt ? JSON.parse(txt) : null;
      await xSpend("OVERSEER", xCost((j?.tweets || []).length));
      return (j?.tweets || []).slice(0, 10).map((t: any) => ({ src: `X @${t.author?.userName}`, title: String(t.text || "").slice(0, 200), url: t.url || "", text: String(t.text || "").slice(0, 600), at: Date.now() }));
    },
  },
];

/** One source per run, in turn, so a minute run never stalls. */
async function explore() {
  const r = redis();
  const i = Number((await r.incr(SRC_I)) || 0) % SOURCES.length;
  const s = SOURCES[i];
  const found = await s.run().catch(() => []);
  let n = 0;
  for (const f of found) {
    if (!f.url || !(await r.sadd(SEEN, f.url))) continue;
    await r.lpush(FINDS, f);
    n++;
  }
  await r.ltrim(FINDS, 0, 199);
  await trail(`${s.name}: ${found.length} items, ${n} new`);
  return n;
}

// ---------------------------------------------------------------- think

const SYS = `You are OVERSEER, the analyst with the bird's-eye view over RATNET, a team of agents that trades pump.fun memecoins on paper and later with real money.
Your job: propose concrete improvements that raise profit, raise the win rate, lower risk, or make entries faster. Base every idea on the numbers you are given (cite them) or on a specific finding (cite its URL).
Good ideas are specific: which agent, which rule or number, what to change, how to test it safely (shadow or ghost desk first). No vague advice, no ideas already rejected, no repeats of open ideas.
The owner approves or rejects. Learn from what the owner approved and rejected before.
Answer with one JSON object only: {"ideas":[{"title":"max 80 chars","problem":"what the data shows, with numbers","proposal":"exactly what to change","impact":"expected effect","risk":"what could go wrong","effort":"small|medium|large","kind":"tune|build|strategy|source|risk","sources":["urls"]}]}
At most 3 ideas. Fewer is fine if nothing is worth it.`;

async function metrics() {
  const parts: string[] = [];
  try {
    const { getDesk, getRecord } = await import("./desk");
    const d: any = await getDesk();
    const rec: any = await getRecord(undefined, "real").catch(() => null);
    parts.push(`DESK: ${d.live ? "live" : "paper"}, equity ${d.state.equity?.toFixed?.(3)} SOL from ${d.state.start}, closed ${d.state.closed}, wins ${d.state.wins}, max drawdown ${d.state.maxDD}%. exam: ${(d.exam?.checks || []).map((c: any) => `${c.label} ${c.now} (need ${c.need})`).join("; ")}`);
    if (rec?.summary) parts.push(`TRACK RECORD: return ${rec.summary.returnPct}%, win rate ${rec.summary.winRate}%, realized ${rec.summary.realizedSol} SOL, avg hold ${Math.round((rec.summary.avgHoldMs || 0) / 60000)}m`);
    parts.push(`SLEEVES: ${(d.pm || []).map((p: any) => `${p.sleeve} ${p.trades} trades, win ${p.winRate ?? "-"}%, avg ${p.avg ?? "-"}%, size ${p.w}x${p.paused ? " PAUSED" : ""}${p.ghost ? `, ghost avg ${p.ghostAvg}%` : ""}`).join(" | ")}`);
    parts.push(`FILM (skip rules graded 2h later): ${(d.film?.rules || []).map((x: any) => `${x.rule}: ${x.h2.n} reviewed, ${x.h2.n ? Math.round((x.h2.wrong / x.h2.n) * 100) : 0}% missed a run, avg ${x.h2.avg}% → ${x.verdict}`).join("; ")}`);
    const l = d.learn || {};
    parts.push(`PRIORS: floor ${l.floorOn ? "on" : "off"} (${l.floor?.n} reviewed), socials ${l.socialsOn ? "on" : "off"} (${l.socials?.n}), traction ${l.tractionOn ? "on" : "off"} (${l.traction?.n}), dev exit ${l.devExitOn ? "on" : "off"}; trail scale ${l.trailK}; exits reviewed ${l.reviews} (${l.early} too early, ${l.late} too late)`);
    parts.push(`COACH after exits: ${(d.coach?.horizons || []).map((h: any) => `${h.k} avg ${h.avg}% (${h.up2} doubled)`).join(", ")}`);
  } catch {}
  try {
    const { mindRecord } = await import("./mind");
    parts.push(`MIND: ${(await mindRecord()).map((r) => `${r.verdict} ${r.n}: ${r.h.map((h) => `${h.k} ${h.avg ?? "-"}%`).join(" ")}`).join(" | ")}`);
  } catch {}
  try {
    const { getStats } = await import("./stats");
    const s: any = await getStats();
    parts.push(`KING honest: ${s.honest?.hit}/${s.honest?.n} BOND calls bonded within 2h (${s.honest?.prec}%), caught ${s.honest?.recall}% of ${s.honest?.bonds} bonds; base rate ${s.baseRate}%`);
  } catch {}
  try {
    const { houndView } = await import("./hound");
    const h = await houndView(true);
    parts.push(`WALLETS: ${h.counts.fomo} FOMO, ${h.counts.kol} KOL (${h.counts.kolConfirmed} confirmed), ${h.counts.smart} smart. copy records at 6h: ${h.classes.map((c) => `${c.label} ${c.h6.avg ?? "-"}% over ${c.h6.n}`).join(", ")}`);
  } catch {}
  try {
    const { pickerView } = await import("./picker");
    const p = await pickerView();
    parts.push(`WIRE picker: right on ${p.right} of ${p.n} posts`);
  } catch {}
  try {
    const { feedbackSummary } = await import("./feedback");
    const f = await feedbackSummary();
    parts.push(`OWNER FEEDBACK on trades: ${f.good} good, ${f.bad} bad; top tags ${f.tags.slice(0, 6).map((t) => `${t.verdict}:${t.tag} ${t.n}`).join(", ")}`);
  } catch {}
  return parts.join("\n");
}

export async function ideasList(): Promise<Idea[]> {
  return Object.values(((await redis().hgetall<Record<string, Idea>>(IDEAS)) || {}) as Record<string, Idea>).sort((a, b) => b.id - a.id);
}

const esc = (s: string) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function ideaText(i: Idea) {
  return [
    `<b>#${i.id} ${esc(i.title)}</b> · ${esc(i.kind)} · effort ${esc(i.effort)}`,
    `<b>Data:</b> ${esc(i.problem)}`,
    `<b>Change:</b> ${esc(i.proposal)}`,
    `<b>Impact:</b> ${esc(i.impact)}`,
    `<b>Risk:</b> ${esc(i.risk)}`,
    i.sources.length ? i.sources.slice(0, 3).map(esc).join("\n") : "",
    `\n/yes ${i.id} · /no ${i.id} why · /later ${i.id}`,
  ].filter(Boolean).join("\n");
}

/** Read the protocol and the findings, propose up to 3 ideas, send them to Telegram. */
export async function think(force = false) {
  const r = redis();
  if (!llmOn()) return { think: "off (no ANTHROPIC_API_KEY)" };
  if (!force && Date.now() - Number((await r.get(THINK_AT)) || 0) < 6 * 3600_000) return { think: "not due" };
  await r.set(THINK_AT, Date.now());
  await trail("thinking: reading every agent's record next to what I found");
  const [m, finds, ideas] = await Promise.all([metrics(), r.lrange<Finding>(FINDS, 0, 39), ideasList()]);
  const kinds: Record<string, { y: number; n: number }> = {};
  for (const i of ideas) if (i.status === "yes" || i.status === "no") ((kinds[i.kind] ||= { y: 0, n: 0 })[i.status === "yes" ? "y" : "n"] += 1);
  const text = `PROTOCOL RIGHT NOW:\n${m}\n\nFINDINGS FROM OUTSIDE SOURCES:\n${((finds || []) as Finding[]).map((f) => `- [${f.src}] ${f.title} ${f.url}${f.text ? ` :: ${f.text.slice(0, 200)}` : ""}`).join("\n").slice(0, 9000)}\n\nPAST IDEAS (status, owner note):\n${ideas.slice(0, 30).map((i) => `#${i.id} [${i.status}] ${i.kind}: ${i.title}${i.note ? ` (owner: ${i.note})` : ""}`).join("\n") || "none yet"}\n\nOWNER TASTE BY KIND: ${Object.entries(kinds).map(([k, v]) => `${k} ${v.y} yes / ${v.n} no`).join(", ") || "unknown yet"}`;
  const ans = json<{ ideas: any[] }>(await ask(SYS, [{ type: "text", text }], 1500, 55_000));
  const list = (ans?.ideas || []).slice(0, 3);
  const made: Idea[] = [];
  for (const x of list) {
    if (!x?.title || !x?.proposal) continue;
    const id = Number(await r.incr(NEXT));
    const idea: Idea = { id, at: Date.now(), title: String(x.title).slice(0, 100), problem: String(x.problem || "").slice(0, 500), proposal: String(x.proposal).slice(0, 800), impact: String(x.impact || "").slice(0, 300), risk: String(x.risk || "").slice(0, 300), effort: String(x.effort || "medium").slice(0, 10), kind: String(x.kind || "build").slice(0, 12), sources: (x.sources || []).map(String).filter((u: string) => /^https?:\/\//.test(u)).slice(0, 4), status: "new" };
    await r.hset(IDEAS, { [String(id)]: idea });
    made.push(idea);
  }
  const p = r.pipeline();
  agentLog(p, made.map((i) => ({ agent: "OVERSEER", at: Date.now(), text: `idea #${i.id}: ${i.title}`, tone: "info" })));
  await p.exec();
  if (made.length && ideasChat()) {
    await tgSend(ideasChat()!, `<b>OVERSEER</b> · ${made.length} new idea${made.length > 1 ? "s" : ""}`);
    for (const i of made) await tgSend(ideasChat()!, ideaText(i));
  }
  await trail(`proposed ${made.length} idea${made.length === 1 ? "" : "s"}`);
  return { think: made.length };
}

export async function decide(id: number, status: Idea["status"], note?: string) {
  const r = redis();
  const i = await r.hget<Idea>(IDEAS, String(id));
  if (!i) return null;
  const next = { ...i, status, note: note ? note.slice(0, 400) : i.note, decidedAt: Date.now() };
  await r.hset(IDEAS, { [String(id)]: next });
  const p = r.pipeline();
  agentLog(p, [{ agent: "OVERSEER", at: Date.now(), text: `idea #${id} ${status === "yes" ? "approved" : status === "no" ? "rejected" : "parked"}${note ? `: ${note}` : ""}`, tone: status === "yes" ? "ok" : "info" }]);
  await p.exec();
  return next;
}

export async function overseerSession(ms: number) {
  const r = redis();
  if (!(await r.set(LOCK, 1, { nx: true, ex: Math.ceil(ms / 1000) + 5 }))) return { overseer: "busy" };
  try {
    // explore a little every 10 minutes, think every 6 hours
    const out: Record<string, unknown> = {};
    if (new Date().getUTCMinutes() % 10 === 0) out.found = await explore().catch(() => 0);
    Object.assign(out, await think().catch((e) => ({ think: `error ${e?.message || e}` })));
    return out;
  } finally {
    await r.del(LOCK).catch(() => {});
  }
}

export async function overseerView() {
  const r = redis();
  const [tr, finds, ideas, at] = await Promise.all([r.lrange<any>(TRAIL, 0, 29), r.lrange<Finding>(FINDS, 0, 19), ideasList(), r.get<number>(THINK_AT)]);
  return { trail: tr || [], finds: finds || [], ideas, thinkAt: at ? Number(at) : null, telegram: !!ideasChat(), llm: llmOn() };
}
