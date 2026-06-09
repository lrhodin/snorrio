// findStaleSessions — the disk-reconciliation primitive shared by sweep and
// flush. The flush path depends on this for correctness on fresh machines
// (2026-06-09 VM onboarding finding #2): when the watcher never installed,
// in-memory timers are empty and disk is the only truth.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "fs";
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

const dateOf = (s: FixtureSession) => s.date;

test("no episode on disk → stale", () => {
  const f = makeFixture();
  try {
    const s = f.mk("aaaa1111", "2026-06-09", 60, null);
    const { stale, fresh } = findStaleSessions([s], f.episodesDir, dateOf);
    assert.deepEqual(stale.map(x => x.id), ["aaaa1111"]);
    assert.equal(fresh, 0);
  } finally { f.cleanup(); }
});

test("episode older than session → stale (and logged)", () => {
  const f = makeFixture();
  try {
    const s = f.mk("bbbb2222", "2026-06-09", 10, 100); // session newer by 90s
    const logs: string[] = [];
    const { stale, fresh } = findStaleSessions([s], f.episodesDir, dateOf, m => logs.push(m));
    assert.deepEqual(stale.map(x => x.id), ["bbbb2222"]);
    assert.equal(fresh, 0);
    assert.ok(logs.some(l => l.includes("Stale episode") && l.includes("bbbb2222")), `expected stale log, got: ${logs}`);
  } finally { f.cleanup(); }
});

test("episode newer than or equal to session → fresh", () => {
  const f = makeFixture();
  try {
    const newer = f.mk("cccc3333", "2026-06-09", 100, 10);
    const { stale, fresh } = findStaleSessions([newer], f.episodesDir, dateOf);
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
    const { stale, fresh } = findStaleSessions([a, b, c], f.episodesDir, dateOf);
    assert.deepEqual(stale.map(x => x.id), ["dddd4444", "ffff6666"]);
    assert.equal(fresh, 1);
  } finally { f.cleanup(); }
});

test("episode dir for the date missing entirely → stale, no throw", () => {
  const f = makeFixture();
  try {
    const s = f.mk("abab7777", "2026-01-01", 60, null); // episodesDir/2026-01-01 never created
    const { stale } = findStaleSessions([s], f.episodesDir, dateOf);
    assert.equal(stale.length, 1);
  } finally { f.cleanup(); }
});
