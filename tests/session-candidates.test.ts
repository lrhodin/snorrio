import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionLineageIndex } from "../src/session-lineage.ts";
import { externalLineageSessionCandidates, lineageSessionCandidates } from "../src/session-candidates.ts";

test("lineage-discovered external children enter sweep/flush candidate sets without scanning external trees", () => {
  const root = mkdtempSync(join(tmpdir(), "snorrio-candidates-"));
  try {
    const watched = join(root, "global");
    const project = join(root, "project-local");
    mkdirSync(watched); mkdirSync(project);
    const child = join(project, "child.jsonl");
    const parent = join(watched, "parent.jsonl");
    writeFileSync(child, JSON.stringify({ type: "session", id: "child" }));
    writeFileSync(parent, [
      JSON.stringify({ type: "session", id: "parent" }),
      JSON.stringify({ type: "custom_message", customType: "subagent_result", details: { sessionFile: child } }),
    ].join("\n"));
    const index = buildSessionLineageIndex([{ id: "parent", path: parent }]);
    assert.deepEqual(lineageSessionCandidates(index).map(session => session.id).sort(), ["child", "parent"]);
    assert.deepEqual(externalLineageSessionCandidates(index, watched).map(session => session.id), ["child"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
