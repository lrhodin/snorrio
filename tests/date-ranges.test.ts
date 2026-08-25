// Pure date-range logic must be timezone-independent.
//
// The bug: weekDatesLocal/monthDates (episode-daemon) and weekDates/monthWeeks
// (recall-engine) built dates with LOCAL-time constructors — new Date(year, 0, 4),
// new Date(year, month-1, 1) — then read them back with .toISOString(), i.e. as
// UTC. At or east of UTC the constructed local midnight lands on the previous UTC
// day and every date shifts by one:
//
//   TZ                    weekDates("2026-W35")    monthDates("2026-08")
//   Etc/UTC               Aug 24..Aug 30  ok       Aug 01..Aug 31  ok
//   America/Los_Angeles   Aug 24..Aug 30  ok       Aug 01..Aug 31  ok
//   Europe/Stockholm      Aug 23..Aug 29  WRONG    Jul 31..Aug 30  WRONG
//   Asia/Kolkata          Aug 23..Aug 29  WRONG    Jul 31..Aug 30  WRONG
//
// Pacific passed only because a negative offset rounds the other way, so the
// planned Pacific switch would NOT have surfaced this; a Sweden trip would have
// broken week and month recall immediately.
//
// A ref like "2026-W35" names the same seven days everywhere, so these functions
// must return byte-identical output under every zone. Modelled on
// tests/cascade.test.ts — pure logic, no filesystem, no LLM.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dateToWeek } from "../src/cascade-decision.ts";
import { monthDates, monthWeeks, quarterMonths, weekDates, yearQuarters } from "../src/date-ranges.ts";

const ZONES = ["UTC", "America/Los_Angeles", "Europe/Stockholm", "Asia/Kolkata"];

// Minute-offset and extreme-offset zones, where a shift-by-one is not the only
// way to be wrong.
const EXOTIC_ZONES = ["Asia/Kathmandu", "Australia/Eucla", "Pacific/Marquesas", "Pacific/Kiritimati"];

function underTz<T>(tz: string, fn: () => T): T {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}

test("weekDates and monthDates are identical under every timezone", () => {
  const refs = { weeks: ["2026-W35", "2026-W01", "2025-W53", "2021-W01"], months: ["2026-08", "2026-01", "2026-02", "2024-02", "2026-12"] };
  const baseline = underTz("UTC", () => ({
    weeks: refs.weeks.map(weekDates),
    months: refs.months.map(monthDates),
  }));

  for (const tz of [...ZONES, ...EXOTIC_ZONES]) {
    const got = underTz(tz, () => ({
      weeks: refs.weeks.map(weekDates),
      months: refs.months.map(monthDates),
    }));
    assert.deepEqual(got, baseline, `date ranges differ under TZ=${tz}`);
  }
});

test("monthWeeks, quarterMonths and yearQuarters are identical under every timezone", () => {
  const months = ["2026-08", "2021-01", "2027-01", "2026-12", "2020-12"];
  const baseline = underTz("UTC", () => ({
    weeks: months.map(monthWeeks),
    quarters: ["2026-Q1", "2026-Q3", "2026-Q4"].map(quarterMonths),
    years: ["2026", "2021"].map(yearQuarters),
  }));

  for (const tz of [...ZONES, ...EXOTIC_ZONES]) {
    const got = underTz(tz, () => ({
      weeks: months.map(monthWeeks),
      quarters: ["2026-Q1", "2026-Q3", "2026-Q4"].map(quarterMonths),
      years: ["2026", "2021"].map(yearQuarters),
    }));
    assert.deepEqual(got, baseline, `ref expansion differs under TZ=${tz}`);
  }
});

test("the measured values: W35 is Aug 24-30 and 2026-08 is Aug 01-31, in every zone", () => {
  for (const tz of [...ZONES, ...EXOTIC_ZONES]) {
    underTz(tz, () => {
      const week = weekDates("2026-W35");
      assert.equal(week.length, 7);
      assert.equal(week[0], "2026-08-24", `W35 must start Mon Aug 24 under TZ=${tz}`);
      assert.equal(week[6], "2026-08-30", `W35 must end Sun Aug 30 under TZ=${tz}`);

      const month = monthDates("2026-08");
      assert.equal(month.length, 31);
      assert.equal(month[0], "2026-08-01", `2026-08 must start Aug 01 under TZ=${tz}`);
      assert.equal(month[30], "2026-08-31", `2026-08 must end Aug 31 under TZ=${tz}`);
    });
  }
});

test("weekDates agrees with dateToWeek for every date across 14 years", () => {
  // The two must never disagree: a date's week, expanded back to dates, has to
  // contain that date. This is what makes a cascade land on the week it claims.
  const d = new Date(Date.UTC(2019, 0, 1));
  let checked = 0;
  while (d.getUTCFullYear() < 2033) {
    const date = d.toISOString().slice(0, 10);
    const week = dateToWeek(date);
    assert.ok(weekDates(week).includes(date), `${date} is in ${week}, but weekDates(${week}) omits it`);
    checked++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  assert.ok(checked > 5000, `expected a full sweep, checked ${checked}`);
});

test("ISO week 1 contains Jan 4, and 53-week years resolve to W53 not W52", () => {
  for (let year = 2019; year <= 2032; year++) {
    assert.ok(
      weekDates(`${year}-W01`).includes(`${year}-01-04`),
      `${year}-W01 must contain Jan 4`,
    );
  }
  // The concrete defect in the old recall-engine monthWeeks(), which hard-coded
  // `${wy}-W52` for a date falling in the previous year's final week: January
  // 2021 belongs partly to 2020-W53, and January 2027 to 2026-W53.
  assert.ok(monthWeeks("2021-01").includes("2020-W53"), "2021-01 spans 2020-W53");
  assert.ok(!monthWeeks("2021-01").includes("2020-W52"), "2021-01 must not claim 2020-W52");
  assert.ok(monthWeeks("2027-01").includes("2026-W53"), "2027-01 spans 2026-W53");
  assert.ok(!monthWeeks("2027-01").includes("2026-W52"), "2027-01 must not claim 2026-W52");
});

test("monthDates handles leap years and month lengths", () => {
  assert.equal(monthDates("2024-02").length, 29);
  assert.equal(monthDates("2026-02").length, 28);
  assert.equal(monthDates("2000-02").length, 29); // divisible by 400
  assert.equal(monthDates("1900-02").length, 28); // divisible by 100, not 400
  assert.equal(monthDates("2026-04").length, 30);
  assert.deepEqual(monthDates("2026-12").at(-1), "2026-12-31");
});

test("quarterMonths and yearQuarters cover the calendar exactly once", () => {
  const months = yearQuarters("2026").flatMap(quarterMonths);
  assert.equal(months.length, 12);
  assert.deepEqual(months, Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`));
});
