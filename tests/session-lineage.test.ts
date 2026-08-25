import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionLineageIndex, canonicalSessionPath, getSessionLineageIndex, resolveLineageSession, __clearLineageCacheForTest } from "../src/session-lineage.ts";
import { buildEpisodeFrontmatter } from "../src/episode-frontmatter.ts";
import { externalLineageSessionCandidates, lineageSessionCandidates } from "../src/session-candidates.ts";

let roots: string[] = [];
afterEach(() => {
  __clearLineageCacheForTest();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "snorrio-lineage-"));
  roots.push(value);
  return value;
}

function session(dir: string, filename: string, id: string, options: {
  parentSession?: string;
  backlinks?: string[];
  backlinkType?: "subagent_result" | "subagent_ping";
  malformed?: boolean;
} = {}): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  const lines: string[] = [JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-08-23T00:00:00.000Z",
    ...(options.parentSession ? { parentSession: options.parentSession } : {}),
  })];
  for (const child of options.backlinks ?? []) {
    lines.push(JSON.stringify({
      type: "custom_message",
      customType: options.backlinkType ?? "subagent_result",
      content: "done",
      details: { sessionFile: child },
    }));
  }
  if (options.malformed) lines.push("{not-json");
  writeFileSync(path, lines.join("\n"));
  return path;
}

function info(path: string, id: string) { return { path, id }; }

describe("session lineage index", () => {
  test("lineage-only header uses canonical header IDs and nests to one root", () => {
    const dir = root();
    const grand = session(dir, "grand-weird-name.jsonl", "grand-id");
    const parent = session(dir, "parent-token.jsonl", "parent-header-id", { parentSession: grand });
    const child = session(dir, "child-token-not-id.jsonl", "child-header-id", { parentSession: parent });

    const index = buildSessionLineageIndex([
      info(child, "wrong-filename-hint"),
      info(grand, "grand-id"),
      info(parent, "parent-header-id"),
    ]);
    const lineage = index.getByPath(child)!;

    assert.equal(lineage.sessionId, "child-header-id");
    assert.equal(lineage.parentSessionId, "parent-header-id");
    assert.equal(lineage.rootSessionId, "grand-id");
    assert.equal(lineage.provenanceFamilyId, "grand-id");
    assert.equal(lineage.lineageDepth, 2);
    assert.equal(lineage.lineageSource, "header");
    assert.equal(lineage.lineageComplete, true);
  });

  test("persisted recursive subagent lineage supplies ancestry even in standalone mode", () => {
    const dir = root();
    const rootPath = session(dir, "root.jsonl", "root-session");
    const childPath = join(dir, "child.jsonl");
    writeFileSync(childPath, JSON.stringify({
      type: "session", version: 3, id: "child-session", timestamp: "2026-08-23T00:00:00.000Z",
      subagentDepth: 1,
      subagentLineage: {
        version: 1,
        root: { sessionId: "root-session", sessionFile: rootPath },
        chain: [{ depth: 1, id: "spawn-id", name: "worker", sessionFile: childPath, agent: "worker" }],
      },
    }) + "\n");

    const index = buildSessionLineageIndex([info(rootPath, "root-session"), info(childPath, "child-session")]);
    const child = index.getById("child-session")!;
    assert.equal(child.parentSessionId, "root-session");
    assert.equal(child.rootSessionId, "root-session");
    assert.equal(child.provenanceFamilyId, "root-session");
    assert.equal(child.lineageDepth, 1);
    assert.equal(child.lineageComplete, true);
  });

  test("reverse-link dependency discovers an external child without inventing ancestry", () => {
    const parentDir = root();
    const childDir = root();
    const child = session(childDir, "child.jsonl", "child-id");
    const parent = session(parentDir, "parent.jsonl", "parent-id", { backlinks: [child], backlinkType: "subagent_ping" });

    const index = buildSessionLineageIndex([info(parent, "parent-id")]);
    const lineage = index.getById("child-id")!;
    const consumer = index.getById("parent-id")!;

    assert.equal(lineage.sessionPath, canonicalSessionPath(child));
    assert.equal(lineage.parentSessionId, null);
    assert.equal(lineage.rootSessionId, "child-id");
    assert.equal(lineage.lineageSource, "reverse-link");
    assert.equal(lineage.lineageComplete, true);
    assert.equal(lineage.provenanceFamilyId, consumer.provenanceFamilyId);
    const direct = resolveLineageSession("child-", index);
    assert.equal(direct.ok, true);
    if (direct.ok) assert.equal(direct.session.path, canonicalSessionPath(child));
  });

  test("header ancestry wins while spawn and resume consumers remain in one evidence family", () => {
    const dir = root();
    const child = join(dir, "child.jsonl");
    const headerParent = session(dir, "header-parent.jsonl", "header-parent", { backlinks: [child] });
    const otherParent = session(dir, "other-parent.jsonl", "other-parent", { backlinks: [child] });
    session(dir, "child.jsonl", "child", { parentSession: headerParent });

    const index = buildSessionLineageIndex([
      info(headerParent, "header-parent"), info(otherParent, "other-parent"), info(child, "child"),
    ]);
    const lineage = index.getById("child")!;

    assert.equal(lineage.parentSessionId, "header-parent");
    assert.equal(lineage.lineageSource, "header");
    assert.equal(lineage.lineageComplete, true);
    assert.equal(index.getById("header-parent")!.provenanceFamilyId, lineage.provenanceFamilyId);
    assert.equal(index.getById("other-parent")!.provenanceFamilyId, lineage.provenanceFamilyId);
  });

  test("external child mtime invalidates the cached index and reveals an external grandchild", () => {
    const parentDir = root();
    const externalDir = root();
    const grandchild = join(externalDir, "grandchild.jsonl");
    const child = session(externalDir, "child.jsonl", "child-id");
    const parent = session(parentDir, "parent.jsonl", "parent-id", { backlinks: [child] });
    const oldHome = process.env.SNORRIO_HOME;
    process.env.SNORRIO_HOME = join(parentDir, "snorrio");
    try {
      const first = getSessionLineageIndex([info(parent, "parent-id")]);
      assert.equal(first.getById("grandchild-id"), null);
      session(externalDir, "grandchild.jsonl", "grandchild-id");
      session(externalDir, "child.jsonl", "child-id", { backlinks: [grandchild] });
      const second = getSessionLineageIndex([info(parent, "parent-id")]);
      assert.ok(second.getById("grandchild-id"));
      assert.equal(second.getById("grandchild-id")!.provenanceFamilyId, second.getById("parent-id")!.provenanceFamilyId);
    } finally {
      if (oldHome === undefined) delete process.env.SNORRIO_HOME; else process.env.SNORRIO_HOME = oldHome;
    }
  });

  test("resume records deduplicate one dependency without inventing ancestry", () => {
    const dir = root();
    const child = session(dir, "child.jsonl", "child-id");
    const parent = session(dir, "parent.jsonl", "parent-id", { backlinks: [child, child], backlinkType: "subagent_ping" });
    appendFileSync(parent, "\n" + JSON.stringify({ type: "custom_message", customType: "subagent_result", details: { sessionFile: child } }));

    const index = buildSessionLineageIndex([info(parent, "parent-id")]);
    assert.deepEqual(index.getById("parent-id")!.dependencySessionIds, ["child-id"]);
    assert.deepEqual(index.getById("child-id")!.dependencySessionIds, ["parent-id"]);
    assert.equal(index.getById("child-id")!.lineageDepth, 0);
  });

  test("candidate collection includes explicitly linked external children but does not scan their siblings", () => {
    const watched = root();
    const external = root();
    const child = session(external, "child.jsonl", "child-id");
    const unrelated = session(external, "unrelated.jsonl", "unrelated-id");
    const parent = session(watched, "parent.jsonl", "parent-id", { backlinks: [child] });
    const index = buildSessionLineageIndex([info(parent, "parent-id")]);

    assert.deepEqual(lineageSessionCandidates(index).map((entry) => entry.id).sort(), ["child-id", "parent-id"]);
    assert.deepEqual(externalLineageSessionCandidates(index, watched).map((entry) => entry.id), ["child-id"]);
    assert.ok(!lineageSessionCandidates(index).some((entry) => entry.path === unrelated));
  });

  test("conflicting explicit ancestry metadata is retained as header ancestry but marks the family conflicted/incomplete", () => {
    const dir = root();
    const child = join(dir, "child-conflict.jsonl");
    const parentA = session(dir, "parent-a.jsonl", "parent-a");
    const parentB = session(dir, "parent-b.jsonl", "parent-b", { backlinks: [child] });
    writeFileSync(child, JSON.stringify({
      type: "session", id: "child-conflict", parentSession: parentA, subagentDepth: 1,
      subagentLineage: { version: 1, root: { sessionFile: parentB }, chain: [{ depth: 1, sessionFile: child }] },
    }));
    const index = buildSessionLineageIndex([info(parentA, "parent-a"), info(parentB, "parent-b"), info(child, "child-conflict")]);
    const lineage = index.getById("child-conflict")!;
    assert.equal(lineage.parentSessionId, "parent-a");
    assert.equal(lineage.lineageComplete, false);
    assert.equal(lineage.lineageConflict, true);
    assert.equal(lineage.provenanceFamilyId, index.getById("parent-b")!.provenanceFamilyId);
  });

  test("multiple backlinks, missing parents, malformed records, and cycles fail safely", () => {
    const dir = root();

    const ambiguous = join(dir, "ambiguous.jsonl");
    const p1 = session(dir, "p1.jsonl", "p1", { backlinks: [ambiguous] });
    const p2 = session(dir, "p2.jsonl", "p2", { backlinks: [ambiguous] });
    session(dir, "ambiguous.jsonl", "ambiguous");

    const missing = session(dir, "missing.jsonl", "missing-child", { parentSession: join(dir, "does-not-exist.jsonl") });
    const malformed = session(dir, "malformed.jsonl", "malformed", { malformed: true });
    const cycleA = join(dir, "cycle-a.jsonl");
    const cycleB = join(dir, "cycle-b.jsonl");
    session(dir, "cycle-a.jsonl", "cycle-a", { parentSession: cycleB });
    session(dir, "cycle-b.jsonl", "cycle-b", { parentSession: cycleA });

    const index = buildSessionLineageIndex([
      info(p1, "p1"), info(p2, "p2"), info(ambiguous, "ambiguous"),
      info(missing, "missing-child"), info(malformed, "malformed"),
      info(cycleA, "cycle-a"), info(cycleB, "cycle-b"),
    ]);

    const ambiguousLineage = index.getById("ambiguous")!;
    assert.equal(ambiguousLineage.parentSessionId, null);
    assert.equal(ambiguousLineage.lineageSource, "reverse-link");
    assert.equal(ambiguousLineage.lineageComplete, true);
    assert.equal(index.getById("p1")!.provenanceFamilyId, ambiguousLineage.provenanceFamilyId);
    assert.equal(index.getById("p2")!.provenanceFamilyId, ambiguousLineage.provenanceFamilyId);

    const missingLineage = index.getById("missing-child")!;
    assert.equal(missingLineage.parentSessionId, null);
    assert.equal(missingLineage.lineageComplete, false);
    assert.match(missingLineage.issues.join(" "), /missing/);

    assert.equal(index.getById("malformed")!.lineageComplete, false);
    for (const id of ["cycle-a", "cycle-b"]) {
      const lineage = index.getById(id)!;
      assert.equal(lineage.lineageComplete, false);
      assert.equal(lineage.provenanceFamilyId, "cycle-a");
      assert.match(lineage.issues.join(" "), /cycle/);
    }
  });
});

test("episode frontmatter persists complete lineage metadata", () => {
  const fm = buildEpisodeFrontmatter({
    origin: "pi",
    machine: "test-machine",
    sourcePath: "/home/me/session.jsonl",
    home: "/home/me",
    timestamp: "2026-08-23T12:00:00.000Z",
    lineage: {
      sessionId: "child",
      sessionPath: "/home/me/session.jsonl",
      parentSessionId: "parent",
      rootSessionId: "root",
      provenanceFamilyId: "root",
      lineageDepth: 2,
      lineageSource: "header",
      lineageComplete: true,
      lineageConflict: false,
      dependencySessionIds: ["parent"],
      issues: [],
    },
    localDate: {
      localDate: "2026-08-23",
      tz: "America/Los_Angeles",
      utcOffset: "-07:00",
      tzSource: "system",
    },
  });

  assert.match(fm, /^---\n/);
  assert.match(fm, /session_id: "child"/);
  assert.match(fm, /parent_session_id: "parent"/);
  assert.match(fm, /root_session_id: "root"/);
  assert.match(fm, /provenance_family_id: "root"/);
  assert.match(fm, /lineage_depth: 2/);
  assert.match(fm, /lineage_source: "header"/);
  assert.match(fm, /lineage_complete: true/);
  assert.match(fm, /local_date: "2026-08-23"/);
  assert.match(fm, /tz: "America\/Los_Angeles"/);
  assert.match(fm, /utc_offset: "-07:00"/);
  assert.match(fm, /tz_source: "system"/);
});
