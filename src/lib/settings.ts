import { DEFAULT_SETTINGS, Settings } from "@/config/site";
import { K, redis } from "./redis";

// v0.1.38: read at most every 3s per process (20 call sites read it, several of them every loop); a save in this
// process clears it at once
let cached: { at: number; v: Partial<Settings> | null } | null = null;
let inflight: Promise<Partial<Settings> | null> | null = null;
async function readRaw() {
  if (cached && Date.now() - cached.at < 3_000) return cached.v;
  // v0.1.41: callers arriving together share one read
  if (inflight) return inflight;
  inflight = redis()
    .get<Partial<Settings>>(K.settings)
    .then((v) => ((cached = { at: Date.now(), v }), v))
    .finally(() => (inflight = null));
  return inflight;
}

export async function getSettings(): Promise<Settings> {
  try {
    const s = await readRaw();
    return {
      ...DEFAULT_SETTINGS,
      ...(s || {}),
      litter: { ...DEFAULT_SETTINGS.litter, ...(s?.litter || {}) },
      // an empty link saved in /admin never hides a default (the X handle is known)
      links: { ...DEFAULT_SETTINGS.links, ...Object.fromEntries(Object.entries(s?.links || {}).filter(([, v]) => !!v)) },
      desk: { ...DEFAULT_SETTINGS.desk, ...(s?.desk || {}) },
      refs: { ...DEFAULT_SETTINGS.refs, ...(s?.refs || {}) },
      venueTpl: { ...DEFAULT_SETTINGS.venueTpl, ...(s?.venueTpl || {}) },
      history: { ...DEFAULT_SETTINGS.history, ...(s?.history || {}) },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(patch: Partial<Settings>) {
  cached = null; // a save always starts from what is stored
  const cur = await getSettings();
  const next: Settings = {
    ...cur,
    ...patch,
    litter: { ...cur.litter, ...(patch.litter || {}) },
    links: { ...cur.links, ...(patch.links || {}) },
    refs: { ...cur.refs, ...(patch.refs || {}) },
    venueTpl: { ...cur.venueTpl, ...(patch.venueTpl || {}) },
    desk: { ...cur.desk, ...(patch.desk || {}) },
    history: { ...cur.history, ...(patch.history || {}) },
  };
  await redis().set(K.settings, next);
  cached = null;
  return next;
}
