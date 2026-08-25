// Which daily log file an instant belongs to.
//
// The defect this removes: the daemon named its log file
// `new Date().toISOString().slice(0, 10)` and `snorrio flush` computed the same
// UTC date to find the file it tails. Once this box moved to Pacific, every
// line logged from 17:00 PDT onward went into a file named for tomorrow — the
// one thing in the store still bucketed by a UTC date after episodes stopped
// being. A log named for a day that had not started yet also splits an evening's
// work across two files, which is exactly when you go looking for it.
//
// The two call sites MUST agree: `flush` tails the file the daemon writes, and a
// disagreement is not a wrong name but a hang — the spinner watches a file
// nothing is appending to until the 5-minute timeout. So the name is built in
// one place, here, and both callers route through it. tests/log-file.test.ts
// asserts no one reintroduces a second path.
//
// Deliberately NOT changed: the timestamp INSIDE a line stays UTC ISO-8601
// (`[DMN] 2026-08-25T20:18:32.123Z ...`). A log line records an instant, and an
// instant should read the same from anywhere — a wall-clock stamp with no zone
// is ambiguous exactly when a zone change makes you want to read it. Only the
// filename buckets by local date, because a file per day is a human's question
// ("what happened yesterday evening") and a day is local.

import { join } from "node:path";
import { resolveLocalDate } from "./local-date.ts";
import type { ZoneResolver } from "./tz-journal.ts";

export const LOGS_DIR_NAME = "logs";

export function logsDir(snorrioHome: string): string {
  return join(snorrioHome, LOGS_DIR_NAME);
}

/**
 * Path of the log file `instant` belongs to, in the zone that was in effect AT
 * that instant.
 *
 * Takes the resolver rather than building one, so a caller that already asks the
 * journal per instant (the daemon) asks it exactly once more, through the same
 * function that decides an episode's day directory.
 *
 * Historical files keep their UTC names. They were written in the UTC era and
 * that is honest; renaming them would claim they were bucketed by a rule that
 * did not exist yet. One seam file therefore holds both, which is what a
 * recorded transition looks like.
 */
export function dailyLogPath(snorrioHome: string, instant: Date, resolveZoneFor: ZoneResolver): string {
  const { tz } = resolveZoneFor(instant);
  return join(logsDir(snorrioHome), `${resolveLocalDate(instant, tz).date}.log`);
}
