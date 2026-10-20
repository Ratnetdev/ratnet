import { isPubkey } from "@/lib/solana";
import { checkGate, checkText, kingCheck, recentCalls } from "@/lib/ratcheck";
import { memo } from "@/lib/memo";
import { ipOf, memLimit } from "@/lib/http";
import { SITE } from "@/config/site";
import { BUILD } from "@/config/build";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// v0.1.133 RATNET MCP SERVER (Model Context Protocol, streamable HTTP, stateless JSON answers). Add it to Claude, Cursor
// or any MCP client as a remote server: https://www.ratnet.network/api/mcp
// Tools: rat_check (the Rat King's check of any coin), king_calls (recent BOND calls and how they ended), rat_desk (the
// live desk's record).
const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const TOOLS = [
  {
    name: "rat_check",
    title: "Rat King check",
    description: "Check any Solana token (pump.fun first). Returns the Rat King's bond score and report, who is buying it (FOMO traders, earners with real winning records, proven wallets, bots, wallets that buy before KOL callouts, crews counted once), whether it copies an earlier coin, the dev's launches this week, and the RATNET desk's own live record at that market cap.",
    inputSchema: { type: "object", properties: { ca: { type: "string", description: "The token's contract address (mint)" } }, required: ["ca"] },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "king_calls",
    title: "Rat King BOND calls",
    description: "The Rat King's most recent BOND calls (coins it expects to migrate, called at minute 5) and how each one ended: BONDED, DIED or still LIVE.",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "How many calls, 1 to 20 (default 8)" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "rat_desk",
    title: "RATNET desk record",
    description: "The RATNET trading desk's live record: a wallet that signs its own trades, no human in the loop. Money put in, value now, return, trades.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
];

const ok = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const err = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const text = (t: string, data?: unknown, isError = false) => ({ content: [{ type: "text", text: t }], ...(data ? { structuredContent: data } : {}), ...(isError ? { isError: true } : {}) });

async function call(name: string, args: any, ip: string) {
  if (name === "rat_check") {
    const ca = String(args?.ca || "").trim();
    if (!isPubkey(ca)) return text("Pass ca: a Solana token address.", undefined, true);
    const no = await checkGate(`mcp:${ip}`, 20);
    if (no) return text(no, undefined, true);
    const rep = await memo(`api:check:${ca}`, 15_000, () => kingCheck(ca, { free: true }));
    return text(checkText(rep), { report: rep });
  }
  if (name === "king_calls") {
    const n = Math.max(1, Math.min(20, Math.floor(Number(args?.limit) || 8)));
    const cs = await memo(`mcp:calls:${n}`, 30_000, () => recentCalls(n));
    const lines = cs.map((c) => `$${c.symbol} · BOND ${c.score} · ${new Date(c.at).toISOString().slice(0, 16).replace("T", " ")} UTC · ${c.outcome} · ${SITE.url}/c/${c.mint}`);
    return text(lines.length ? `The Rat King's last ${lines.length} BOND calls:\n${lines.join("\n")}` : "No BOND calls yet.", { calls: cs });
  }
  if (name === "rat_desk") {
    const { getRecord } = await import("@/lib/desk");
    const r: any = await memo("mcp:desk", 30_000, () => getRecord(undefined, "real"));
    const s = r?.summary || {};
    const t = `RATNET desk (${r?.live ? "live money" : "paper"}): started with ${s.start ?? "-"} SOL, worth ${s.equity ?? "-"} SOL now (${s.returnPct != null ? `${s.returnPct >= 0 ? "+" : ""}${s.returnPct}%` : "-"}), ${s.sessionPct != null ? `${s.sessionPct >= 0 ? "+" : ""}${s.sessionPct}% since the last restart, ` : ""}${r?.trips?.length ?? 0} round trips on record. ${SITE.url}/desk`;
    return text(t, { start: s.start ?? null, equity: s.equity ?? null, returnPct: s.returnPct ?? null, sessionPct: s.sessionPct ?? null, live: !!r?.live });
  }
  return null;
}

async function one(m: any, ip: string) {
  if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") return err(m?.id ?? null, -32600, "Invalid request");
  const isNote = m.id === undefined || m.id === null;
  if (m.method === "initialize") {
    const v = VERSIONS.includes(m.params?.protocolVersion) ? m.params.protocolVersion : VERSIONS[0];
    return ok(m.id, { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "ratnet", title: "RATNET Rat King", version: BUILD }, instructions: "Use rat_check before trusting any pump.fun coin: it says who is really buying. king_calls lists the Rat King's recent BOND calls. Not financial advice." });
  }
  if (isNote) return null; // notifications/initialized and the like
  if (m.method === "ping") return ok(m.id, {});
  if (m.method === "tools/list") return ok(m.id, { tools: TOOLS });
  if (m.method === "tools/call") {
    try {
      const r = await call(String(m.params?.name || ""), m.params?.arguments || {}, ip);
      return r ? ok(m.id, r) : err(m.id, -32602, `Unknown tool: ${m.params?.name}`);
    } catch (e: any) {
      return ok(m.id, text(`The rats tripped: ${String(e?.message || e).slice(0, 200)}`, undefined, true));
    }
  }
  if (m.method === "resources/list") return ok(m.id, { resources: [] });
  if (m.method === "prompts/list") return ok(m.id, { prompts: [] });
  return err(m.id, -32601, `Method not found: ${m.method}`);
}

const H = { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" };
export async function POST(req: Request) {
  const ip = ipOf(req);
  if (!memLimit(`mcp:${ip}`, 60, 60)) return new Response(JSON.stringify(err(null, -32000, "Slow down a little.")), { status: 429, headers: H });
  const body = await req.json().catch(() => undefined);
  if (body === undefined) return new Response(JSON.stringify(err(null, -32700, "Parse error")), { status: 400, headers: H });
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.slice(0, 10).map((m) => one(m, ip)))).filter(Boolean);
    return out.length ? new Response(JSON.stringify(out), { headers: H }) : new Response(null, { status: 202, headers: H });
  }
  const r = await one(body, ip);
  return r ? new Response(JSON.stringify(r), { headers: H }) : new Response(null, { status: 202, headers: H });
}
// no server-to-client stream: GET is not offered (the spec allows 405)
export async function GET() {
  return new Response(JSON.stringify({ name: "ratnet", mcp: `${SITE.url}/api/mcp`, transport: "streamable-http", tools: TOOLS.map((t) => t.name) }), { status: 405, headers: { ...H, allow: "POST" } });
}
export async function DELETE() {
  return new Response(null, { status: 405, headers: { ...H, allow: "POST" } });
}
export async function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...H, "access-control-allow-methods": "POST, GET, OPTIONS", "access-control-allow-headers": "content-type, mcp-protocol-version, mcp-session-id, accept, authorization" } });
}
