// recall --at wiring (Phase 0) — cache reads go through the versioned data
// repo when `at` is set.
//
// Fixture (mirrors cache-guard.test.ts setup): a tmp SNORRIO_HOME with live
// episodes, plus a git history where the day cache for 2026-03-05 was V1 at
// T1 and was overwritten to V2 at T2. A second day (2026-03-06) has live
// episodes and a LIVE day cache but no cache at T1.
//
// Contracts:
//   - recall(week, {at: between T1 and T2}) builds its context from V1 (git),
//     while a live recall(week) builds it from V2 (filesystem).
//   - a day whose cache didn't exist at the resolved commit is SKIPPED — it
//     is never regenerated from live data in --at mode.
//   - --at mode performs NO cache writes (poison-guard: the historical view
//     must never leak into live caches).
//   - at before the first commit → clear "[recall: no commit …]" sentinel.
//   - --at on a day/session ref → clear unsupported sentinel.
//
// The LLM boundary is stubbed via __setCompleteForTest (no network); the
// stub captures the user message so we can assert which cache content was
// injected. HOME is redirected so buildSessionIndex() doesn't walk the real
// ~/.pi/agent/sessions tree.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

let TMP: string;
let HOME_DIR: string;
let CACHE: string;

const SAVED_ENV = { HOME: process.env.HOME, SNORRIO_HOME: process.env.SNORRIO_HOME };

// 2026-03-05 (Thu) and 2026-03-06 (Fri) are both in ISO week 2026-W10.
const DAY1 = "2026-03-05";
const DAY2 = "2026-03-06";
const WEEK = "2026-W10";

const T1 = "2026-03-06T08:00:00Z";   // V1 committed
const T2 = "2026-03-20T00:00:00Z";   // V2 committed
const BETWEEN = "2026-03-10T00:00:00Z";
const BEFORE_ALL = "2026-01-01T00:00:00Z";

let recall: (ref: string, question: string, modelSpec?: string | null, options?: any) => Promise<unknown>;
let setCompleteForTest: (fn: ((...args: any[]) => any) | null) => void;

function git(args: string[], when?: string): string {
  return execFileSync("git", ["-C", HOME_DIR, ...args], {
    encoding: "utf8",
    env: when
      ? { ...process.env, GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when }
      : process.env,
  });
}

function writeEpisode(date: string, sessionId: string) {
  const dir = join(HOME_DIR, "episodes", date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sessionId}.md`),
    `<!-- session: ${sessionId} | ${date} 09:00→09:30 | model:opus -->\n\nsome work happened`,
  );
}

function snapshotCacheTree(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  })(CACHE);
  return out.sort();
}

before(async () => {
  TMP = mkdtempSync(join(tmpdir(), "snorrio-recall-at-test-"));
  HOME_DIR = join(TMP, "snorrio");
  // Must set env BEFORE importing recall-engine: SNORRIO_HOME / CACHE_DIR are
  // captured at module load.
  process.env.SNORRIO_HOME = HOME_DIR;
  process.env.HOME = TMP;
  CACHE = join(HOME_DIR, "cache");

  // Live episodes for both days (the week loop gates on live episodes).
  writeEpisode(DAY1, "sess-a");
  writeEpisode(DAY2, "sess-b");

  // Git history: V1 day cache for DAY1 at T1 (DAY2 has no cache yet)…
  git(["init"]);
  git(["config", "user.name", "snorrio"]);
  git(["config", "user.email", "dmn@snorr.io"]);
  git(["config", "commit.gpgsign", "false"]);
  mkdirSync(join(CACHE, "days"), { recursive: true });
  writeFileSync(join(CACHE, "days", `${DAY1}.md`), "V1-THURSDAY-SUMMARY written the same week");
  git(["add", "-A"]);
  git(["commit", "-m", `cascade ${DAY1}: episode sess-a → day/week/month/quarter/year`], T1);

  // …then hindsight strikes: both day caches regenerated at T2.
  writeFileSync(join(CACHE, "days", `${DAY1}.md`), "V2-THURSDAY-SUMMARY rewritten with hindsight");
  writeFileSync(join(CACHE, "days", `${DAY2}.md`), "V2-FRIDAY-SUMMARY only exists in the live tree");
  git(["add", "-A"]);
  git(["commit", "-m", `cascade ${DAY1},${DAY2}: regen`], T2);

  const mod = await import("../src/recall-engine.ts");
  recall = mod.recall;
  setCompleteForTest = mod.__setCompleteForTest;
});

after(() => {
  setCompleteForTest?.(null);
  if (TMP) rmSync(TMP, { recursive: true, force: true });
  if (SAVED_ENV.HOME !== undefined) process.env.HOME = SAVED_ENV.HOME;
  if (SAVED_ENV.SNORRIO_HOME !== undefined) process.env.SNORRIO_HOME = SAVED_ENV.SNORRIO_HOME;
  else delete process.env.SNORRIO_HOME;
});

test("recall --at reads caches via git; live recall reads the filesystem", async (t) => {
  let captured: string | null = null;
  setCompleteForTest(async (messages: any[]) => {
    captured = messages.map(m => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
    return { stopReason: "end", content: [{ type: "text", text: "STUBBED ANSWER" }] };
  });

  await t.test("--at between T1 and T2 → context is V1; missing-at-T day is skipped, not regenerated", async () => {
    const treeBefore = snapshotCacheTree();

    captured = null;
    const result = await recall(WEEK, "what happened?", null, { at: BETWEEN });
    assert.equal(result, "STUBBED ANSWER");
    assert.ok(captured, "stub must have been called");
    assert.match(captured!, /V1-THURSDAY-SUMMARY/, "historical view must come from git");
    assert.doesNotMatch(captured!, /V2-THURSDAY-SUMMARY/, "live overwrite must not leak into --at");
    assert.doesNotMatch(captured!, /V2-FRIDAY-SUMMARY/, "day with no cache at T must be skipped, not read live");
    assert.doesNotMatch(captured!, /some work happened/, "must not fall back to regenerating from live episodes");

    // Poison-guard for the new read path: --at performs ZERO cache writes.
    assert.deepEqual(snapshotCacheTree(), treeBefore, "--at mode must not write any cache file");
  });

  await t.test("live recall (no --at) → context is V2 from the filesystem", async () => {
    captured = null;
    const result = await recall(WEEK, "what happened?", null);
    assert.equal(result, "STUBBED ANSWER");
    assert.match(captured!, /V2-THURSDAY-SUMMARY/);
    assert.match(captured!, /V2-FRIDAY-SUMMARY/);
    assert.doesNotMatch(captured!, /V1-THURSDAY-SUMMARY/);
  });

  await t.test("--at before the first commit → clear sentinel, no LLM call", async () => {
    captured = null;
    const result = await recall(WEEK, "what happened?", null, { at: BEFORE_ALL });
    assert.equal(typeof result, "string");
    assert.match(result as string, /^\[recall: no commit in data repo before/);
    assert.equal(captured, null, "must not reach the LLM");
  });

  await t.test("--at with an invalid timestamp → clear sentinel", async () => {
    const result = await recall(WEEK, "q", null, { at: "yesterday-ish" });
    assert.match(result as string, /^\[recall: invalid --at timestamp/);
  });

  await t.test("--at on a day ref → clear unsupported sentinel", async () => {
    const result = await recall(DAY1, "q", null, { at: BETWEEN });
    assert.match(result as string, /^\[recall: --at is only supported/);
  });

  await t.test("--at on a session ref → clear unsupported sentinel", async () => {
    const result = await recall("0196a000-dead-beef-0000-000000000000", "q", null, { at: BETWEEN });
    assert.match(result as string, /^\[recall: --at is only supported/);
  });

  setCompleteForTest(null);
});
