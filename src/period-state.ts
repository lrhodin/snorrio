// Whether a temporal period is over, decided from the calendar, never by a model.
//
// A summary written while its period was open reads "July so far" forever
// unless something knows July has ended. This module answers that
// deterministically: a period is closed once its last local date is before
// today's local date (timezone from the tz journal), open while today falls
// inside it, and future before its first date. The answer is framed into every
// recall prompt and recorded in each cache's provenance sidecar, so the cascade
// can rebuild a period exactly once after it closes.

import { SNORRIO_HOME, getTimezone } from "./ai.ts";
import { monthDates, quarterMonths, weekDates } from "./date-ranges.ts";
import { resolveLocalDate } from "./local-date.ts";
import { createZoneResolver, tzJournalPath } from "./tz-journal.ts";
import type { CacheLevel } from "./cache-provenance.ts";

export type PeriodState = "future" | "open" | "closed";

let resolver: ReturnType<typeof createZoneResolver> | undefined;

/** Today's local date (YYYY-MM-DD) in the zone the tz journal says is in effect now. */
export function currentLocalDate(now: Date = new Date()): string {
  resolver ??= createZoneResolver({
    path: tzJournalPath(SNORRIO_HOME),
    fallbackZone: getTimezone,
    onError: (message) => process.stderr.write(`[snorrio:period] WARNING: ${message}\n`),
  });
  return resolveLocalDate(now, resolver(now).tz).date;
}

/** First and last local date of a period ref. */
export function periodBounds(level: CacheLevel, ref: string): { start: string; end: string } {
  let dates: string[];
  switch (level) {
    case "day": dates = [ref]; break;
    case "week": dates = weekDates(ref); break;
    case "month": dates = monthDates(ref); break;
    case "quarter": dates = quarterMonths(ref).flatMap(monthDates); break;
    case "year": dates = [`${ref}-01-01`, `${ref}-12-31`]; break;
  }
  return { start: dates[0], end: dates[dates.length - 1] };
}

export function periodState(level: CacheLevel, ref: string, today: string = currentLocalDate()): PeriodState {
  const { start, end } = periodBounds(level, ref);
  if (today < start) return "future";
  if (today > end) return "closed";
  return "open";
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** One paragraph stating the period's dates, today's date, and whether it is over. */
export function periodFraming(level: CacheLevel, ref: string, today: string = currentLocalDate()): string {
  const { start, end } = periodBounds(level, ref);
  const span = start === end ? start : `${start} to ${end}`;
  const state = periodState(level, ref, today);
  if (state === "closed") {
    return `PERIOD: ${level} ${ref} (${span}). Today is ${today}. This period is over and its record is complete. Write about it in the past tense as a finished whole: say how things turned out, and name what carried forward past its end. Never describe it as ongoing or "so far".`;
  }
  if (state === "open") {
    const remaining = daysBetween(today, end);
    const left = remaining === 0 ? "today is its last day" : `${remaining} day${remaining === 1 ? "" : "s"} remain`;
    return `PERIOD: ${level} ${ref} (${span}). Today is ${today}, so this period is still in progress (${left}). Describe it as unfinished: do not conclude it or state outcomes that have not happened yet.`;
  }
  return `PERIOD: ${level} ${ref} (${span}). Today is ${today}; this period has not started. Nothing in it has happened.`;
}
