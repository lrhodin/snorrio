// The local_date backfill, and the shared episode index it runs on.
//
// The contract: metadata only. No episode moves, no prose byte changes, and each
// episode is stamped with the day directory it ALREADY sits in — history is
// frozen as it stands rather than re-derived from a timestamp that would move
// with the machine's zone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildEpisodeIndex } from "../src/episode-index.ts";
import { parseEpisodeFrontmatter } from "../src/episode-frontmatter.ts";
import { auditEpisodeLocalDates, migrateEpisodeLocalDates } from "../src/local-date-migration.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "snorrio-local-date-"));
  const episodesDir = join(root, "episodes");
  const write = (date: string, id: string, content: string) => {
    mkdirSync(join(episodesDir, date), { recursive: true });
    writeFileSync(join(episodesDir, date, `${id}.md`), content);
  };
  return { root, episodesDir, write, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function episode(id: string, extra: string[] = [], prose = "\nProse body.\n"): string {
  return ["---", 'origin: "pi"', `session_id: ${JSON.stringify(id)}`, 'timestamp: "2026-08-25T02:00:00.000Z"', ...extra, "---", prose].join("\n");
}

const hashProse = (content: string) => createHash("sha256").update(parseEpisodeFrontmatter(content).prose).digest("hex");

test("stamps every episode with its own directory, not a recomputed date", () => {
  const f = fixture();
  try {
    // The timestamps all say 2026-08-25T02:00Z, which resolves to a DIFFERENT
    // date in several zones. The stamp must follow the directory regardless.
    f.write("2026-08-24", "a", episode("a"));
    f.write("2026-08-25", "b", episode("b"));
    f.write("2026-07-30", "c", episode("c"));

    const result = migrateEpisodeLocalDates({ episodesDir: f.episodesDir });
    assert.equal(result.episodesScanned, 3);
    assert.equal(result.episodesChanged, 3);
    assert.deepEqual(result.skipped, []);

    for (const [date, id] of [["2026-08-24", "a"], ["2026-08-25", "b"], ["2026-07-30", "c"]] as const) {
      const fields = parseEpisodeFrontmatter(readFileSync(join(f.episodesDir, date, `${id}.md`), "utf8")).fields;
      assert.equal(fields.get("local_date"), JSON.stringify(date), `${id} must be bucketed to ${date}`);
      assert.equal(fields.get("tz"), '"Etc/UTC"');
      assert.equal(fields.get("utc_offset"), '"+00:00"');
      // "assumed", not "system": the era is reconstructed, not observed.
      assert.equal(fields.get("tz_source"), '"assumed"');
    }

    const audit = auditEpisodeLocalDates({ episodesDir: f.episodesDir });
    assert.equal(audit.episodes, 3);
    assert.equal(audit.stamped, 3);
    assert.deepEqual(audit.mismatched, []);
  } finally { f.cleanup(); }
});

test("prose bytes are preserved exactly, including delimiters and trailing whitespace", () => {
  const f = fixture();
  try {
    const nasty = "\nBody with a --- rule.\n\n---\n\nAnd a second one.\n\ttab\ttab\n   trailing spaces   \n\n\n";
    f.write("2026-08-24", "a", episode("a", [], nasty));
    const before = readFileSync(join(f.episodesDir, "2026-08-24", "a.md"), "utf8");
    const beforeHash = hashProse(before);

    migrateEpisodeLocalDates({ episodesDir: f.episodesDir });

    const after = readFileSync(join(f.episodesDir, "2026-08-24", "a.md"), "utf8");
    assert.equal(hashProse(after), beforeHash, "prose hash must be unchanged");
    assert.equal(parseEpisodeFrontmatter(after).prose, parseEpisodeFrontmatter(before).prose);
    assert.notEqual(after, before, "frontmatter should have changed");
  } finally { f.cleanup(); }
});

test("dry run writes nothing but reports the same counts", () => {
  const f = fixture();
  try {
    f.write("2026-08-24", "a", episode("a"));
    f.write("2026-08-25", "b", episode("b"));
    const before = new Map(
      buildEpisodeIndex(f.episodesDir).episodes.map((r) => [r.path, r.content]),
    );

    const dry = migrateEpisodeLocalDates({ episodesDir: f.episodesDir, dryRun: true });
    assert.equal(dry.episodesChanged, 2);
    for (const [path, content] of before) {
      assert.equal(readFileSync(path, "utf8"), content, `${path} must be untouched by a dry run`);
    }
    // No local_date anywhere yet.
    assert.equal(auditEpisodeLocalDates({ episodesDir: f.episodesDir }).stamped, 0);
  } finally { f.cleanup(); }
});

test("running twice is a byte-level no-op", () => {
  const f = fixture();
  try {
    f.write("2026-08-24", "a", episode("a"));
    f.write("2026-08-25", "b", episode("b", ['machine: "m"']));

    migrateEpisodeLocalDates({ episodesDir: f.episodesDir });
    const afterFirst = new Map(
      buildEpisodeIndex(f.episodesDir).episodes.map((r) => [r.path, r.content]),
    );

    const second = migrateEpisodeLocalDates({ episodesDir: f.episodesDir });
    assert.equal(second.episodesChanged, 0, "second run must change nothing");
    assert.equal(second.episodesAlreadyStamped, 2);
    for (const [path, content] of afterFirst) {
      assert.equal(readFileSync(path, "utf8"), content, `${path} must be byte-identical`);
    }
  } finally { f.cleanup(); }
});

test("no episode is moved, created or deleted", () => {
  const f = fixture();
  try {
    f.write("2026-08-24", "a", episode("a"));
    f.write("2026-08-25", "b", episode("b"));
    const layout = () => readdirSync(f.episodesDir).sort().map((d) => `${d}/${readdirSync(join(f.episodesDir, d)).sort().join(",")}`);
    const before = layout();
    migrateEpisodeLocalDates({ episodesDir: f.episodesDir });
    assert.deepEqual(layout(), before);
  } finally { f.cleanup(); }
});

test("an episode without frontmatter is reported as skipped, never silently dropped", () => {
  const f = fixture();
  try {
    f.write("2026-08-24", "good", episode("good"));
    f.write("2026-08-24", "bare", "no frontmatter at all\n");

    const result = migrateEpisodeLocalDates({ episodesDir: f.episodesDir });
    assert.equal(result.episodesScanned, 2);
    assert.equal(result.episodesChanged, 1);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].path, /bare\.md$/);
    // The unstampable file is left exactly as it was.
    assert.equal(readFileSync(join(f.episodesDir, "2026-08-24", "bare.md"), "utf8"), "no frontmatter at all\n");
  } finally { f.cleanup(); }
});

test("an existing wrong local_date is corrected to the directory", () => {
  const f = fixture();
  try {
    // What a timezone change would have written: a stamp disagreeing with where
    // the file actually lives.
    f.write("2026-08-24", "a", episode("a", ['local_date: "2026-08-25"', 'tz: "Asia/Kolkata"', 'utc_offset: "+05:30"', 'tz_source: "system"']));
    assert.equal(auditEpisodeLocalDates({ episodesDir: f.episodesDir }).mismatched.length, 1);

    migrateEpisodeLocalDates({ episodesDir: f.episodesDir });
    const audit = auditEpisodeLocalDates({ episodesDir: f.episodesDir });
    assert.deepEqual(audit.mismatched, []);
    assert.equal(audit.stamped, 1);
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------
// The shared index
// ---------------------------------------------------------------------------

test("buildEpisodeIndex keys on frontmatter session_id and keeps every copy", () => {
  const f = fixture();
  try {
    f.write("2026-08-24", "spanning", episode("spanning"));
    f.write("2026-08-25", "spanning", episode("spanning")); // same session, two days
    f.write("2026-08-25", "renamed-file", episode("real-id"));

    const index = buildEpisodeIndex(f.episodesDir);
    assert.equal(index.episodes.length, 3);
    assert.deepEqual(index.dates, ["2026-08-24", "2026-08-25"]);
    // Both copies retained — collapsing them would hide the duplication.
    assert.deepEqual(index.bySession.get("spanning")!.map((r) => r.date), ["2026-08-24", "2026-08-25"]);
    // Frontmatter id wins over the filename.
    assert.equal(index.bySession.get("real-id")!.length, 1);
    assert.equal(index.bySession.get("renamed-file"), undefined);
  } finally { f.cleanup(); }
});

test("buildEpisodeIndex ignores non-date dirs, non-md files and a missing tree", () => {
  const f = fixture();
  try {
    f.write("2026-08-24", "a", episode("a"));
    mkdirSync(join(f.episodesDir, "not-a-date"), { recursive: true });
    writeFileSync(join(f.episodesDir, "not-a-date", "x.md"), episode("x"));
    writeFileSync(join(f.episodesDir, "2026-08-24", "notes.txt"), "ignored");

    const index = buildEpisodeIndex(f.episodesDir);
    assert.equal(index.episodes.length, 1);
    assert.deepEqual(index.dates, ["2026-08-24"]);

    const empty = buildEpisodeIndex(join(f.root, "does-not-exist"));
    assert.deepEqual(empty.episodes, []);
    assert.deepEqual(empty.dates, []);
  } finally { f.cleanup(); }
});

test("falls back to the filename when frontmatter carries no session_id", () => {
  const f = fixture();
  try {
    f.write("2026-08-24", "from-filename", ["---", 'origin: "pi"', "---", "", "body"].join("\n"));
    const index = buildEpisodeIndex(f.episodesDir);
    assert.equal(index.bySession.get("from-filename")!.length, 1);
  } finally { f.cleanup(); }
});
