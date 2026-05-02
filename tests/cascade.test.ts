// Tests for the pure cascade decision.
//
// The big bug this guards against: April 2026, snorrio confidently surfaced a
// meeting that supposedly happened in January when a March transcript existed.
// Root cause was a higher-tier temporal cache (month) that didn't get
// regenerated after a day cache changed. The README in episode-daemon.ts
// promises "Higher caches are never more than ~24 hours stale" via
// "Day boundary (first episode of new day) → regenerate month, quarter, year".
//
// The tests below pin down the *actual* contract the daemon implements,
// which is simpler than the README suggests: every live-mode episode triggers
// a full cascade from `from` up to year for the dates passed in, gated only
// by `_skipCascade`. There is no per-tier last-regen tracking. See
// output/cascade.md for the divergence note.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideCascade, dateToWeek, monthToQuarter } from "../src/cascade-decision.ts";

test("first episode of a new day cascades day → year for that date", () => {
  const d = decideCascade(["2026-05-02"]);
  assert.deepEqual(d, {
    day: ["2026-05-02"],
    week: [dateToWeek("2026-05-02")],
    month: ["2026-05"],
    quarter: [monthToQuarter("2026-05")],
    year: ["2026"],
  });
});

test("mid-day episode (same day, called again) regenerates the same full stack", () => {
  // The daemon does not distinguish "first episode of day" from "later episode
  // of day" — both go through cascadeForDate which calls batchCascade(set, 'day').
  // This pins that contract: same input → same full cascade.
  const first = decideCascade(["2026-05-02"]);
  const later = decideCascade(["2026-05-02"]);
  assert.deepEqual(first, later);
  assert.equal(later.year.length, 1);
  assert.equal(later.quarter.length, 1);
  assert.equal(later.month.length, 1);
});

test("episodes spanning a week boundary produce two week refs but one month/quarter/year", () => {
  // 2026-W18 ends Sun 2026-05-03; 2026-W19 starts Mon 2026-05-04.
  const d = decideCascade(["2026-05-03", "2026-05-04"]);
  assert.deepEqual(d.day, ["2026-05-03", "2026-05-04"]);
  assert.deepEqual(d.week, ["2026-W18", "2026-W19"]);
  assert.deepEqual(d.month, ["2026-05"]);
  assert.deepEqual(d.quarter, ["2026-Q2"]);
  assert.deepEqual(d.year, ["2026"]);
});

test("episodes spanning a year boundary cascade up to two years", () => {
  const d = decideCascade(["2025-12-31", "2026-01-01"]);
  assert.deepEqual(d.day, ["2025-12-31", "2026-01-01"]);
  // Both years must be in the year tier — the bug we're guarding against
  // is exactly the case where a higher tier silently doesn't regenerate.
  assert.deepEqual(d.year, ["2025", "2026"]);
  assert.deepEqual(d.quarter, ["2025-Q4", "2026-Q1"]);
  assert.deepEqual(d.month, ["2025-12", "2026-01"]);
  assert.equal(d.week.length >= 1, true);
});

test("skipCascade=true suppresses every tier", () => {
  const d = decideCascade(["2026-05-02"], "day", { skipCascade: true });
  assert.deepEqual(d, { day: [], week: [], month: [], quarter: [], year: [] });
});

test("skipCascade=true suppresses regardless of starting level", () => {
  for (const from of ["day", "week", "month", "quarter", "year"] as const) {
    const d = decideCascade(["2026-05-02", "2026-05-04"], from, { skipCascade: true });
    assert.deepEqual(d, { day: [], week: [], month: [], quarter: [], year: [] }, `from=${from}`);
  }
});

test("from='week' skips day tier (used by --reprocess background phase)", () => {
  const d = decideCascade(["2026-05-02"], "week");
  assert.deepEqual(d.day, []);
  assert.deepEqual(d.week, [dateToWeek("2026-05-02")]);
  assert.deepEqual(d.month, ["2026-05"]);
  assert.deepEqual(d.quarter, ["2026-Q2"]);
  assert.deepEqual(d.year, ["2026"]);
});

test("from='year' regenerates only year", () => {
  const d = decideCascade(["2026-05-02"], "year");
  assert.deepEqual(d, { day: [], week: [], month: [], quarter: [], year: ["2026"] });
});

test("empty input produces an all-empty decision", () => {
  assert.deepEqual(decideCascade([]), { day: [], week: [], month: [], quarter: [], year: [] });
});

test("duplicate dates are collapsed", () => {
  const d = decideCascade(["2026-05-02", "2026-05-02", "2026-05-02"]);
  assert.deepEqual(d.day, ["2026-05-02"]);
  assert.deepEqual(d.year, ["2026"]);
});

test("dateToWeek handles a typical mid-year date", () => {
  // 2026-01-01 is a Thursday → ISO week 2026-W01.
  assert.equal(dateToWeek("2026-01-01"), "2026-W01");
  // 2026-05-02 is a Saturday in 2026-W18.
  assert.equal(dateToWeek("2026-05-02"), "2026-W18");
});

test("dateToWeek: ISO 8601 boundaries (regression)", () => {
  // Mon 2024-12-30 belongs to 2025-W01 (its Thursday is 2025-01-02).
  // Prior implementation returned 2025-W53.
  assert.equal(dateToWeek("2024-12-30"), "2025-W01");
  assert.equal(dateToWeek("2024-12-29"), "2024-W52");

  // 2020 is a 53-week year (Jan 1 was Wed, Dec 31 was Thu).
  assert.equal(dateToWeek("2020-12-31"), "2020-W53");
  // Sun 2021-01-03 is the last day of 2020-W53.
  // Prior implementation returned 2020-W01.
  assert.equal(dateToWeek("2021-01-03"), "2020-W53");
  assert.equal(dateToWeek("2021-01-04"), "2021-W01");

  // 2026 is a 53-week year (Dec 31 2026 is Thursday).
  assert.equal(dateToWeek("2026-12-31"), "2026-W53");
  assert.equal(dateToWeek("2027-01-03"), "2026-W53");
  assert.equal(dateToWeek("2027-01-04"), "2027-W01");

  // 2009 was also 53-week.
  assert.equal(dateToWeek("2009-12-31"), "2009-W53");
  assert.equal(dateToWeek("2010-01-03"), "2009-W53");
});

test("monthToQuarter splits the year correctly", () => {
  assert.equal(monthToQuarter("2026-01"), "2026-Q1");
  assert.equal(monthToQuarter("2026-03"), "2026-Q1");
  assert.equal(monthToQuarter("2026-04"), "2026-Q2");
  assert.equal(monthToQuarter("2026-12"), "2026-Q4");
});
