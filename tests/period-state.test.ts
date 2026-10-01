import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { periodBounds, periodFraming, periodState } from "../src/period-state.ts";
import {
  cacheNeedsClosingRebuild,
  readCacheProvenanceManifest,
  writeCacheProvenanceManifest,
  writeCacheWithProvenance,
} from "../src/cache-provenance.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tempCache(): { cacheDir: string; episodesDir: string } {
  const root = mkdtempSync(join(tmpdir(), "snorrio-period-"));
  roots.push(root);
  const cacheDir = join(root, "cache");
  for (const dir of ["days", "weeks", "months", "quarters", "years"]) mkdirSync(join(cacheDir, dir), { recursive: true });
  const episodesDir = join(root, "episodes");
  mkdirSync(episodesDir, { recursive: true });
  return { cacheDir, episodesDir };
}

test("period bounds span the period's own dates", () => {
  assert.deepEqual(periodBounds("week", "2026-W40"), { start: "2026-09-28", end: "2026-10-04" });
  assert.deepEqual(periodBounds("month", "2026-07"), { start: "2026-07-01", end: "2026-07-31" });
  assert.deepEqual(periodBounds("quarter", "2026-Q3"), { start: "2026-07-01", end: "2026-09-30" });
  assert.deepEqual(periodBounds("year", "2026"), { start: "2026-01-01", end: "2026-12-31" });
});

test("a period is closed only after its last local date", () => {
  assert.equal(periodState("month", "2026-07", "2026-09-30"), "closed");
  assert.equal(periodState("quarter", "2026-Q3", "2026-09-30"), "open");
  assert.equal(periodState("quarter", "2026-Q3", "2026-10-01"), "closed");
  assert.equal(periodState("month", "2026-10", "2026-09-30"), "future");
  assert.equal(periodState("day", "2026-09-30", "2026-09-30"), "open");
});

test("framing tells the model whether the period is over", () => {
  assert.match(periodFraming("month", "2026-07", "2026-09-30"), /is over and its record is complete/);
  assert.match(periodFraming("quarter", "2026-Q3", "2026-09-30"), /still in progress \(today is its last day\)/);
  assert.match(periodFraming("week", "2026-W40", "2026-09-30"), /4 days remain/);
});

test("writes record the period state; a closed period written while open needs exactly one closing rebuild", () => {
  const { cacheDir, episodesDir } = tempCache();
  const opts = { cacheDir, episodesDir };

  writeCacheWithProvenance("month", "2026-09", "September in progress.", { ...opts, today: "2026-09-30" });
  assert.equal(readCacheProvenanceManifest("month", "2026-09", cacheDir)?.periodState, "open");
  assert.equal(cacheNeedsClosingRebuild("month", "2026-09", { cacheDir, today: "2026-09-30" }), false);
  assert.equal(cacheNeedsClosingRebuild("month", "2026-09", { cacheDir, today: "2026-10-01" }), true);

  writeCacheWithProvenance("month", "2026-09", "September, finished.", { ...opts, today: "2026-10-01" });
  assert.equal(readCacheProvenanceManifest("month", "2026-09", cacheDir)?.periodState, "closed");
  assert.equal(cacheNeedsClosingRebuild("month", "2026-09", { cacheDir, today: "2026-10-02" }), false);
});

test("legacy sidecars without a state get a closing rebuild once closed; days never do", () => {
  const { cacheDir } = tempCache();
  writeCacheProvenanceManifest({ schemaVersion: 1, level: "month", ref: "2026-07", coveredRefs: [], families: [] }, cacheDir);
  assert.equal(cacheNeedsClosingRebuild("month", "2026-07", { cacheDir, today: "2026-09-30" }), true);
  assert.equal(cacheNeedsClosingRebuild("day", "2026-07-01", { cacheDir, today: "2026-09-30" }), false);
});

test("evidence-only manifest rewrites keep the recorded state", () => {
  const { cacheDir, episodesDir } = tempCache();
  writeCacheWithProvenance("week", "2026-W39", "A finished week.", { cacheDir, episodesDir, today: "2026-09-30" });
  writeCacheProvenanceManifest({ schemaVersion: 1, level: "week", ref: "2026-W39", coveredRefs: ["2026-09-22"], families: [] }, cacheDir);
  const manifest = readCacheProvenanceManifest("week", "2026-W39", cacheDir);
  assert.equal(manifest?.periodState, "closed");
  assert.deepEqual(manifest?.coveredRefs, ["2026-09-22"]);
});

test("a period that has not started cannot be published", () => {
  const { cacheDir, episodesDir } = tempCache();
  assert.throws(
    () => writeCacheWithProvenance("month", "2026-10", "October.", { cacheDir, episodesDir, today: "2026-09-30" }),
    /has not started/,
  );
});
