// Retrieval invariants for recall-engine.
//
// Targets the pure retrieval layer (loadEpisodes + temporal helpers)
// — no LLM calls, no network. The premise: if recall hands the wrong
// candidate set to the LLM, downstream prep is confidently wrong (this is
// the failure shape behind the "January meeting" hallucination from W15).
//
// We point SNORRIO_HOME at a fresh tmp dir, lay down a hand-picked corpus
// of episode markdown files, then assert what recall returns.
//
// HOME is also redirected so buildSessionIndex() doesn't walk the real
// ~/.pi/agent/sessions tree (slow, irrelevant, and would let real session
// filenames leak into sortKeys).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let TMP: string;
let loadEpisodes: (date: string) => Array<{ sessionId: string; sortKey: string; content: string }>;
let weekDates: (week: string) => string[];
let weekHasData: (week: string) => boolean;
let monthHasData: (month: string) => boolean;

const SAVED_ENV = { HOME: process.env.HOME, SNORRIO_HOME: process.env.SNORRIO_HOME };

function writeEpisode(date: string, sessionId: string, header: string | null, body = "body") {
  const dir = join(TMP, "snorrio", "episodes", date);
  mkdirSync(dir, { recursive: true });
  const content = header ? `${header}\n\n${body}` : body;
  writeFileSync(join(dir, `${sessionId}.md`), content);
}

function header(sessionId: string, date: string, start: string, end?: string) {
  const range = end ? `${start}→${end}` : start;
  return `<!-- session: ${sessionId} | ${date} ${range} | model:opus -->`;
}

before(() => {
  TMP = mkdtempSync(join(tmpdir(), "snorrio-recall-test-"));
  // Redirect both before importing recall-engine — SNORRIO_HOME is captured
  // at module load via ai.ts.
  process.env.SNORRIO_HOME = join(TMP, "snorrio");
  process.env.HOME = TMP; // fake HOME so buildSessionIndex finds nothing
  mkdirSync(join(TMP, "snorrio", "episodes"), { recursive: true });
});

after(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
  if (SAVED_ENV.HOME !== undefined) process.env.HOME = SAVED_ENV.HOME;
  if (SAVED_ENV.SNORRIO_HOME !== undefined) process.env.SNORRIO_HOME = SAVED_ENV.SNORRIO_HOME;
  else delete process.env.SNORRIO_HOME;
});

test("recall-engine retrieval invariants", async (t) => {
  // Dynamic import after env is set — top-level import would freeze the
  // production SNORRIO_HOME.
  const mod = await import("../src/recall-engine.ts");
  loadEpisodes = mod.loadEpisodes;
  weekDates = mod.weekDates;
  weekHasData = mod.weekHasData;
  monthHasData = mod.monthHasData;

  // --- Fixture corpus ---------------------------------------------------
  // Day A: three episodes with explicit headers, deliberately written in
  //        non-chronological filename order so we can prove the sort uses
  //        sortKey (header time), not readdir order.
  const A = "2026-03-05";
  writeEpisode(A, "zzz-late",   header("zzz-late",   A, "16:00", "16:30"));
  writeEpisode(A, "aaa-middle", header("aaa-middle", A, "12:00", "12:45"));
  writeEpisode(A, "mmm-early",  header("mmm-early",  A, "08:15", "09:00"));

  // Day B: one episode WITH header, one WITHOUT (no header → fallback to
  // `${dateStr} 00:00`), plus a non-markdown file that must be ignored.
  const B = "2026-03-06";
  writeEpisode(B, "with-header",    header("with-header", B, "14:00", "14:30"));
  writeEpisode(B, "no-header",      null, "raw body, no frontmatter at all");
  // Non-.md: must not appear in results.
  const bDir = join(TMP, "snorrio", "episodes", B);
  writeFileSync(join(bDir, "notes.txt"), "should be ignored");
  writeFileSync(join(bDir, "README"),    "also ignored");

  // Day C: empty directory (created but no files).
  const C = "2026-03-07";
  mkdirSync(join(TMP, "snorrio", "episodes", C), { recursive: true });

  // Day D: never created at all (tests truly-missing dir path).
  const D = "2026-03-08";

  // Day E: a different week entirely — guards against cross-day bleed.
  const E = "2026-04-01";
  writeEpisode(E, "april-only", header("april-only", E, "10:00"));

  // --- Invariant 1: date filtering -------------------------------------
  await t.test("date filter: only episodes from the requested day", () => {
    const a = loadEpisodes(A).map(e => e.sessionId).sort();
    assert.deepEqual(a, ["aaa-middle", "mmm-early", "zzz-late"]);

    const e = loadEpisodes(E).map(e => e.sessionId);
    assert.deepEqual(e, ["april-only"]);

    // No leakage between days.
    assert.ok(!a.includes("april-only"));
    assert.ok(!a.includes("with-header"));
  });

  await t.test("missing or empty day returns empty array", () => {
    assert.deepEqual(loadEpisodes(C), []);
    assert.deepEqual(loadEpisodes(D), []);
    assert.deepEqual(loadEpisodes("1999-01-01"), []);
  });

  // --- Invariant 2: ordering -------------------------------------------
  await t.test("ordering: ascending by header timestamp, not readdir", () => {
    const ids = loadEpisodes(A).map(e => e.sessionId);
    // mmm-early (08:15) → aaa-middle (12:00) → zzz-late (16:00)
    // If sort were by filename, it'd be [aaa, mmm, zzz].
    // If by readdir order it'd be unstable.
    assert.deepEqual(ids, ["mmm-early", "aaa-middle", "zzz-late"]);

    // sortKeys are also strictly ascending.
    const keys = loadEpisodes(A).map(e => e.sortKey);
    for (let i = 1; i < keys.length; i++) {
      assert.ok(keys[i - 1] < keys[i], `sortKey not ascending at ${i}: ${keys[i - 1]} >= ${keys[i]}`);
    }
  });

  // --- Invariant 3: non-.md and missing-header behavior ----------------
  await t.test("non-.md files are ignored; missing header falls back to 00:00", () => {
    const eps = loadEpisodes(B);
    const ids = eps.map(e => e.sessionId);
    // notes.txt / README must not appear.
    assert.deepEqual(ids.sort(), ["no-header", "with-header"]);

    const noHdr = eps.find(e => e.sessionId === "no-header")!;
    assert.equal(noHdr.sortKey, `${B} 00:00`,
      "episode without parseable header should fall back to start-of-day sortKey");

    const withHdr = eps.find(e => e.sessionId === "with-header")!;
    // NOTE: recall-engine's header regex captures the END time of the range
    // (`14:00→14:30` → "14:30"); single-time headers fall back to "00:00".
    // We pin to current behavior — see output report for the bug write-up.
    assert.equal(withHdr.sortKey, `${B} 14:30`);

    // Therefore no-header sorts before with-header.
    assert.deepEqual(ids, ["no-header", "with-header"]);
  });

  // --- Invariant 4: dedup within a day's result set --------------------
  await t.test("dedup: each sessionId appears at most once per day", () => {
    const eps = loadEpisodes(A);
    const ids = eps.map(e => e.sessionId);
    assert.equal(new Set(ids).size, ids.length, "duplicate sessionId in result set");
  });

  // --- Invariant 5: weekHasData / monthHasData integrate retrieval ----
  await t.test("weekHasData reflects underlying loadEpisodes", () => {
    // 2026-03-05 is a Thursday → ISO week 2026-W10.
    // weekDates should produce 7 dates including A.
    const w10 = weekDates("2026-W10");
    assert.equal(w10.length, 7);
    assert.ok(w10.includes(A), `expected ${A} in W10, got ${w10.join(",")}`);

    assert.equal(weekHasData("2026-W10"), true);
    // A week with no episodes anywhere in the corpus.
    assert.equal(weekHasData("2025-W01"), false);

    assert.equal(monthHasData("2026-03"), true);
    assert.equal(monthHasData("2025-12"), false);
  });
});
