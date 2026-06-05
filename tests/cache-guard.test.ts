// Cache-poisoning guard for sub-summary writes.
//
// Bug (found by a redteam pass 2026-06-05): the top-level quarter/year cache
// writes skip persisting an error/sentinel result (anything that
// `startsWith("[recall:")`), but the day/week/month SUB-summary writes inside
// recallWeek/recallMonth/recallQuarter lacked that guard. A provider error
// (e.g. a 429 during a non-streamed sub-summary completion) could therefore
// write `[recall: API error — …]` into the cache, poisoning it — later recalls
// would read the cached error as if it were real content.
//
// This test drives a real `recall(month)` over a tmp SNORRIO_HOME corpus and
// stubs the non-streamed LLM boundary (`complete`) so we can deterministically
// simulate (a) an error sentinel and (b) a clean summary — no network. When
// recall(quarter) is called WITHOUT onChunk, every tier routes through
// apiCall → complete, so one call exercises all three sub-summary writes:
// the day write lives in recallWeek, the week write in recallMonth, and the
// month write in recallQuarter.
//
// HOME is redirected so buildSessionIndex() doesn't walk the real
// ~/.pi/agent/sessions tree.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let TMP: string;
let CACHE: string;
let recall: (ref: string, question: string, modelSpec?: string | null, options?: any) => Promise<unknown>;
let setCompleteForTest: (fn: ((...args: any[]) => any) | null) => void;

const SAVED_ENV = { HOME: process.env.HOME, SNORRIO_HOME: process.env.SNORRIO_HOME };

// Day that has data: 2026-03-05 is a Thursday → ISO week 2026-W10,
// month 2026-03, quarter 2026-Q1.
const DAY = "2026-03-05";
const WEEK = "2026-W10";
const MONTH = "2026-03";
const QUARTER = "2026-Q1";

function writeEpisode(date: string, sessionId: string) {
  const dir = join(TMP, "snorrio", "episodes", date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sessionId}.md`),
    `<!-- session: ${sessionId} | ${date} 09:00→09:30 | model:opus -->\n\nsome work happened`,
  );
}

const dayCache = () => join(CACHE, "days", `${DAY}.md`);
const weekCache = () => join(CACHE, "weeks", `${WEEK}.md`);
const monthCache = () => join(CACHE, "months", `${MONTH}.md`);

before(() => {
  TMP = mkdtempSync(join(tmpdir(), "snorrio-cache-guard-test-"));
  // Must set env BEFORE importing recall-engine: SNORRIO_HOME / CACHE_DIR are
  // captured at module load.
  process.env.SNORRIO_HOME = join(TMP, "snorrio");
  process.env.HOME = TMP;
  CACHE = join(TMP, "snorrio", "cache");
  mkdirSync(join(TMP, "snorrio", "episodes"), { recursive: true });
});

after(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
  if (SAVED_ENV.HOME !== undefined) process.env.HOME = SAVED_ENV.HOME;
  if (SAVED_ENV.SNORRIO_HOME !== undefined) process.env.SNORRIO_HOME = SAVED_ENV.SNORRIO_HOME;
  else delete process.env.SNORRIO_HOME;
});

test("sub-summary cache writes are guarded against error sentinels", async (t) => {
  const mod = await import("../src/recall-engine.ts");
  recall = mod.recall;
  setCompleteForTest = mod.__setCompleteForTest;

  writeEpisode(DAY, "sess-a");

  // --- Error sentinel: nothing must be cached at any tier ---------------
  await t.test("an error sentinel result is NOT persisted at day/week/month", async () => {
    // Simulate a provider error (e.g. 429/overloaded) on every non-streamed
    // completion. apiCall turns stopReason:"error" into `[recall: API error …]`.
    setCompleteForTest(async () => ({
      stopReason: "error",
      errorMessage: '{"message":"overloaded"}',
      content: [],
    }));

    const result = await recall(QUARTER, "what happened?", null);

    // The recall itself surfaces the error sentinel...
    assert.equal(typeof result, "string");
    assert.ok((result as string).startsWith("[recall:"), `expected sentinel, got: ${result}`);

    // ...but NONE of it leaked into any cache file. This is the assertion that
    // fails on the pre-fix code (the day/week/month writes were unguarded).
    assert.ok(!existsSync(dayCache()), "day cache must not be written for an error sentinel");
    assert.ok(!existsSync(weekCache()), "week cache must not be written for an error sentinel");
    assert.ok(!existsSync(monthCache()), "month cache must not be written for an error sentinel");
  });

  // --- Clean result: the success path is unchanged ----------------------
  await t.test("a clean summary result IS persisted at day/week/month", async () => {
    // Each tier produces distinct text; getText() joins the text blocks.
    setCompleteForTest(async () => ({
      stopReason: "end",
      content: [{ type: "text", text: "CLEAN SUMMARY" }],
    }));

    const result = await recall(QUARTER, "what happened?", null);
    assert.ok(!(result as string).startsWith("[recall:"), `expected clean result, got: ${result}`);

    assert.ok(existsSync(dayCache()), "day cache should be written for a clean result");
    assert.ok(existsSync(weekCache()), "week cache should be written for a clean result");
    assert.ok(existsSync(monthCache()), "month cache should be written for a clean result");

    // And the cached content is the clean summary, not a sentinel.
    for (const p of [dayCache(), weekCache(), monthCache()]) {
      const cached = readFileSync(p, "utf8");
      assert.ok(!cached.startsWith("[recall:"), `cache at ${p} holds a sentinel: ${cached}`);
    }
  });

  setCompleteForTest(null); // restore real boundary
});
