// v0.1.64: the "redis-rest" service on Railway. The site (Vercel) talks to Railway's Redis through this, in the same
// REST protocol it used with Upstash, so no page or API changes. Start command: npm run rest
// Variables: REDIS_URL=${{Redis.REDIS_URL}}, REST_TOKEN (a long random secret; the site's UPSTASH_REDIS_REST_TOKEN).
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { answer, connectRedis } from "../src/lib/redisrest";

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.REST_TOKEN || "";
const MAX_BODY = 50 * 1024 * 1024;

function authed(h: string | undefined) {
  if (!TOKEN || TOKEN.length < 24) return false;
  const got = Buffer.from(String(h || "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function main() {
  if (!process.env.REDIS_URL) throw new Error("REDIS_URL is not set");
  if (!TOKEN || TOKEN.length < 24) throw new Error("REST_TOKEN is not set (24+ characters)");
  let r = await connectRedis(process.env.REDIS_URL);
  while (!r) {
    console.log("redis-rest: Redis not reachable yet, retrying in 3s");
    await new Promise((x) => setTimeout(x, 3000));
    r = await connectRedis(process.env.REDIS_URL);
  }
  const red = r;
  let served = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/healthz" || req.url === "/")) {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(`ok ${served}`);
    }
    if (req.method !== "POST") {
      res.writeHead(405);
      return res.end();
    }
    if (!authed(req.headers.authorization)) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "Unauthorized" }));
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        res.writeHead(413);
        res.end();
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", async () => {
      if (res.writableEnded) return;
      try {
        const a = await answer(red, req.url || "/", Buffer.concat(chunks).toString("utf8"));
        served++;
        res.writeHead(a.status, { "content-type": "application/json" });
        res.end(a.body);
      } catch (e: any) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(e?.message || e) }));
      }
    });
  });
  server.keepAliveTimeout = 65_000;
  // "::" (IPv4 and IPv6, Railway's private network is IPv6); hosts without IPv6 fall back to IPv4
  server.once("error", (e: any) => {
    if (e?.code !== "EAFNOSUPPORT") throw e;
    server.listen(PORT, "0.0.0.0", () => console.log(`redis-rest: listening on ${PORT} (IPv4)`));
  });
  server.listen(PORT, "::", () => console.log(`redis-rest: listening on ${PORT}`));
}
main().catch((e) => {
  console.log("redis-rest:", e?.message || e);
  process.exit(1);
});
