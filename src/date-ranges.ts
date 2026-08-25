// Expanding a temporal ref (week / month / quarter / year) into the refs below it.
//
// These are pure string→string functions over calendar labels. A ref like
// "2026-W35" names the same seven days no matter where the machine is, so every
// step here is UTC arithmetic and the output is timezone-independent by
// construction. Choosing WHICH ref an instant belongs to is a separate,
// genuinely zone-dependent question and lives in src/local-date.ts.
//
// The four implementations these replace (weekDatesLocal + monthDates in
// episode-daemon.ts, weekDates + monthWeeks in recall-engine.ts) built dates
// with local-time constructors — `new Date(year, 0, 4)`, `new Date(year, month-1, 1)`
// — and then read them back with `.toISOString()`, i.e. as UTC. At or east of
// UTC the constructed midnight falls on the previous UTC day and every date
// shifts by one:
//
//   TZ                    weekDates("2026-W35")       monthDates("2026-08")
//   Etc/UTC               Aug 24..Aug 30   correct    Aug 01..Aug 31  correct
//   America/Los_Angeles   Aug 24..Aug 30   correct    Aug 01..Aug 31  correct
//   Europe/Stockholm      Aug 23..Aug 29   WRONG      Jul 31..Aug 30  WRONG
//   Asia/Kolkata          Aug 23..Aug 29   WRONG      Jul 31..Aug 30  WRONG
//   Pacific/Kiritimati    Aug 23..Aug 29   WRONG      Jul 31..Aug 30  WRONG
//
// Negative offsets are safe only because the shift rounds the other way, so the
// Pacific move would not have exposed this; a Sweden trip would have broken week
// and month recall on the first query. Same failure class cascade-decision.ts
// dateToWeek() already documents and already solved in UTC — the week helper
// here is defined against that function so a date and its week can never
// disagree.

import { dateToWeek } from "./cascade-decision.ts";

/** The seven dates of an ISO week ref ("2026-W35"), Monday first. */
export function weekDates(weekStr: string): string[] {
  const [yearStr, weekStr2] = weekStr.split("-W");
  const year = parseInt(yearStr, 10);
  const week = parseInt(weekStr2, 10);
  // ISO week 1 is the week containing Jan 4, so Monday of week 1 is Jan 4
  // stepped back to its Monday; week N's Monday is 7(N-1) days later.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4DayNum = (jan4.getUTCDay() + 6) % 7; // 0=Mon..6=Sun
  const monday = new Date(jan4.getTime());
  monday.setUTCDate(jan4.getUTCDate() - jan4DayNum + (week - 1) * 7);
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday.getTime());
    d.setUTCDate(monday.getUTCDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

/** Every date in a month ref ("2026-08"). */
export function monthDates(monthStr: string): string[] {
  const [year, month] = monthStr.split("-").map(Number);
  const dates: string[] = [];
  const d = new Date(Date.UTC(year, month - 1, 1));
  while (d.getUTCMonth() === month - 1) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Every ISO week a month's dates fall in, including a week shared with an
 * adjacent month.
 *
 * Derived from monthDates + dateToWeek rather than an inline week formula. The
 * version this replaces hand-rolled its own week numbering with special cases
 * for `wn < 1` and `wn > 52`, and got 53-week years wrong: January 2021 came out
 * as 2020-W52 (correct: 2020-W53) and January 2027 as 2026-W52 (correct:
 * 2026-W53), so recall for those months loaded the wrong neighbouring week.
 */
export function monthWeeks(monthStr: string): string[] {
  return [...new Set(monthDates(monthStr).map(dateToWeek))].sort();
}

/** The three month refs of a quarter ref ("2026-Q3"). */
export function quarterMonths(quarterStr: string): string[] {
  const [yearStr, qStr] = quarterStr.split("-Q");
  const start = (parseInt(qStr, 10) - 1) * 3 + 1;
  return [0, 1, 2].map((i) => `${yearStr}-${String(start + i).padStart(2, "0")}`);
}

/** The four quarter refs of a year ref ("2026"). */
export function yearQuarters(yearStr: string): string[] {
  return [1, 2, 3, 4].map((q) => `${yearStr}-Q${q}`);
}
