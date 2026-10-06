import { Redis } from "@upstash/redis";

let _r: Redis | null = null;
export function redis(): Redis {
  const injected = (globalThis as any).__rnRedis; // test hook
  if (injected) return injected;
  if (_r) return _r;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("Redis is not configured");
  _r = new Redis({ url, token });
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
  idxT: "rn:idxt",
  peak: "rn:peak",
  near: "rn:near",
  radar: "rn:radar",
  grads: "rn:grads",
  devN: "rn:dev:n",
  devB: "rn:dev:b",
  nano: "rn:nano",
  nanoLog: "rn:nanolog",
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
