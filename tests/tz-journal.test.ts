// The timezone journal: resolution, boundaries, and the refusals.
//
// What these guard, in order of how much damage the bug did:
//   1. A zone in effect months ago must still resolve today. The config value
//      this replaces answered "what zone are we in?" for every instant that has
//      ever existed, so a Pacific move would have reinterpreted all 629 existing
//      episodes as having always been Pacific.
//   2. A journal we cannot trust must fail loudly. Silently falling back to the
//      host zone reintroduces exactly the defect the journal removes, at the one
//      moment it matters.
//   3. `tz set` writes, so it must never infer consent — the 2026-08-24 incident
//      where an unrecognized flag was ignored and `--help` performed a real
//      migration.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SEEDED_ERA_TZ,
  appendTzEntry,
  createZoneResolver,
  formatTzEntry,
  isValidZoneName,
  journalHead,
  parseTzJournal,
  readTzJournal,
  resolveZone,
  sameZone,
  tzJournalPath,
  zoneAt,
} from "../src/tz-journal.ts";
import { HISTORICAL_TZ } from "../src/local-date-migration.ts";
import { firstEraStart, tzSet, tzShow } from "../src/tz-command.ts";
import { checkTimezoneJournal } from "../src/setup-checks.ts";
import { resolveLocalDate } from "../src/local-date.ts";

const JOURNAL = [
  '{"from":"2026-07-17T00:00:00Z","tz":"Etc/UTC","note":"vdesk default"}',
  '{"from":"2026-08-25T18:00:00Z","tz":"America/Los_Angeles"}',
  '{"from":"2026-09-02T22:00:00Z","tz":"Europe/Stockholm"}',
].join("\n") + "\n";

function fixture(journal?: string) {
  const home = mkdtempSync(join(tmpdir(), "snorrio-tz-"));
  mkdirSync(join(home, "config"), { recursive: true });
  mkdirSync(join(home, "episodes"), { recursive: true });
  if (journal !== undefined) writeFileSync(tzJournalPath(home), journal);
  return home;
}

test("the seeded era matches the zone frozen onto the existing episodes", () => {
  // 629 episodes carry `tz: Etc/UTC` in frontmatter. A journal whose opening era
  // disagreed would make the same instant resolve two ways depending on which
  // record answered.
  assert.equal(SEEDED_ERA_TZ, HISTORICAL_TZ);
});

test("zoneAt resolves each era, and `from` is inclusive at a transition", () => {
  const entries = parseTzJournal(JOURNAL);
  assert.equal(entries.length, 3);

  // Inside each era.
  assert.equal(zoneAt(entries, new Date("2026-08-01T12:00:00Z"))!.tz, "Etc/UTC");
  assert.equal(zoneAt(entries, new Date("2026-08-26T12:00:00Z"))!.tz, "America/Los_Angeles");
  assert.equal(zoneAt(entries, new Date("2026-09-10T12:00:00Z"))!.tz, "Europe/Stockholm");

  // Exactly at a transition: the era that STARTS there wins, so no millisecond
  // is claimed by two eras.
  assert.equal(zoneAt(entries, new Date("2026-08-25T18:00:00Z"))!.tz, "America/Los_Angeles");
  assert.equal(zoneAt(entries, new Date("2026-08-25T17:59:59.999Z"))!.tz, "Etc/UTC");

  // After the last entry the head simply continues — there is no end time.
  assert.equal(zoneAt(entries, new Date("2030-01-01T00:00:00Z"))!.tz, "Europe/Stockholm");
  assert.equal(journalHead(entries)!.tz, "Europe/Stockholm");

  // Before the first entry: no era covers it.
  assert.equal(zoneAt(entries, new Date("2026-07-16T23:59:59Z")), null);
});

test("an instant before the journal is labelled `assumed`, not silently given today's zone", () => {
  const entries = parseTzJournal(JOURNAL);
  const before = resolveZone(entries, new Date("2020-01-01T00:00:00Z"), "Asia/Kolkata");
  // The deliberate choice: extend the EARLIEST era backwards and say so.
  // Erroring would make reading an old transcript fail rather than degrade;
  // using the CURRENT zone is the exact bug the journal exists to remove.
  assert.equal(before.tz, "Etc/UTC");
  assert.equal(before.source, "assumed");

  const covered = resolveZone(entries, new Date("2026-08-26T00:00:00Z"), "Asia/Kolkata");
  assert.equal(covered.tz, "America/Los_Angeles");
  assert.equal(covered.source, "journal");

  // No journal at all is the only case that reports `system`.
  const none = resolveZone([], new Date(), "Asia/Kolkata");
  assert.deepEqual(none, { tz: "Asia/Kolkata", source: "system" });
});

test("a zone in effect months ago still resolves months later", () => {
  // The property the whole redesign exists for: generating a July episode in
  // September must bucket it in JULY's zone.
  const entries = parseTzJournal(JOURNAL);
  const july = new Date("2026-07-20T23:30:00Z");
  const zone = zoneAt(entries, july)!.tz;
  assert.equal(zone, "Etc/UTC");
  assert.equal(resolveLocalDate(july, zone).date, "2026-07-20");
  // Under the CURRENT head the same instant would land on the previous day.
  assert.equal(resolveLocalDate(july, journalHead(entries)!.tz).date, "2026-07-21");
});

test("an unsorted journal is rejected, naming the offending line", () => {
  const unsorted = [
    '{"from":"2026-08-25T18:00:00Z","tz":"America/Los_Angeles"}',
    '{"from":"2026-07-17T00:00:00Z","tz":"Etc/UTC"}',
  ].join("\n");
  assert.throws(() => parseTzJournal(unsorted), /line 2.*strictly ordered/s);

  // A duplicate instant is also unsorted: two eras claiming one millisecond.
  const duplicate = [
    '{"from":"2026-08-25T18:00:00Z","tz":"America/Los_Angeles"}',
    '{"from":"2026-08-25T18:00:00Z","tz":"Europe/Stockholm"}',
  ].join("\n");
  assert.throws(() => parseTzJournal(duplicate), /strictly ordered/);
});

test("malformed journals throw rather than degrading to a partial read", () => {
  const cases: Array<[string, RegExp]> = [
    ['{"from":"2026-08-25T18:00:00Z"', /not valid JSON/],
    ['["2026-08-25T18:00:00Z","America/Los_Angeles"]', /expected a JSON object/],
    ['{"from":"2026-08-25T18:00:00Z","tz":"America/Los_Angeles","zone":"x"}', /unknown key\(s\) zone/],
    ['{"tz":"America/Los_Angeles"}', /must be a UTC instant/],
    ['{"from":"2026-08-25 18:00","tz":"America/Los_Angeles"}', /must be a UTC instant/],
    ['{"from":"not-a-date-at-allZ","tz":"America/Los_Angeles"}', /not a parseable instant/],
    ['{"from":"2026-08-25T18:00:00Z","tz":"America/Los_Angeles","note":7}', /"note" must be a string/],
  ];
  for (const [line, pattern] of cases) {
    assert.throws(() => parseTzJournal(line), pattern, line);
  }
  // Blank lines are not an error; a journal is appended to by hand sometimes.
  assert.equal(parseTzJournal('\n\n{"from":"2026-08-25T18:00:00Z","tz":"UTC"}\n\n').length, 1);
});

test("zone validation asks the runtime, and rejects fixed offsets by shape", () => {
  for (const zone of ["Etc/UTC", "UTC", "America/Los_Angeles", "Europe/Stockholm", "Asia/Kolkata", "Etc/GMT+5", "America/Argentina/Buenos_Aires"]) {
    assert.equal(isValidZoneName(zone), true, zone);
  }
  // Intl ACCEPTS "+05:00" — so shape has to reject it before Intl is asked.
  // A fixed offset is a fact about one instant and goes wrong at the next DST
  // transition; the journal stores names so the tz database answers instead.
  for (const zone of ["+05:00", "-07:00", "GMT+2", "UTC-3"]) {
    assert.equal(isValidZoneName(zone), false, zone);
  }
  for (const zone of ["Foo/Bar", "Mars/Olympus_Mons", "", "  ", 7, null, undefined]) {
    assert.equal(isValidZoneName(zone as any), false, String(zone));
  }
  // An invalid zone in a journal line is a parse failure, not a silent skip.
  assert.throws(
    () => parseTzJournal('{"from":"2026-08-25T18:00:00Z","tz":"+05:00"}'),
    /IANA zone name/,
  );
});

test("appendTzEntry refuses an out-of-order `from` and no-ops on an unchanged zone", () => {
  const entries = parseTzJournal(JOURNAL);

  assert.throws(
    () => appendTzEntry(entries, { from: "2026-08-01T00:00:00Z", tz: "Asia/Kolkata" }),
    /append-only and monotonic/,
  );
  assert.throws(
    () => appendTzEntry(entries, { from: "2026-09-02T22:00:00Z", tz: "Asia/Kolkata" }),
    /append-only and monotonic/,
  );
  assert.throws(
    () => appendTzEntry(entries, { from: "2026-10-01T00:00:00Z", tz: "+05:00" }),
    /IANA zone name/,
  );

  const same = appendTzEntry(entries, { from: "2026-10-01T00:00:00Z", tz: "Europe/Stockholm" });
  assert.equal(same.noop, true);
  assert.equal(same.line, null);
  assert.equal(same.entries.length, entries.length);

  const moved = appendTzEntry(entries, { from: "2026-10-01T00:00:00Z", tz: "Asia/Kolkata" });
  assert.equal(moved.noop, false);
  assert.equal(moved.line, '{"from":"2026-10-01T00:00:00Z","tz":"Asia/Kolkata"}');
  assert.equal(moved.entries.length, entries.length + 1);
  assert.equal(formatTzEntry({ from: "2026-10-01T00:00:00Z", tz: "UTC", note: "why" }),
    '{"from":"2026-10-01T00:00:00Z","tz":"UTC","note":"why"}');
});

test("the resolver re-reads a journal edited underneath a long-lived process", () => {
  // `const TZ = getTimezone()` at module load meant a daemon up for weeks never
  // observed a zone change at all. This is that bug's regression test.
  const home = fixture('{"from":"2026-07-17T00:00:00Z","tz":"Etc/UTC"}\n');
  try {
    const path = tzJournalPath(home);
    const resolve = createZoneResolver({ path, fallbackZone: () => "Asia/Kolkata" });
    const later = new Date("2026-08-26T00:00:00Z");
    assert.equal(resolve(later).tz, "Etc/UTC");

    writeFileSync(path, readFileSync(path, "utf8") + '{"from":"2026-08-25T18:00:00Z","tz":"America/Los_Angeles"}\n');
    assert.equal(resolve(later).tz, "America/Los_Angeles");
    // And a past instant still resolves to its own era.
    assert.equal(resolve(new Date("2026-08-01T00:00:00Z")).tz, "Etc/UTC");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the resolver reports a corrupt journal once and keeps forming memory", () => {
  const home = fixture("{ not json\n");
  try {
    const problems: string[] = [];
    const resolve = createZoneResolver({
      path: tzJournalPath(home),
      fallbackZone: () => "Asia/Kolkata",
      onError: (message) => problems.push(message),
    });
    // Labelled `system`, not silently presented as a journal answer.
    assert.deepEqual(resolve(new Date()), { tz: "Asia/Kolkata", source: "system" });
    resolve(new Date());
    resolve(new Date());
    assert.equal(problems.length, 1, "the same failure must not spam the log every episode");
    assert.match(problems[0], /tz journal unreadable/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("tz set seeds the pre-journal era from the earliest episode day", () => {
  const home = fixture();
  try {
    mkdirSync(join(home, "episodes", "2026-07-17"), { recursive: true });
    mkdirSync(join(home, "episodes", "2026-08-25"), { recursive: true });
    mkdirSync(join(home, "episodes", "not-a-date"), { recursive: true });
    assert.equal(firstEraStart(join(home, "episodes"), new Date("2026-08-25T19:00:00Z")), "2026-07-17T00:00:00Z");
    // Nothing to attribute: no seed, or the seed would collide with the move.
    assert.equal(firstEraStart(join(home, "no-such-dir"), new Date()), null);
    assert.equal(firstEraStart(join(home, "episodes"), new Date("2026-07-16T00:00:00Z")), null);

    const result = tzSet("America/Los_Angeles", {
      snorrioHome: home,
      now: new Date("2026-08-25T19:30:00Z"),
      systemZone: "Etc/UTC",
    });
    assert.equal(result.exitCode, 0);
    const lines = readFileSync(tzJournalPath(home), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const entries = readTzJournal(tzJournalPath(home));
    assert.equal(entries[0].tz, "Etc/UTC");
    assert.equal(entries[0].from, "2026-07-17T00:00:00Z");
    assert.equal(entries[1].tz, "America/Los_Angeles");
    // toISOString() keeps millis. The journal accepts any Z instant; the exact
    // shape is not load-bearing, the ordering is.
    assert.equal(entries[1].from, "2026-08-25T19:30:00.000Z");
    // Every episode already stamped tz Etc/UTC now sits inside an era saying so.
    assert.equal(zoneAt(entries, new Date("2026-08-25T18:15:00Z"))!.tz, "Etc/UTC");
    assert.match(result.output, /still Etc\/UTC/);

    // Re-running with the zone already in effect appends nothing.
    const again = tzSet("America/Los_Angeles", { snorrioHome: home, now: new Date("2026-08-25T20:00:00Z") });
    assert.equal(again.exitCode, 0);
    assert.equal(again.written.length, 0);
    assert.match(again.output, /already in effect/);
    assert.equal(readTzJournal(tzJournalPath(home)).length, 2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("tz set writes nothing when it cannot justify the write", () => {
  const home = fixture(JOURNAL);
  try {
    const written: string[] = [];
    const opts = { snorrioHome: home, appendLine: (_p: string, line: string) => { written.push(line); } };

    // A fixed offset.
    const offset = tzSet("+05:00", { ...opts, now: new Date("2026-10-01T00:00:00Z") });
    assert.equal(offset.exitCode, 2);
    assert.deepEqual(written, []);
    assert.match(offset.output, /not an IANA zone name/);

    // A zone the runtime does not know.
    const bogus = tzSet("Mars/Olympus_Mons", { ...opts, now: new Date("2026-10-01T00:00:00Z") });
    assert.equal(bogus.exitCode, 2);
    assert.deepEqual(written, []);

    // A `now` that precedes the head (clock skew, or a journal written ahead).
    const backwards = tzSet("Asia/Kolkata", { ...opts, now: new Date("2026-08-01T00:00:00Z") });
    assert.equal(backwards.exitCode, 2);
    assert.deepEqual(written, []);
    assert.match(backwards.output, /append-only and monotonic/);

    // Journal bytes untouched throughout.
    assert.equal(readFileSync(tzJournalPath(home), "utf8"), JOURNAL);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("tz set refuses to append to a journal it cannot read", () => {
  const home = fixture('{"from":"2026-08-25T18:00:00Z","tz":"America/Los_Angeles"}\ngarbage\n');
  try {
    const before = readFileSync(tzJournalPath(home), "utf8");
    const result = tzSet("Europe/Stockholm", { snorrioHome: home, now: new Date("2026-10-01T00:00:00Z") });
    assert.equal(result.exitCode, 2);
    assert.equal(result.written.length, 0);
    assert.match(result.output, /Refusing to append/);
    assert.equal(readFileSync(tzJournalPath(home), "utf8"), before);

    // `tz show` reports it too, rather than printing a confident wrong zone.
    const shown = tzShow({ snorrioHome: home, systemZone: "Etc/UTC" });
    assert.equal(shown.exitCode, 2);
    assert.match(shown.output, /invalid/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("tz show names the drift and the exact command to reconcile it", () => {
  const home = fixture(JOURNAL);
  try {
    const drifted = tzShow({ snorrioHome: home, systemZone: "America/Los_Angeles", now: new Date("2026-09-10T00:00:00Z") });
    assert.equal(drifted.exitCode, 0);
    assert.equal(drifted.written.length, 0);
    assert.match(drifted.output, /Effective: Europe\/Stockholm \(source: journal/);
    assert.match(drifted.output, /snorrio tz set America\/Los_Angeles/);
    assert.match(drifted.output, /not auto-followed/);

    const agreed = tzShow({ snorrioHome: home, systemZone: "Europe/Stockholm", now: new Date("2026-09-10T00:00:00Z") });
    assert.doesNotMatch(agreed.output, /Drift:/);

    const empty = tzShow({ snorrioHome: fixture(""), systemZone: "Etc/UTC" });
    assert.match(empty.output, /absent/);
    assert.match(empty.output, /snorrio tz set Etc\/UTC/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the setup check nudges on drift and never writes", () => {
  const home = fixture(JOURNAL);
  try {
    const path = tzJournalPath(home);
    const before = readFileSync(path, "utf8");

    const drift = checkTimezoneJournal(home, "America/Los_Angeles");
    assert.equal(drift.working, null);
    assert.match(drift.issue ?? "", /timezone drift/);
    assert.match(drift.issue ?? "", /snorrio tz set America\/Los_Angeles/);
    assert.match(drift.issue ?? "", /never follows the system zone/);

    const current = checkTimezoneJournal(home, "Europe/Stockholm");
    assert.equal(current.issue, null);
    assert.match(current.working ?? "", /timezone journal current \(Europe\/Stockholm/);

    // A journal that must not be auto-created, and one that must not be trusted.
    const missing = checkTimezoneJournal(fixture(), "Etc/UTC");
    assert.match(missing.issue ?? "", /no timezone journal yet/);
    assert.equal(existsSync(tzJournalPath(home)), true);
    const broken = checkTimezoneJournal(fixture("{oops\n"), "Etc/UTC");
    assert.match(broken.issue ?? "", /unreadable/);

    // Checking is a read. Nothing appended, nothing rewritten.
    assert.equal(readFileSync(path, "utf8"), before);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("two spellings of one zone are not drift", () => {
  // The tz database is full of links and Intl canonicalizes them: Etc/UTC → UTC,
  // US/Pacific → America/Los_Angeles, Asia/Kolkata → Asia/Calcutta. On this very
  // machine the journal's seeded era says Etc/UTC while the host reports UTC, so
  // a name comparison would have reported drift on day one and told the operator
  // to record a move that never happened.
  assert.equal(sameZone("Etc/UTC", "UTC"), true);
  assert.equal(sameZone("US/Pacific", "America/Los_Angeles"), true);
  assert.equal(sameZone("Asia/Kolkata", "Asia/Calcutta"), true);
  assert.equal(sameZone("Europe/Stockholm", "America/Los_Angeles"), false);
  assert.equal(sameZone("Etc/UTC", "Mars/Olympus_Mons"), false);

  const home = fixture('{"from":"2026-07-17T00:00:00Z","tz":"Etc/UTC"}\n');
  try {
    const check = checkTimezoneJournal(home, "UTC");
    assert.equal(check.issue, null, check.issue ?? "");
    assert.match(check.working ?? "", /timezone journal current/);

    // And `tz set` treats it as the no-op it is, rather than appending a
    // meaningless era boundary.
    const same = tzSet("UTC", { snorrioHome: home, now: new Date("2026-10-01T00:00:00Z"), systemZone: "UTC" });
    assert.equal(same.written.length, 0);
    assert.match(same.output, /already in effect/);
    assert.equal(readTzJournal(tzJournalPath(home)).length, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
