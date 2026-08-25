// Resolving an instant into a wall-clock date, and the frontmatter block that
// freezes the result.
//
// Two properties matter here:
//   1. The resolution depends on the NAMED zone, never on the host zone. The
//      implementation this replaces reparsed a formatted string
//      (new Date(d.toLocaleString("en-US", { timeZone: tz }))) and then read
//      local-time getters off the result, which reintroduces the host zone the
//      conversion was meant to remove.
//   2. Once written, local_date is never recomputed. Everything downstream
//      buckets on the stored value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLocalDate, resolveUtcOffset, temporalRefs } from "../src/local-date.ts";
import { dateToWeek } from "../src/cascade-decision.ts";
import {
  buildEpisodeFrontmatter,
  parseEpisodeFrontmatter,
  upsertEpisodeLocalDate,
  type EpisodeLocalDate,
} from "../src/episode-frontmatter.ts";
import type { SessionLineage } from "../src/session-lineage.ts";

const HOST_ZONES = ["UTC", "America/Los_Angeles", "Europe/Stockholm", "Asia/Kolkata", "Asia/Kathmandu", "Pacific/Marquesas"];

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

test("resolveLocalDate depends on the named zone, not the host zone", () => {
  // 2026-08-25T02:00:00Z is still Aug 24 in Los Angeles and already Aug 25 in
  // Stockholm, whatever the host is set to.
  const instant = new Date("2026-08-25T02:00:00Z");
  const expected: Record<string, string> = {
    "Etc/UTC": "2026-08-25",
    "America/Los_Angeles": "2026-08-24",
    "Europe/Stockholm": "2026-08-25",
    "Asia/Kolkata": "2026-08-25",
  };
  for (const host of HOST_ZONES) {
    underTz(host, () => {
      for (const [tz, date] of Object.entries(expected)) {
        assert.equal(resolveLocalDate(instant, tz).date, date, `${tz} under host ${host}`);
      }
    });
  }
});

test("resolveLocalDate returns parts consistent with the date string", () => {
  const parts = resolveLocalDate(new Date("2026-08-25T02:00:00Z"), "America/Los_Angeles");
  assert.deepEqual(parts, { date: "2026-08-24", year: 2026, month: 8, day: 24 });
  // A pre-2000 instant, to catch two-digit-year formatting.
  assert.equal(resolveLocalDate(new Date("1999-01-05T12:00:00Z"), "Etc/UTC").date, "1999-01-05");
});

test("resolveUtcOffset handles zero, whole-hour, DST and minute offsets", () => {
  const summer = new Date("2026-08-25T12:00:00Z");
  const winter = new Date("2026-01-15T12:00:00Z");
  assert.equal(resolveUtcOffset(summer, "Etc/UTC"), "+00:00");
  assert.equal(resolveUtcOffset(summer, "America/Los_Angeles"), "-07:00"); // PDT
  assert.equal(resolveUtcOffset(winter, "America/Los_Angeles"), "-08:00"); // PST
  assert.equal(resolveUtcOffset(summer, "Europe/Stockholm"), "+02:00");
  assert.equal(resolveUtcOffset(winter, "Europe/Stockholm"), "+01:00");
  // Minute offsets — the case the format-then-reparse approach round-tripped
  // only by luck.
  assert.equal(resolveUtcOffset(summer, "Asia/Kolkata"), "+05:30");
  assert.equal(resolveUtcOffset(summer, "Asia/Kathmandu"), "+05:45");
  assert.equal(resolveUtcOffset(summer, "Australia/Eucla"), "+08:45");
  assert.equal(resolveUtcOffset(summer, "Pacific/Marquesas"), "-09:30");
});

test("temporalRefs derives week/month/quarter/year from the resolved date", () => {
  const refs = temporalRefs(new Date("2026-08-25T02:00:00Z"), "America/Los_Angeles");
  assert.deepEqual(refs, {
    today: "2026-08-24",
    yesterday: "2026-08-23",
    week: "2026-W35",
    month: "2026-08",
    quarter: "2026-Q3",
    year: "2026",
  });
  // The week must be the shared ISO implementation, not a second formula.
  assert.equal(refs.week, dateToWeek(refs.today));
});

test("temporalRefs is host-zone independent and correct across boundaries", () => {
  const cases: Array<[string, string, Partial<ReturnType<typeof temporalRefs>>]> = [
    // Month boundary: Sep 1 UTC is still Aug 31 in LA.
    ["2026-09-01T04:00:00Z", "America/Los_Angeles", { today: "2026-08-31", month: "2026-08", quarter: "2026-Q3" }],
    // Year and ISO-week boundary: Jan 1 2027 falls in 2026-W53.
    ["2027-01-01T12:00:00Z", "Etc/UTC", { today: "2027-01-01", week: "2026-W53", month: "2027-01", quarter: "2027-Q1", year: "2027" }],
    // Yesterday across a month boundary.
    ["2026-03-01T12:00:00Z", "Etc/UTC", { today: "2026-03-01", yesterday: "2026-02-28" }],
    // Yesterday across a leap day.
    ["2024-03-01T12:00:00Z", "Etc/UTC", { today: "2024-03-01", yesterday: "2024-02-29" }],
    // Quarter boundary.
    ["2026-07-01T00:30:00Z", "Etc/UTC", { quarter: "2026-Q3" }],
    ["2026-07-01T00:30:00Z", "America/Los_Angeles", { today: "2026-06-30", quarter: "2026-Q2" }],
  ];
  for (const host of HOST_ZONES) {
    underTz(host, () => {
      for (const [iso, tz, expected] of cases) {
        const refs = temporalRefs(new Date(iso), tz);
        for (const [key, value] of Object.entries(expected)) {
          assert.equal((refs as any)[key], value, `${key} for ${iso} in ${tz} (host ${host})`);
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

const LINEAGE: SessionLineage = {
  sessionId: "s1",
  sessionPath: "/home/me/s1.jsonl",
  parentSessionId: null,
  rootSessionId: "s1",
  provenanceFamilyId: "s1",
  lineageDepth: 0,
  lineageSource: "none",
  lineageComplete: true,
  lineageConflict: false,
  dependencySessionIds: [],
  issues: [],
};

const LOCAL_DATE: EpisodeLocalDate = {
  localDate: "2026-08-24",
  tz: "America/Los_Angeles",
  utcOffset: "-07:00",
  tzSource: "system",
};

test("buildEpisodeFrontmatter emits the four keys in a stable order", () => {
  const fm = buildEpisodeFrontmatter({
    origin: "pi",
    machine: "test",
    sourcePath: "/home/me/s1.jsonl",
    home: "/home/me",
    timestamp: "2026-08-25T02:00:00.000Z",
    lineage: LINEAGE,
    localDate: LOCAL_DATE,
  });
  const keys = fm.split("\n").map((line) => line.match(/^([a-z_]+):/)?.[1]).filter(Boolean);
  assert.deepEqual(
    keys.slice(0, 8),
    ["origin", "machine", "source", "timestamp", "local_date", "tz", "utc_offset", "tz_source"],
    `unexpected key order: ${keys.join(",")}`,
  );
  const fields = parseEpisodeFrontmatter(fm).fields;
  assert.equal(fields.get("local_date"), '"2026-08-24"');
  assert.equal(fields.get("tz"), '"America/Los_Angeles"');
  assert.equal(fields.get("utc_offset"), '"-07:00"');
  assert.equal(fields.get("tz_source"), '"system"');
  // local_date is the bucket, and it is NOT the UTC date of the timestamp.
  assert.notEqual(fields.get("local_date"), '"2026-08-25"');
});

test("upsertEpisodeLocalDate preserves prose byte-for-byte and is idempotent", () => {
  const prose = "\nExact prose.\n\n---\n\nA horizontal rule that must not be read as a delimiter.\n\tTabs\ttoo.\n";
  const before = ["---", 'origin: "pi"', 'timestamp: "2026-08-25T02:00:00.000Z"', "---", prose].join("\n");
  const originalProse = parseEpisodeFrontmatter(before).prose;

  const once = upsertEpisodeLocalDate(before, LOCAL_DATE);
  assert.equal(parseEpisodeFrontmatter(once).prose, originalProse, "prose must be untouched");
  assert.equal(parseEpisodeFrontmatter(once).fields.get("local_date"), '"2026-08-24"');
  // Unrelated keys survive.
  assert.equal(parseEpisodeFrontmatter(once).fields.get("origin"), '"pi"');

  const twice = upsertEpisodeLocalDate(once, LOCAL_DATE);
  assert.equal(twice, once, "a second run must produce identical bytes");
});

test("upsertEpisodeLocalDate replaces an existing block in place, not by appending", () => {
  const first = upsertEpisodeLocalDate(
    ["---", 'origin: "pi"', 'machine: "m"', "---", "", "body"].join("\n"),
    LOCAL_DATE,
  );
  const changed = upsertEpisodeLocalDate(first, { ...LOCAL_DATE, localDate: "2026-08-25", tz: "Etc/UTC", utcOffset: "+00:00", tzSource: "assumed" });
  const fields = parseEpisodeFrontmatter(changed).fields;
  assert.equal(fields.get("local_date"), '"2026-08-25"');
  assert.equal(fields.get("tz"), '"Etc/UTC"');
  assert.equal(fields.get("tz_source"), '"assumed"');
  // Exactly one of each key — no duplicates accumulated.
  for (const key of ["local_date", "tz", "utc_offset", "tz_source"]) {
    const count = changed.split("\n").filter((line) => line.startsWith(`${key}:`)).length;
    assert.equal(count, 1, `expected one ${key} line, found ${count}`);
  }
  // And the block stays where it was rather than migrating to the end.
  const keys = changed.slice(4, changed.indexOf("\n---\n", 4)).split("\n").map((l) => l.split(":")[0]);
  assert.deepEqual(keys, ["origin", "machine", "local_date", "tz", "utc_offset", "tz_source"]);
});

test("upsertEpisodeLocalDate refuses an episode with no frontmatter rather than inventing one", () => {
  assert.throws(() => upsertEpisodeLocalDate("just prose\n", LOCAL_DATE), /without frontmatter/);
  assert.throws(() => upsertEpisodeLocalDate("---\nunterminated: true\n", LOCAL_DATE), /malformed/);
});
