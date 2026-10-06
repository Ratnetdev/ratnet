// Per-agent history and counters, so anyone can click an agent and see what it has been doing.
import { K, dayKey, redis } from "./redis";

export type AgentEv = { agent: string; at: number; text: string; tone: string; mint?: string; symbol?: string };
const EVK = (a: string) => `rn:ag:ev:${a}`; // newest first, last 200 per agent
const STATK = "rn:ag:stat"; // {agent}:n, {agent}:{tone}
const DAYK = (d: string) => `rn:ag:day:${d}`; // {agent} -> actions today

/** Queue agent events on a pipeline: last line per agent, its own history, and counters. */
export function agentLog(p: { lpush: Function; ltrim: Function; hset: Function; hincrby: Function; expire: Function }, evs: AgentEv[]) {
  if (!evs.length) return;
  const last: Record<string, AgentEv> = {};
  const by: Record<string, AgentEv[]> = {};
  for (const e of evs) {
    last[e.agent] = e;
    (by[e.agent] ||= []).push(e);
  }
  p.hset(K.deskAgent, last);
  const day = DAYK(dayKey());
  for (const [a, list] of Object.entries(by)) {
    p.lpush(EVK(a), ...list.slice().reverse());
    p.ltrim(EVK(a), 0, 199);
    p.hincrby(STATK, `${a}:n`, list.length);
    for (const e of list) p.hincrby(STATK, `${a}:${e.tone}`, 1);
    p.hincrby(day, a, list.length);
  }
  p.expire(day, 3 * 86400);
}

export async function getAgent(name: string, limit = 120) {
  const r = redis();
  const [ev, st, today, last] = await Promise.all([
    r.lrange<AgentEv>(EVK(name), 0, limit - 1),
    r.hgetall<Record<string, number>>(STATK),
    r.hget<number>(DAYK(dayKey()), name),
    r.hget<AgentEv>(K.deskAgent, name),
  ]);
  const s = (st || {}) as Record<string, number>;
  const n = (k: string) => Number(s[`${name}:${k}`] || 0);
  return {
    name,
    last: last || null,
    total: n("n"),
    today: Number(today || 0),
    tones: { ok: n("ok"), info: n("info"), bad: n("bad"), win: n("win"), loss: n("loss") },
    history: (ev || []) as AgentEv[],
  };
}
