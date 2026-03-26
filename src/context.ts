// Context loader — shared date math and cache reading.
//
// Returns a string to inject at session start.
// Used by the pi extension (dmn-context.ts).
//
// Usage:
//   import { loadContext } from "./context.ts";
//   const text = loadContext();  // string or null

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME!;
const SNORRIO_HOME = process.env.SNORRIO_HOME || join(HOME, ".pi/agent/git/github.com/lrhodin/snorrio");
const CACHE_DIR = join(SNORRIO_HOME, "cache");
function readFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function readCache(level: string, key: string): string | null {
  return readFile(join(CACHE_DIR, level, `${key}.md`));
}

function loadTimezone(): string {
  try {
    const configPath = join(HOME, ".config/snorrio/config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    return config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }
}

export function getDateRefs() {
  const tz = loadTimezone();
  const now = new Date();
  const pt = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  const today = `${pt.getFullYear()}-${String(pt.getMonth() + 1).padStart(2, "0")}-${String(pt.getDate()).padStart(2, "0")}`;

  const yd = new Date(pt);
  yd.setDate(yd.getDate() - 1);
  const yesterday = `${yd.getFullYear()}-${String(yd.getMonth() + 1).padStart(2, "0")}-${String(yd.getDate()).padStart(2, "0")}`;

  const dayOfYear = Math.floor((pt.getTime() - new Date(pt.getFullYear(), 0, 1).getTime()) / 86400000) + 1;
  const dow = pt.getDay() || 7;
  const wn = Math.floor((dayOfYear - dow + 10) / 7);
  let wy = pt.getFullYear();
  if (wn < 1) wy--;
  const week = `${wy}-W${String(Math.max(1, wn)).padStart(2, "0")}`;

  const month = today.slice(0, 7);
  const q = Math.floor(pt.getMonth() / 3) + 1;
  const quarter = `${pt.getFullYear()}-Q${q}`;

  return { today, yesterday, week, month, quarter };
}

/**
 * Build the context string for session injection.
 * Returns null if there's nothing to inject.
 */
export function loadContext(): string | null {
  const sections: string[] = [];

  const refs = getDateRefs();
  const temporal: string[] = [];

  const todayCtx = readCache("days", refs.today);
  const yesterdayCtx = readCache("days", refs.yesterday);
  const weekCtx = readCache("weeks", refs.week);
  const monthCtx = readCache("months", refs.month);
  const quarterCtx = readCache("quarters", refs.quarter);

  if (todayCtx) temporal.push(`### Today\n${todayCtx}`);
  if (!todayCtx && yesterdayCtx) temporal.push(`### Yesterday (${refs.yesterday})\n${yesterdayCtx}`);
  if (weekCtx) temporal.push(`### This week\n${weekCtx}`);
  if (monthCtx) temporal.push(`### This month\n${monthCtx}`);
  if (quarterCtx) temporal.push(`### This quarter\n${quarterCtx}`);

  if (temporal.length > 0) {
    sections.push(`## Current state\n<generated ${refs.today}>\n\n${temporal.join("\n\n")}`);
  }

  if (sections.length === 0) return null;
  return sections.join("\n\n");
}
