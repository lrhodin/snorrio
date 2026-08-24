// Tests for the rebuild retry contract.
//
// The incident: on 2026-08-24 a 26-day provenance migration rebuilt 25 day
// caches successfully, then `2026-07-30` returned "no usable summary" under
// 26-way parallel LLM load. Strict mode threw on that first failure and the
// entire run aborted — no marker written, no partial credit — even though
// recalling 2026-07-30 on its own succeeded moments later. These tests pin the
// two properties that prevent a repeat: a transient failure is retried, and an
// exhausted retry is *reported* rather than thrown, so the batch can record
// what did succeed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { withRetries, type AttemptOutcome } from "../src/retry.ts";

const noSleep = async () => {};

test("a success on the first attempt makes exactly one call", () => {
  let calls = 0;
  return withRetries(async () => { calls++; return null; }, { attempts: 3, sleep: noSleep })
    .then((problem) => {
      assert.equal(problem, null);
      assert.equal(calls, 1);
    });
});

test("a transient failure is retried and then succeeds", async () => {
  // Exactly the 2026-07-30 shape: fails under load, succeeds on its own.
  let calls = 0;
  const problem = await withRetries(async () => {
    calls++;
    return calls === 1 ? "cache rebuild returned no usable summary for day 2026-07-30" : null;
  }, { attempts: 3, sleep: noSleep });

  assert.equal(problem, null, "should ultimately succeed");
  assert.equal(calls, 2, "should have retried once");
});

test("an exhausted retry returns the failure instead of throwing", async () => {
  // The load-bearing property. Throwing is what discarded 25 good rebuilds.
  let calls = 0;
  const problem = await withRetries(async () => { calls++; return "still broken"; }, {
    attempts: 3,
    sleep: noSleep,
  });

  assert.equal(problem, "still broken");
  assert.equal(calls, 3, "should have used every attempt");
});

test("a thrown error is retried like a returned failure", async () => {
  let calls = 0;
  const problem = await withRetries(async () => {
    calls++;
    if (calls < 3) throw new Error("socket hang up");
    return null;
  }, { attempts: 3, sleep: noSleep });

  assert.equal(problem, null);
  assert.equal(calls, 3);
});

test("a thrown error surviving every attempt is returned, not propagated", async () => {
  const problem = await withRetries(async () => { throw new Error("provider down"); }, {
    attempts: 2,
    sleep: noSleep,
  });
  assert.equal(problem, "provider down");
});

test("attempts: 1 disables retrying, for the live cascade path", async () => {
  // Live mode self-heals via validateCaches, so it must not pay for repeat
  // LLM calls.
  let calls = 0;
  const problem = await withRetries(async () => { calls++; return "nope"; }, {
    attempts: 1,
    sleep: noSleep,
  });
  assert.equal(calls, 1);
  assert.equal(problem, "nope");
});

test("only the last failing attempt is marked final", async () => {
  const seen: AttemptOutcome[] = [];
  await withRetries(async () => "bad", {
    attempts: 3,
    sleep: noSleep,
    onAttempt: (o) => seen.push(o),
  });

  assert.deepEqual(seen.map((o) => o.attempt), [1, 2, 3]);
  assert.deepEqual(seen.map((o) => o.final), [false, false, true]);
});

test("a success is reported as final so it is never logged as a retry", async () => {
  const seen: AttemptOutcome[] = [];
  await withRetries(async (n) => (n === 2 ? null : "bad"), {
    attempts: 5,
    sleep: noSleep,
    onAttempt: (o) => seen.push(o),
  });

  assert.equal(seen.length, 2, "must stop calling once it succeeds");
  assert.equal(seen[1].problem, null);
  assert.equal(seen[1].final, true);
});

test("backoff grows and is not applied after the final attempt", async () => {
  const slept: number[] = [];
  await withRetries(async () => "bad", {
    attempts: 3,
    sleep: async (ms) => { slept.push(ms); },
    backoffMs: (attempt) => 100 * attempt,
  });

  // Two waits for three attempts: never sleep after giving up.
  assert.deepEqual(slept, [100, 200]);
});
