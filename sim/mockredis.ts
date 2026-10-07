// Minimal in-memory stand-in for the @upstash/redis methods RATNET uses.
type Z = Map<string, number>;
export class MockRedis {
  kv = new Map<string, any>();
  calls = 0;
  private now() { return Date.now(); }
  private exp = new Map<string, number>();
  private live(k: string) { const e = this.exp.get(k); if (e && e <= this.now()) { this.kv.delete(k); this.exp.delete(k); } return this.kv.has(k); }
  private clone(v: any) { return v === undefined ? null : JSON.parse(JSON.stringify(v)); }
  async get(k: string) { this.calls++; return this.live(k) ? this.clone(this.kv.get(k)) : null; }
  async set(k: string, v: any, o: any = {}) { this.calls++; if (o.nx && this.live(k)) return null; const keep = o.keepTtl ? this.exp.get(k) : undefined; this.kv.set(k, this.clone(v)); if (o.ex) this.exp.set(k, this.now() + o.ex * 1000); else if (o.px) this.exp.set(k, this.now() + o.px); else if (keep) this.exp.set(k, keep); else this.exp.delete(k); return "OK"; }
  async eval(script: string, keys: string[], args: string[]) { this.calls++; const k = keys[0]; const own = this.live(k) && this.kv.get(k) === args[0]; if (!own) return 0; if (/pexpire/.test(script)) { this.exp.set(k, this.now() + Number(args[1])); return 1; } this.kv.delete(k); this.exp.delete(k); return 1; }
  async del(...ks: string[]) { this.calls++; ks.forEach((k) => this.kv.delete(k)); return 1; }
  async incr(k: string) { return this.incrby(k, 1); }
  async incrby(k: string, n: number) { this.calls++; const v = Number(this.live(k) ? this.kv.get(k) : 0) + n; this.kv.set(k, v); return v; }
  async expire(k: string, s: number) { this.exp.set(k, this.now() + s * 1000); return 1; }
  private h(k: string) { if (!this.live(k)) this.kv.set(k, {}); return this.kv.get(k); }
  async hincrby(k: string, f: string, n: number) { this.calls++; const h = this.h(k); h[f] = Number(h[f] || 0) + n; return h[f]; }
  async hincrbyfloat(k: string, f: string, n: number) { this.calls++; const h = this.h(k); h[f] = Number(h[f] || 0) + n; return h[f]; }
  async exists(...ks: string[]) { this.calls++; return ks.filter((k) => this.live(k)).length; }
  async hexists(k: string, f: string) { this.calls++; const h = this.live(k) ? this.kv.get(k) : {}; return h && f in h ? 1 : 0; }
  async hget(k: string, f: string) { this.calls++; const h = this.live(k) ? this.kv.get(k) : {}; return h[f] ?? null; }
  async hgetall(k: string) { this.calls++; return this.live(k) && Object.keys(this.kv.get(k)).length ? this.clone(this.kv.get(k)) : null; }
  async hmget(k: string, ...f: string[]) { this.calls++; const h = this.live(k) ? this.kv.get(k) : {}; const o: any = {}; f.forEach((x) => (o[x] = h[x] ?? null)); return o; }
  async hlen(k: string) { this.calls++; return this.live(k) ? Object.keys(this.kv.get(k)).length : 0; }
  async hsetnx(k: string, f: string, v: any) { this.calls++; const h = this.h(k); if (f in h) return 0; h[f] = this.clone(v); return 1; }
  async zpopmin(k: string, n = 1) { this.calls++; const z = this.z(k); const arr = [...z.entries()].sort((x, y) => x[1] - y[1]).slice(0, n); arr.forEach(([m]) => z.delete(m)); return arr.flatMap((x) => [x[0], x[1]]); }
  async zpopmax(k: string, n = 1) { this.calls++; const z = this.z(k); const arr = [...z.entries()].sort((x, y) => y[1] - x[1]).slice(0, n); arr.forEach(([m]) => z.delete(m)); return arr.flatMap((x) => [x[0], x[1]]); }
  async rpop(k: string) { this.calls++; const l = this.live(k) ? this.kv.get(k) : []; return l.length ? l.pop() : null; }
  async hdel(k: string, ...f: string[]) { this.calls++; const h = this.h(k); f.forEach((x) => delete h[x]); return 1; }
  async hset(k: string, obj: any) { this.calls++; Object.assign(this.h(k), this.clone(obj)); return 1; }
  async mget(...ks: string[]) { this.calls++; return ks.map((k) => (this.live(k) ? this.clone(this.kv.get(k)) : null)); }
  private z(k: string): Z { if (!this.live(k)) this.kv.set(k, new Map()); return this.kv.get(k); }
  async zadd(k: string, ...args: any[]) {
    this.calls++;
    const opts = args[0] && !("member" in args[0]) ? args.shift() : {};
    const z = this.z(k);
    for (const { score, member } of args) {
      const cur = z.get(member);
      if (opts.gt && cur !== undefined && score <= cur) continue;
      z.set(member, score);
    }
    return 1;
  }
  async zmscore(k: string, ms: string[]) { this.calls++; const z = this.z(k); return ms.map((m) => (z.has(m) ? z.get(m)! : null)); }
  async zscore(k: string, m: string) { this.calls++; const z = this.z(k); return z.has(m) ? z.get(m)! : null; }
  async zrem(k: string, ...ms: string[]) { this.calls++; const z = this.z(k); ms.forEach((m) => z.delete(m)); return 1; }
  async zcard(k: string) { this.calls++; return this.z(k).size; }
  async scan(cur: any, o: any = {}) { this.calls++; const re = new RegExp("^" + String(o.match || "*").replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"); const keys = [...this.kv.keys()].filter((k) => re.test(k)); const i = Number(cur) || 0; const c = o.count || 10; const sl = keys.slice(i, i + c); return [i + c >= keys.length ? "0" : String(i + c), sl]; }
  async scard(k: string) { this.calls++; const v = this.kv.get(k); return v instanceof Set ? v.size : Array.isArray(v) ? v.length : 0; }
  async zrange(k: string, a: number, b: number, o: any = {}) {
    this.calls++;
    let arr = [...this.z(k).entries()].sort((x, y) => x[1] - y[1]);
    if (o.byScore) { arr = arr.filter(([, s]) => s >= a && s <= b); if (o.count) arr = arr.slice(o.offset || 0, (o.offset || 0) + o.count); return arr.map((x) => x[0]); }
    if (o.rev) arr.reverse();
    const end = b < 0 ? arr.length + b : b;
    const sl = arr.slice(a, end + 1);
    return o.withScores ? sl.flatMap((x) => [x[0], x[1]]) : sl.map((x) => x[0]);
  }
  async zremrangebyscore(k: string, a: number, b: number) { this.calls++; const z = this.z(k); let n = 0; for (const [m, sc] of [...z.entries()]) if (sc >= a && sc <= b) { z.delete(m); n++; } return n; }
  async hscan(k: string, _c: any) { this.calls++; const h = this.live(k) ? this.kv.get(k) : {}; return ["0", Object.entries(h).flat()]; }
  async zremrangebyrank(k: string, a: number, b: number) { const arr = [...this.z(k).entries()].sort((x, y) => x[1] - y[1]); const end = b < 0 ? arr.length + b : b; arr.slice(a, end + 1).forEach(([m]) => this.z(k).delete(m)); return 1; }
  private l(k: string): any[] { if (!this.live(k)) this.kv.set(k, []); return this.kv.get(k); }
  async lpush(k: string, ...v: any[]) { this.calls++; const l = this.l(k); v.forEach((x) => l.unshift(this.clone(x))); return l.length; }
  async rpush(k: string, ...v: any[]) { this.calls++; const l = this.l(k); v.forEach((x) => l.push(this.clone(x))); return l.length; }
  async ltrim(k: string, a: number, b: number) { const l = this.l(k); const n = l.length; const s = a < 0 ? Math.max(0, n + a) : a; const e = b < 0 ? n + b : b; this.kv.set(k, l.slice(s, e + 1)); return "OK"; }
  async llen(k: string) { this.calls++; return this.live(k) ? this.kv.get(k).length : 0; }
  async lpop(k: string, n?: number) { this.calls++; const l = this.l(k); if (n == null) return l.length ? this.clone(l.shift()) : null; const out = l.splice(0, n); return out.length ? this.clone(out) : null; }
  async lrange(k: string, a: number, b: number) { this.calls++; const l = this.l(k); const e = b < 0 ? l.length + b : b; return this.clone(l.slice(a, e + 1)); }
  async sadd(k: string, ...m: string[]) { const s = this.live(k) ? new Set(this.kv.get(k)) : new Set(); const before = s.size; m.forEach((x) => s.add(x)); this.kv.set(k, [...s]); return s.size - before; }
  async sismember(k: string, m: string) { return this.live(k) && this.kv.get(k).includes(m) ? 1 : 0; }
  async smembers(k: string) { return this.live(k) ? [...this.kv.get(k)] : []; }
  pipeline() {
    const ops: (() => Promise<any>)[] = [];
    const self = this;
    const proxy: any = new Proxy({}, {
      get(_, prop: string) {
        if (prop === "exec") return async () => { const out = []; for (const op of ops) out.push(await op()); self.calls++; return out; };
        return (...args: any[]) => { ops.push(() => (self as any)[prop](...args)); return proxy; };
      },
    });
    return proxy;
  }
}
