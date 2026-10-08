// Security and robustness checks that need no network: rate limit, owned locks, SSRF guard, image sniffing,
// purpose-bound secrets, settings validation shape, the BOARD's confluence math.
import { MockRedis } from "./mockredis";
(globalThis as any).__rnRedis = new MockRedis();
process.env.CRON_SECRET = "root-secret-for-tests";

let fails = 0;
const ok = (cond: boolean, what: string) => {
  if (!cond) fails++;
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
};

(async () => {
  const { limit } = await import("../src/lib/http");
  const hits: boolean[] = [];
  for (let i = 0; i < 7; i++) hits.push(await limit("login:1.2.3.4", 5, 900));
  ok(hits.filter(Boolean).length === 5 && !hits[5] && !hits[6], "login limit: 5 tries then blocked");

  const { acquire, renew, release } = await import("../src/lib/lock");
  const a = await acquire("rn:lock:t", 1000);
  const b = await acquire("rn:lock:t", 1000);
  ok(!!a && !b, "lock: second holder refused");
  ok(await renew(a!, 1000), "lock: owner can renew");
  ok(!(await renew({ key: "rn:lock:t", token: "someone-else" }, 1000)), "lock: stranger cannot renew");
  await release({ key: "rn:lock:t", token: "someone-else" });
  ok(!(await acquire("rn:lock:t", 1000)), "lock: stranger cannot release");
  await release(a!);
  ok(!!(await acquire("rn:lock:t", 1000)), "lock: free again after the owner releases");

  const { publicUrl, imageType } = await import("../src/lib/safefetch");
  for (const u of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data", "http://10.1.2.3", "http://[::1]/", "http://localhost", "file:///etc/passwd", "gopher://x", "https://u:p@8.8.8.8/", "http://0.0.0.0", "http://[::ffff:127.0.0.1]/"])
    ok(!(await publicUrl(u)), `ssrf blocked: ${u}`);
  ok(!!(await publicUrl("https://8.8.8.8/x")), "ssrf: public IP allowed");
  ok(imageType(Buffer.from("<svg onload=alert(1)></svg>....")) === null, "image sniff: SVG refused");
  ok(imageType(Buffer.from("<html><script>alert(1)</script></html>")) === null, "image sniff: HTML refused");
  ok(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])) === "image/jpeg", "image sniff: JPEG accepted");

  const { secretFor, safeEq } = await import("../src/lib/admin");
  const x = secretFor("x-hook"), t = secretFor("tg-hook"), h = secretFor("helius-hook");
  ok(new Set([x, t, h]).size === 3 && ![x, t, h].some((s) => s.includes("root-secret")), "secrets: one per purpose, none is the root");
  ok(safeEq("abc", "abc") && !safeEq("abc", "abd") && !safeEq("", "") && !safeEq(null, "x"), "safeEq: constant-time compare");

  const { confluence } = await import("../src/lib/board");
  const now = Date.now();
  const c = confluence([{ a: "KING", at: now, s: 0.8, t: "" }, { a: "SCOUT", at: now, s: 0.9, t: "" }, { a: "HOUND", at: now, s: 0.7, t: "" }, { a: "MOMO", at: now, s: 0.9, t: "" }, { a: "LENS", at: now - 50 * 60_000, s: 1, t: "" }], now);
  ok(c.pos === 3, `board: families count once and old views fade (got ${c.pos} for)`);
  const d = confluence([{ a: "TAPE", at: now, s: -1, t: "farm" }, { a: "KING", at: now, s: 0.8, t: "" }], now);
  ok(d.neg === 1 && d.score < 0, "board: a hard negative outweighs one positive");

  const { isPubkey } = await import("../src/lib/solana");
  ok(!isPubkey(["x"] as any) && !isPubkey("0OIl" + "1".repeat(40)) && isPubkey("So11111111111111111111111111111111111111112"), "isPubkey: strings of base58 only");

  // v0.1.39: the connection itself refuses private addresses (DNS rebinding), not only the check before it
  const { connectLookup } = await import("../src/lib/safefetch");
  const blocked = await new Promise<string>((res) => connectLookup("localhost", {}, (e) => res(e ? String(e.message) : "connected")));
  ok(blocked === "blocked address", `safeFetch: a host resolving to 127.0.0.1 is refused at connect time (${blocked})`);

  console.log(fails ? `\n${fails} FAILED` : "\nall passed");
  process.exit(fails ? 1 : 0);
})();
