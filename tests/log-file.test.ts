// The daily log filename: bucketed by local date, and by ONE function.
//
// The bug these guard: both the daemon and `snorrio flush` named the per-day log
// file `new Date().toISOString().slice(0, 10)`. After this box moved to Pacific,
// every line logged from 17:00 PDT onward went into a file named for tomorrow.
//
// The coupling matters more than the name. `flush` tails the file the daemon
// appends to, so if the two derive it differently the symptom is not a
// misnamed file — it is a hang, with the spinner watching a file nothing writes
// until the 5-minute timeout. So there is a behavioural test for the boundary
// and a structural one asserting nobody grows a second way to build the name.
//
// src/episode-daemon.ts cannot be imported here: it calls main() at module load
// and would start a real watcher. The coupling test is therefore over the source
// text, which is also the form that catches a NEW call site rather than only a
// changed one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dailyLogPath, logsDir } from "../src/log-file.ts";
import { createZoneResolver, tzJournalPath } from "../src/tz-journal.ts";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The live journal's shape: UTC until the Pacific move on 2026-08-25.
const JOURNAL = [
  '{"from":"2026-07-17T00:00:00Z","tz":"Etc/UTC","note":"vdesk default"}',
  '{"from":"2026-08-25T19:51:53.756Z","tz":"America/Los_Angeles"}',
  '{"from":"2026-09-02T22:00:00Z","tz":"Europe/Stockholm"}',
].join("\n") + "\n";

function fixture(): { home: string; resolve: ReturnType<typeof createZoneResolver> } {
  const home = mkdtempSync(join(tmpdir(), "snorrio-log-"));
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(tzJournalPath(home), JOURNAL);
  return {
    home,
    resolve: createZoneResolver({ path: tzJournalPath(home), fallbackZone: () => "UTC" }),
  };
}

test("a Pacific evening logs to today's file, not tomorrow's", () => {
  // 2026-08-26T04:00:00Z is 21:00 PDT on 08-25 — the exact bug. A UTC-derived
  // name put this line in 2026-08-26.log, a file for a day that had not started.
  const { home, resolve } = fixture();
  assert.equal(
    dailyLogPath(home, new Date("2026-08-26T04:00:00Z"), resolve),
    join(logsDir(home), "2026-08-25.log"),
  );
});

test("the file rolls at local midnight, not at 00:00Z", () => {
  const { home, resolve } = fixture();
  const nameAt = (iso: string) => dailyLogPath(home, new Date(iso), resolve).split("/").pop();

  // 16:59 PDT and 17:01 PDT straddle 00:00Z and must share a file.
  assert.equal(nameAt("2026-08-25T23:59:00Z"), "2026-08-25.log");
  assert.equal(nameAt("2026-08-26T00:01:00Z"), "2026-08-25.log");
  // 23:59 PDT → 00:01 PDT is where the roll belongs.
  assert.equal(nameAt("2026-08-26T06:59:00Z"), "2026-08-25.log");
  assert.equal(nameAt("2026-08-26T07:01:00Z"), "2026-08-26.log");
});

test("the log file follows the zone in effect AT the instant, not today's", () => {
  // A sweep replaying old work must not file July's lines under today's zone. In
  // the UTC era 23:00Z was still the 20th; after the Stockholm move the same
  // clock time is the next day.
  const { home, resolve } = fixture();
  const nameAt = (iso: string) => dailyLogPath(home, new Date(iso), resolve).split("/").pop();

  assert.equal(nameAt("2026-07-20T23:00:00Z"), "2026-07-20.log");   // Etc/UTC era
  assert.equal(nameAt("2026-09-10T23:00:00Z"), "2026-09-11.log");   // CEST, +02:00
});

test("no journal at all falls back to the caller's zone, and still resolves", () => {
  // A fresh install has no journal. It must name a file rather than throw — the
  // logger is the thing that would have reported the problem.
  const home = mkdtempSync(join(tmpdir(), "snorrio-log-bare-"));
  const resolve = createZoneResolver({
    path: tzJournalPath(home),
    fallbackZone: () => "Asia/Kolkata",
  });
  // 19:00Z is 00:30 IST the next day.
  assert.equal(
    dailyLogPath(home, new Date("2026-08-25T19:00:00Z"), resolve),
    join(logsDir(home), "2026-08-26.log"),
  );
});

test("a corrupt journal logs its own warning without recursing", () => {
  // New hazard introduced by resolving the log filename per instant: the daemon's
  // log() now asks the resolver, and the resolver's onError reports THROUGH log().
  // That is a cycle, and it is bounded only because createZoneResolver records the
  // journal signature and the reported message BEFORE calling out — so the
  // re-entrant resolve short-circuits instead of erroring again.
  const home = mkdtempSync(join(tmpdir(), "snorrio-log-bad-"));
  mkdirSync(join(home, "config"), { recursive: true });
  mkdirSync(logsDir(home), { recursive: true });
  writeFileSync(tzJournalPath(home), "{ not json\n");

  let depth = 0, maxDepth = 0, errors = 0;
  let resolve: ReturnType<typeof createZoneResolver>;
  const log = (msg: string) => {
    depth++;
    maxDepth = Math.max(maxDepth, depth);
    try {
      appendFileSync(dailyLogPath(home, new Date(), resolve), `[DMN] ${msg}\n`);
    } finally { depth--; }
  };
  resolve = createZoneResolver({
    path: tzJournalPath(home),
    fallbackZone: () => "America/Los_Angeles",
    onError: (message) => { errors++; log(`WARNING: ${message}`); },
  });

  log("DMN starting");
  log("Ready");

  assert.equal(maxDepth, 2, "log() -> resolver -> onError -> log() must not nest further");
  assert.equal(errors, 1, "one report per distinct failure, not one per line logged");
  // And it still logged: a bad journal must not cost the daemon its log file.
  assert.deepEqual(readdirSync(logsDir(home)).length, 1);
  const written = readFileSync(dailyLogPath(home, new Date(), resolve), "utf8");
  assert.match(written, /WARNING: tz journal unreadable/);
  assert.match(written, /DMN starting/);
});

test("the daemon and `snorrio flush` name the log file through the same function", () => {
  // This is the coupling that rots: `flush` tails what the daemon writes. Both
  // must call dailyLogPath() and neither may build a `.log` name itself.
  const strip = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  for (const rel of ["src/episode-daemon.ts", "bin/snorrio"]) {
    const src = strip(readFileSync(join(PKG_ROOT, rel), "utf8"));
    assert.match(src, /dailyLogPath\(/, `${rel} must derive its log filename via dailyLogPath()`);
    assert.doesNotMatch(
      src,
      /`[^`]*\.log`/,
      `${rel} builds a .log filename itself — that is the second code path this fix removed. ` +
      `Route it through dailyLogPath() in src/log-file.ts instead.`,
    );
  }
});

test("the CLI never asks a UTC date which day it is", () => {
  // `new Date().toISOString().slice(0, 10)` is the shape of this whole family of
  // bugs: it answers "what day is it in UTC", which is nobody's question. It cost
  // bin/snorrio two of them — the log file `flush` tails, and the episode
  // directory `status` counts today from. Neither may come back.
  //
  // Scoped to bin/snorrio because the remaining uses elsewhere are legitimate:
  // src/local-date.ts and src/date-ranges.ts read the slice off a date built with
  // Date.UTC() as pure calendar arithmetic, never off `new Date()`.
  const src = readFileSync(join(PKG_ROOT, "bin/snorrio"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(
    src,
    /toISOString\(\)\.slice\(0,\s*10\)/,
    "bin/snorrio buckets by a UTC date. Resolve it through the journal instead " +
    "(resolveZoneFor + resolveLocalDate, or dailyLogPath for a log file).",
  );
});
