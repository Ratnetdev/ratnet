import { put } from "@vercel/blob";
import { K, redis } from "./redis";

export type ExportEntry = { day: string; rows: number; url: string; at: number };

/** Bundle one UTC day of resolved launches into a public JSONL file on Vercel Blob. */
export async function exportDay(day: string): Promise<ExportEntry> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("Vercel Blob storage is not connected");
  const r = redis();
  const lines: string[] = [];
  for (let h = 0; h < 24; h++) {
    const key = K.resolvedHour(`${day}T${String(h).padStart(2, "0")}`);
    const rows = (await r.lrange<Record<string, unknown>>(key, 0, -1)) || [];
    for (const row of rows) lines.push(JSON.stringify(row));
  }
  if (!lines.length) throw new Error(`No resolved launches stored for ${day}`);
  const blob = await put(`dataset/ratnet-${day}.jsonl`, lines.join("\n") + "\n", {
    access: "public",
    contentType: "application/x-ndjson",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  const entry: ExportEntry = { day, rows: lines.length, url: blob.url, at: Date.now() };
  const list = ((await r.lrange<ExportEntry>(K.exports, 0, -1)) || []).filter((e) => e.day !== day);
  list.unshift(entry);
  list.sort((a, b) => (a.day < b.day ? 1 : -1));
  const p = r.pipeline();
  p.del(K.exports);
  p.rpush(K.exports, ...list.slice(0, 365));
  await p.exec();
  return entry;
}

export async function getExports(): Promise<ExportEntry[]> {
  return ((await redis().lrange<ExportEntry>(K.exports, 0, -1)) || []) as ExportEntry[];
}
