// findStaleSessions — the disk-reconciliation primitive shared by sweep and
// flush. The flush path depends on this for correctness on fresh machines
// (2026-06-09 VM onboarding finding #2): when the watcher never installed,
// in-memory timers are empty and disk is the only truth.
//
// It is also the single place a system-timezone change used to become
// destructive: the episode path was rebuilt from a RECOMPUTED date, so moving
// the box east made hundreds of existing episodes look missing. Lookup is by
// session id now, and the last test here is the one that pins that.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { findStaleSessions, type StaleCheckSession } from "../src/stale-sessions.ts";

interface FixtureSession extends StaleCheckSession {
  date: string;
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "stale-sessions-"));
  const sessionsDir = join(root, "sessions");
  const episodesDir = join(root, "episodes");
  mkdirSync(sessionsDir, { recursive: true });

  const mk = (id: string, date: string, sessionAge: number, episodeAge: number | null): FixtureSession => {
    const path = join(sessionsDir, `${id}.jsonl`);
    writeFileSync(path, "{}\n");
    const now = Date.now() / 1000;
    utimesSync(path, now - sessionAge, now - sessionAge);
    if (episodeAge !== null) {
      const epDir = join(episodesDir, date);
      mkdirSync(epDir, { recursive: true });
      const epPath = join(epDir, `${id}.md`);
      writeFileSync(epPath, "episode\n");
      utimesSync(epPath, now - episodeAge, now - episodeAge);
    }
    return { id, path, date };
  };

  return { root, episodesDir, mk, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("no episode on disk → stale", () => {
  const f = makeFixture();
  try {
    const s = f.mk("aaaa1111", "2026-06-09", 60, null);
    const { stale, fresh } = findStaleSessions([s], f.episodesDir);
    assert.deepEqual(stale.map(x => x.id), ["aaaa1111"]);
    assert.equal(fresh, 0);
  } finally { f.cleanup(); }
});

test("episode older than session → stale (and logged)", () => {
  const f = makeFixture();
  try {
    const s = f.mk("bbbb2222", "2026-06-09", 10, 100); // session newer by 90s
    const logs: string[] = [];
    const { stale, fresh } = findStaleSessions([s], f.episodesDir, { log: (m: string) => logs.push(m) });
    assert.deepEqual(stale.map(x => x.id), ["bbbb2222"]);
    assert.equal(fresh, 0);
    assert.ok(logs.some(l => l.includes("Stale episode") && l.includes("bbbb2222")), `expected stale log, got: ${logs}`);
  } finally { f.cleanup(); }
});

test("episode newer than or equal to session → fresh", () => {
  const f = makeFixture();
  try {
    const newer = f.mk("cccc3333", "2026-06-09", 100, 10);
    const { stale, fresh } = findStaleSessions([newer], f.episodesDir);
    assert.equal(stale.length, 0);
    assert.equal(fresh, 1);
  } finally { f.cleanup(); }
});

test("mixed corpus partitions correctly and preserves order", () => {
  const f = makeFixture();
  try {
    const a = f.mk("dddd4444", "2026-06-08", 60, null);   // missing → stale
    const b = f.mk("eeee5555", "2026-06-09", 100, 10);    // fresh
    const c = f.mk("ffff6666", "2026-06-09", 10, 100);    // outdated → stale
    const { stale, fresh } = findStaleSessions([a, b, c], f.episodesDir);
    assert.deepEqual(stale.map(x => x.id), ["dddd4444", "ffff6666"]);
    assert.equal(fresh, 1);
  } finally { f.cleanup(); }
});

test("episode dir for the date missing entirely → stale, no throw", () => {
  const f = makeFixture();
  try {
    const s = f.mk("abab7777", "2026-01-01", 60, null); // episodesDir/2026-01-01 never created
    const { stale } = findStaleSessions([s], f.episodesDir);
    assert.equal(stale.length, 1);
  } finally { f.cleanup(); }
});

test("a changed date function does NOT orphan an existing episode", () => {
  // The regression this whole change exists to prevent. An episode sits in
  // 2026-06-09 because that was the local date when it was written. The box then
  // moves east and the same instant now resolves to 2026-06-10. Lookup must
  // still find the episode: keyed on the session id, the date is irrelevant.
  const f = makeFixture();
  try {
    const s = f.mk("cafe8888", "2026-06-09", 100, 10); // fresh where it actually lives

    // Simulate every plausible post-change date, including the shifted one.
    for (const shifted of ["2026-06-10", "2026-06-08", "2026-12-31"]) {
      const moved: FixtureSession = { ...s, date: shifted };
      const { stale, fresh } = findStaleSessions([moved], f.episodesDir);
      assert.equal(fresh, 1, `session must stay fresh when its date recomputes to ${shifted}`);
      assert.equal(stale.length, 0, `session must not be regenerated for ${shifted}`);
    }

    // And nothing was written into a new day directory.
    assert.deepEqual(readdirSync(f.episodesDir), ["2026-06-09"]);
  } finally { f.cleanup(); }
});

test("session id is read from frontmatter, not the filename", () => {
  // Episode files are named by session id today, but the index prefers the
  // frontmatter session_id. A renamed file must still be found.
  const f = makeFixture();
  try {
    const s = f.mk("dead9999", "2026-06-09", 100, 10);
    const epDir = join(f.episodesDir, "2026-06-09");
    rmSync(join(epDir, "dead9999.md"));
    const renamed = join(epDir, "some-other-name.md");
    writeFileSync(renamed, ['---', 'session_id: "dead9999"', '---', '', 'body'].join("\n"));
    const now = Date.now() / 1000;
    utimesSync(renamed, now - 10, now - 10);

    const { stale, fresh } = findStaleSessions([s], f.episodesDir);
    assert.equal(fresh, 1);
    assert.equal(stale.length, 0);
  } finally { f.cleanup(); }
});

test("a session with episodes under two dates is fresh if the newest is current", () => {
  // 32 session ids in the live store appear under two or three day directories
  // (sessions that spanned midnight and were regenerated on a later day). The
  // newest recorded episode decides freshness; regenerating would only add a
  // third copy for the caches to double-count.
  const f = makeFixture();
  try {
    const s = f.mk("beef0000", "2026-06-09", 100, 500); // old episode, stale on its own
    const laterDir = join(f.episodesDir, "2026-06-10");
    mkdirSync(laterDir, { recursive: true });
    const later = join(laterDir, "beef0000.md");
    writeFileSync(later, "episode\n");
    const now = Date.now() / 1000;
    utimesSync(later, now - 10, now - 10); // newer than the session

    const { stale, fresh } = findStaleSessions([s], f.episodesDir);
    assert.equal(fresh, 1);
    assert.equal(stale.length, 0);
  } finally { f.cleanup(); }
});
