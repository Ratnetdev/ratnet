import { DEFAULT_SETTINGS, Settings } from "@/config/site";
import { K, redis } from "./redis";

export async function getSettings(): Promise<Settings> {
  try {
    const s = await redis().get<Partial<Settings>>(K.settings);
    return {
      ...DEFAULT_SETTINGS,
      ...(s || {}),
      litter: { ...DEFAULT_SETTINGS.litter, ...(s?.litter || {}) },
      links: { ...DEFAULT_SETTINGS.links, ...(s?.links || {}) },
      desk: { ...DEFAULT_SETTINGS.desk, ...(s?.desk || {}) },
      history: { ...DEFAULT_SETTINGS.history, ...(s?.history || {}) },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(patch: Partial<Settings>) {
  const cur = await getSettings();
  const next: Settings = {
    ...cur,
    ...patch,
    litter: { ...cur.litter, ...(patch.litter || {}) },
    links: { ...cur.links, ...(patch.links || {}) },
    desk: { ...cur.desk, ...(patch.desk || {}) },
    history: { ...cur.history, ...(patch.history || {}) },
  };
  await redis().set(K.settings, next);
  return next;
}
