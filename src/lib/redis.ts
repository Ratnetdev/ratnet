import { Redis } from "@upstash/redis";
import { installFetchGuard } from "./fetchguard";
import { installRedisWire } from "./rediswire";

if (typeof window === "undefined") installFetchGuard();

let _r: Redis | null = null;
let _rLocal = false;
// v0.1.64: the worker answers the client from Railway's Redis in-process (lib/redisrest.ts). The base URL is never
// fetched over the network: the wire layer hands those calls to the local handler
const LOCAL_BASE = "http://rn-local-redis";
/** Which Redis this process talks to: "railway" (self-hosted, no per-byte bill) or "upstash". */
export function redisHost(): "railway" | "upstash" {
  if ((globalThis as any).__rnLocalRedis) return "railway";
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "";
  return /upstash\.io/i.test(url) ? "upstash" : "railway";
}
export function redis(): Redis {
  const injected = (globalThis as any).__rnRedis; // test hook
  if (injected) return injected;
  const local = !!(globalThis as any).__rnLocalRedis;
  if (_r && _rLocal === local) return _r;
  _rLocal = local;
  const url = local ? LOCAL_BASE : process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = local ? "local" : process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("Redis is not configured");
  // one retry, not Upstash's default five: during an outage five retries per command multiplied the load
  // responseEncoding false (v0.1.40): Upstash sends answers base64-encoded by default, a third more bytes on every
  // read, and its plan counts those bytes. Everything stored here is JSON text, which needs no encoding.
  // v0.1.40: compress large values on the way in, inflate them on the way out, count every byte (lib/rediswire.ts)
  installRedisWire(url);
  _r = new Redis({ url, token, retry: { retries: 1, backoff: () => 300 }, responseEncoding: false });
  // an empty pipeline is a no-op, not an error: Upstash throws "Pipeline is empty", which used to fail whole passes
  // (the slow lane's migration check on every beat where no coin had migrated yet)
  const client: any = _r;
  for (const name of ["pipeline", "multi"]) {
    const make = client[name].bind(client);
    client[name] = (...a: any[]) => {
      const p = make(...a);
      const exec = p.exec;
      p.exec = (o?: any) => (p.length() === 0 ? Promise.resolve([]) : exec(o));
      return p;
    };
  }
  return _r;
}

export const K = {
  settings: "rn:settings",
  cursor: "rn:cursor",
  digLock: "rn:lock:dig",
  launch: (m: string) => `rn:launch:${m}`,
  feed: "rn:feed",
  due: "rn:due",
  stat: "rn:stat",
  day: (d: string) => `rn:day:${d}`,
  resolvedHour: (h: string) => `rn:res:${h}`,
  call: (m: string) => `rn:call:${m}`,
  calls: "rn:calls",
  callRes: "rn:callres",
  rats: "rn:rats",
  ratLast: "rn:ratlast",
  ratsOf: (w: string) => `rn:ratsof:${w}`,
  ratSeq: "rn:ratseq",
  litterCount: (n: number) => `rn:litter:${n}`,
  rr: "rn:rr",
  work: (round: number) => `rn:work:${round}`,
  burnsUsed: "rn:burns:used",
  burns: "rn:burns",
  sniffs: "rn:sniffs",
  sniffers: "rn:sniffers",
  sniffRate: (ip: string) => `rn:sniffrate:${ip}`,
  rounds: "rn:rounds",
  exports: "rn:exports",
  hot: "rn:hot",
  hotCur: "rn:hotcur",
  idx: "rn:idx",
  hr: (h: string) => `rn:hr:${h}`,
  calib: "rn:calib",
  deskState: "rn:desk:state",
  deskPos: "rn:desk:pos",
  deskTrades: "rn:desk:trades",
  deskEv: "rn:desk:ev",
  deskQ: "rn:desk:q",
  deskEq: "rn:desk:eq",
  deskAgent: "rn:desk:agent",
  deskVet: "rn:desk:vet",
  idxT: "rn:idxt",
  peak: "rn:peak",
  near: "rn:near",
  radar: "rn:radar",
  grads: "rn:grads",
  devN: "rn:dev:n",
  devB: "rn:dev:b",
  nano: "rn:nano",
  nano1: "rn:nano1", // minute-1 model
  lessons: "rn:lessons", // zset: launches whose label (bonded within 2h) is ready to learn, score = createdAt + 2h
  deskShadow: "rn:desk:shadow", // signals followed in shadow to learn entries (hash)
  deskAfter: "rn:desk:after", // closed positions followed by COACH (hash)
  deskStalk: "rn:desk:stalk", // live stalks waiting for a pullback (hash)
  deskExam: "rn:desk:exam", // exam summary for the homepage
  deskLearn: "rn:desk:learn", // what the desk has learned (trail scale, pullback arms, early gate)
  nanoLog: "rn:nanolog",
  migr: "rn:migr", // zset: curves that hit 100%, waiting for proof they migrated (score = when complete)
  epoch: "rn:epoch", // data version; a new epoch wipes polluted labels and relearns (see lib/epoch.ts)
  workAll: "rn:workall",
  solPrice: "rn:solusd",
  ratPrice: "rn:ratsol",
};

export function dayKey(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}
export function hourKey(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 13);
}
