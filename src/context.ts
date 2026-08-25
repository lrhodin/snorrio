// Context loader — shared date math and cache reading.
//
// Returns a string to inject at session start.
// Used by the pi extension (dmn-context.ts).
//
// Usage:
//   import { loadContext } from "./context.ts";
//   const text = loadContext();  // string or null

import { readFileSync } from "fs";
import { join } from "path";
import { SNORRIO_HOME, CONFIG_PATH } from "./ai.ts";
import { temporalRefs } from "./local-date.ts";

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
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }
}

// Which cache refs to inject for "now".
//
// Was `new Date(now.toLocaleString("en-US", { timeZone: tz }))` — render the
// instant as a human string, reparse it, then read local-time getters off the
// result — plus a hand-rolled ISO week formula that disagreed with
// cascade-decision.ts dateToWeek() in 53-week years. Both are now the shared
// Intl-based resolution in src/local-date.ts, which derives week/month/quarter
// from the resolved Y/M/D instead of from a reparsed Date.
export function getDateRefs() {
  return temporalRefs(new Date(), loadTimezone());
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
  const yearCtx = readCache("years", refs.year);

  if (todayCtx) temporal.push(`### Today\n${todayCtx}`);
  if (!todayCtx && yesterdayCtx) temporal.push(`### Yesterday (${refs.yesterday})\n${yesterdayCtx}`);
  if (weekCtx) temporal.push(`### This week\n${weekCtx}`);
  if (monthCtx) temporal.push(`### This month\n${monthCtx}`);
  if (quarterCtx) temporal.push(`### This quarter\n${quarterCtx}`);
  if (yearCtx) temporal.push(`### This year\n${yearCtx}`);

  if (temporal.length > 0) {
    sections.push(`## Current state\n<generated ${refs.today}>\n\n${temporal.join("\n\n")}`);
  }

  if (sections.length === 0) return null;
  return sections.join("\n\n");
}
