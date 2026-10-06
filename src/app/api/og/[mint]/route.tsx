import { ImageResponse } from "next/og";
import { K, redis } from "@/lib/redis";

export const runtime = "edge";

type C = { symbol: string; name: string; score: number; verdict: string; nano?: { score: number; verdict: string } | null; outcome: string | null; progress: number };
type L = { symbol: string; name: string; outcome?: string; bondSecs?: number; pNow?: number; call?: C };

const COLORS: Record<string, string> = { BOND: "#ffb547", WATCH: "#7fd1ff", DUST: "#ff5c5c", BONDED: "#ffb547", DIED: "#ff5c5c", ALIVE: "#8a9a91" };

export async function GET(_: Request, { params }: { params: { mint: string } }) {
  let launch: L | null = null;
  let call: C | null = null;
  try {
    [launch, call] = await Promise.all([redis().get<L>(K.launch(params.mint)), redis().get<C>(K.call(params.mint))]);
  } catch {}
  call = call || launch?.call || null;
  const sym = call?.symbol || launch?.symbol || "???";
  const outcome = call?.outcome || launch?.outcome || null;
  const v = call?.verdict || "PENDING";
  const sc = call?.score ?? null;

  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", flexDirection: "column", background: "#060807", color: "#c8d3cc", padding: 60, fontFamily: "monospace" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 30, color: "#8cff5a" }}>
          <span>RATNET · RAT KING</span>
          <span style={{ color: "#6c7b73" }}>ratnet.fun</span>
        </div>
        <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", fontSize: 110, color: "#ffffff" }}>{`$${sym.slice(0, 10)}`}</div>
            <div style={{ display: "flex", fontSize: 34, color: "#6c7b73" }}>{(call?.name || launch?.name || "").slice(0, 34)}</div>
            <div style={{ display: "flex", fontSize: 34, marginTop: 30 }}>
              <span style={{ color: "#6c7b73", marginRight: 14 }}>outcome</span>
              <span style={{ color: outcome ? COLORS[outcome] : "#6c7b73" }}>
                {outcome ? (outcome === "BONDED" && launch?.bondSecs ? `BONDED in ${Math.round(launch.bondSecs / 60)}m` : outcome) : "pending"}
              </span>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
            <div style={{ display: "flex", fontSize: 200, lineHeight: 1, color: COLORS[v] || "#8cff5a" }}>{sc ?? "–"}</div>
            <div style={{ display: "flex", fontSize: 48, color: COLORS[v] || "#8cff5a", border: `3px solid ${COLORS[v] || "#8cff5a"}`, padding: "4px 20px", marginTop: 10 }}>{v}</div>
            {call?.nano ? <div style={{ display: "flex", fontSize: 28, color: "#6c7b73", marginTop: 14 }}>{`nano ${call.nano.verdict} ${call.nano.score}`}</div> : null}
          </div>
        </div>
        <div style={{ display: "flex", fontSize: 24, color: "#3d4a43" }}>called 5 minutes after launch · every call logged and checked on chain</div>
      </div>
    ),
    { width: 1200, height: 630, headers: { "cache-control": "public, s-maxage=60, stale-while-revalidate=300" } }
  );
}
