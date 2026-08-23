import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionLineageIndex, __clearLineageCacheForTest } from "../src/session-lineage.ts";
import { parseEpisodeFrontmatter } from "../src/episode-frontmatter.ts";
import { migrateProvenanceMetadata, planProvenanceRecascade, writeProvenanceRecascadeMarker } from "../src/provenance-migration.ts";
import {
  buildCacheProvenanceManifest,
  cacheManifestNeedsRefresh,
  cacheManifestPath,
  readCacheProvenanceManifest,
  writeCacheWithProvenance,
  writeCacheProvenanceManifest,
  type CacheLevel,
} from "../src/cache-provenance.ts";

const roots: string[] = [];
afterEach(() => {
  __clearLineageCacheForTest();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "snorrio-provenance-"));
  roots.push(root);
  return root;
}

function writeSession(path: string, id: string, parentSession?: string, childPath?: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const lines: string[] = [JSON.stringify({ type: "session", version: 3, id, ...(parentSession ? { parentSession } : {}) })];
  if (childPath) lines.push(JSON.stringify({ type: "custom_message", customType: "subagent_result", details: { sessionFile: childPath } }));
  writeFileSync(path, lines.join("\n"));
}

function cacheRefs(): Array<[CacheLevel, string, string]> {
  return [
    ["day", "2026-08-23", "days"],
    ["week", "2026-W34", "weeks"],
    ["month", "2026-08", "months"],
    ["quarter", "2026-Q3", "quarters"],
    ["year", "2026", "years"],
  ];
}

test("metadata migration preserves prose, updates existing frontmatter, writes every manifest level, and is idempotent", () => {
  const root = tempRoot();
  const home = join(root, "home");
  const episodesDir = join(home, "snorrio", "episodes");
  const cacheDir = join(home, "snorrio", "cache");
  const sessionsDir = join(home, "sessions");
  const parentPath = join(sessionsDir, "parent.jsonl");
  const childPath = join(root, "project", "child.jsonl");
  writeSession(childPath, "child", parentPath);
  writeSession(parentPath, "parent", undefined, childPath);
  const index = buildSessionLineageIndex([{ id: "parent", path: parentPath }]);

  const dayDir = join(episodesDir, "2026-08-23");
  mkdirSync(dayDir, { recursive: true });
  const parentProse = "\nExact parent prose.\n\nTrailing bytes stay.\n";
  const parentBefore = [
    "---",
    'origin: "pi"',
    'machine: "old"',
    'source: "~/old.jsonl"',
    'timestamp: "2026-08-23T10:00:00.000Z"',
    'lineage_source: "none"',
    "lineage_complete: true",
    "---",
    parentProse,
  ].join("\n");
  writeFileSync(join(dayDir, "parent.md"), parentBefore);
  writeFileSync(join(dayDir, "child.md"), "Child prose without frontmatter.\n");
  writeFileSync(join(dayDir, "missing.md"), "Unrecoverable prose.\n");

  for (const [, ref, dir] of cacheRefs()) {
    mkdirSync(join(cacheDir, dir), { recursive: true });
    writeFileSync(join(cacheDir, dir, `${ref}.md`), `summary ${ref}`);
  }

  const before = new Map(["parent", "child", "missing"].map((id) => [id, readFileSync(join(dayDir, `${id}.md`), "utf8")]));
  const dry = migrateProvenanceMetadata({ episodesDir, cacheDir, lineageIndex: index, home, machine: "test", dryRun: true });
  assert.equal(dry.episodesChanged, 3);
  assert.equal(dry.episodesUnknown, 1);
  assert.deepEqual(dry.affectedDates, ["2026-08-23"]);
  for (const [id, content] of before) assert.equal(readFileSync(join(dayDir, `${id}.md`), "utf8"), content);
  for (const [level, ref] of cacheRefs()) assert.equal(readCacheProvenanceManifest(level, ref, cacheDir), null);

  const first = migrateProvenanceMetadata({ episodesDir, cacheDir, lineageIndex: index, home, machine: "test" });
  assert.equal(first.episodesScanned, 3);
  assert.equal(first.episodesChanged, 3);
  assert.equal(first.manifestsWritten, 5);
  assert.deepEqual(first.affectedDates, ["2026-08-23"]);
  const plan = planProvenanceRecascade(first, { cacheDir, episodesDir, lineageIndex: index });
  assert.deepEqual(plan.dates, ["2026-08-23"]);
  writeProvenanceRecascadeMarker(cacheDir, plan.signatures);
  assert.deepEqual(planProvenanceRecascade(first, { cacheDir, episodesDir, lineageIndex: index }).dates, []);

  const migratedParent = parseEpisodeFrontmatter(readFileSync(join(dayDir, "parent.md"), "utf8"));
  assert.equal(migratedParent.prose, parseEpisodeFrontmatter(parentBefore).prose);
  assert.equal(migratedParent.fields.get("machine"), '"old"');
  assert.equal(migratedParent.fields.get("provenance_family_id"), '"parent"');
  assert.equal(migratedParent.fields.get("lineage_source"), '"reverse-link"');
  const missing = parseEpisodeFrontmatter(readFileSync(join(dayDir, "missing.md"), "utf8"));
  assert.equal(missing.fields.get("lineage_source"), '"unknown"');
  assert.equal(missing.fields.get("lineage_complete"), "false");

  for (const [level, ref] of cacheRefs()) {
    const manifest = readCacheProvenanceManifest(level, ref, cacheDir);
    assert.ok(manifest, `${level} manifest missing`);
    assert.deepEqual(manifest!.families.find((family) => family.provenanceFamilyId === "parent")?.sessionIds, ["child", "parent"]);
    assert.ok(manifest!.families.some((family) => family.provenanceFamilyId === "missing" && !family.lineageComplete));
  }

  const afterFirst = new Map(["parent", "child", "missing"].map((id) => [id, readFileSync(join(dayDir, `${id}.md`), "utf8")]));
  const second = migrateProvenanceMetadata({ episodesDir, cacheDir, lineageIndex: index, home, machine: "test" });
  assert.equal(second.episodesChanged, 0);
  for (const [id, content] of afterFirst) assert.equal(readFileSync(join(dayDir, `${id}.md`), "utf8"), content);

  const firstPlan = planProvenanceRecascade(second, { cacheDir, episodesDir, lineageIndex: index });
  assert.deepEqual(firstPlan.dates, [], "an unchanged family already recorded in the marker must not rebuild again");
  writeProvenanceRecascadeMarker(cacheDir, firstPlan.signatures);
  assert.deepEqual(planProvenanceRecascade(second, { cacheDir, episodesDir, lineageIndex: index }).dates, []);

  // A later repair that splits a previously grouped family schedules exactly
  // one final rebuild, then removes the date from the marker.
  const splitResult = { ...second, affectedDates: [] };
  const splitPlan = planProvenanceRecascade(splitResult, { cacheDir, episodesDir, lineageIndex: index });
  assert.deepEqual(splitPlan.dates, ["2026-08-23"]);
  writeProvenanceRecascadeMarker(cacheDir, splitPlan.signatures);
  assert.deepEqual(planProvenanceRecascade(splitResult, { cacheDir, episodesDir, lineageIndex: index }).dates, []);
});

test("legacy standalone lineage_source none remains unknown unless a durable edge is recoverable", () => {
  const root = tempRoot();
  const home = join(root, "home");
  const episodesDir = join(root, "episodes");
  const cacheDir = join(root, "cache");
  const sessionPath = join(root, "standalone.jsonl");
  writeSession(sessionPath, "standalone");
  const index = buildSessionLineageIndex([{ id: "standalone", path: sessionPath }]);
  const dayDir = join(episodesDir, "2026-08-23");
  mkdirSync(dayDir, { recursive: true });
  const before = [
    "---",
    'session_id: "standalone"',
    'provenance_family_id: "standalone"',
    'lineage_source: "none"',
    "lineage_complete: true",
    "---",
    "",
    "legacy prose",
  ].join("\n");
  writeFileSync(join(dayDir, "standalone.md"), before);

  const result = migrateProvenanceMetadata({ episodesDir, cacheDir, lineageIndex: index, home });
  assert.equal(result.episodesUnknown, 1);
  const parsed = parseEpisodeFrontmatter(readFileSync(join(dayDir, "standalone.md"), "utf8"));
  assert.equal(parsed.fields.get("lineage_metadata_version"), "1");
  assert.equal(parsed.fields.get("lineage_source"), '"unknown"');
  assert.equal(parsed.fields.get("lineage_complete"), "false");
  assert.equal(parsed.prose, parseEpisodeFrontmatter(before).prose);
});

test("cache writes include a sidecar and validation rejects absent, wrong-schema, stale, and structurally stale manifests", () => {
  const root = tempRoot();
  const episodesDir = join(root, "episodes");
  const cacheDir = join(root, "cache");
  const dayDir = join(episodesDir, "2026-08-23");
  mkdirSync(dayDir, { recursive: true });
  writeFileSync(join(dayDir, "one.md"), ["---", 'session_id: "one"', 'provenance_family_id: "one"', "lineage_complete: false", "lineage_conflict: false", "---", "", "body"].join("\n"));
  const emptyIndex = buildSessionLineageIndex([]);

  writeCacheWithProvenance("day", "2026-08-23", "summary", { cacheDir, episodesDir, lineageIndex: emptyIndex });
  assert.equal(readFileSync(join(cacheDir, "days", "2026-08-23.md"), "utf8"), "summary");
  assert.ok(readCacheProvenanceManifest("day", "2026-08-23", cacheDir));
  const newest = statSync(join(dayDir, "one.md")).mtimeMs;
  assert.equal(cacheManifestNeedsRefresh("day", "2026-08-23", newest, { cacheDir, episodesDir, lineageIndex: emptyIndex }), false);

  rmSync(cacheManifestPath("day", "2026-08-23", cacheDir));
  assert.equal(cacheManifestNeedsRefresh("day", "2026-08-23", newest, { cacheDir, episodesDir, lineageIndex: emptyIndex }), true);

  writeFileSync(cacheManifestPath("day", "2026-08-23", cacheDir), '{"schemaVersion":0}\n');
  assert.equal(cacheManifestNeedsRefresh("day", "2026-08-23", newest, { cacheDir, episodesDir, lineageIndex: emptyIndex }), true);

  const expected = buildCacheProvenanceManifest("day", "2026-08-23", { episodesDir, lineageIndex: emptyIndex });
  writeCacheProvenanceManifest(expected, cacheDir);
  utimesSync(cacheManifestPath("day", "2026-08-23", cacheDir), new Date(0), new Date(0));
  assert.equal(cacheManifestNeedsRefresh("day", "2026-08-23", newest, { cacheDir, episodesDir, lineageIndex: emptyIndex }), true);

  writeCacheProvenanceManifest({ ...expected, families: [] }, cacheDir);
  assert.equal(cacheManifestNeedsRefresh("day", "2026-08-23", 0, { cacheDir, episodesDir, lineageIndex: emptyIndex }), true);
});
