// Tests for src/session-meta.ts.
//
// Strategy: feed the parser a small corpus of real (anonymized) pi session
// files and assert it extracts structurally correct metadata for every one.
// This is the seam through which pi schema drift will first show up — we want
// the tests to scream when that happens, not silently misparse.

import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// session-meta.ts captures HOME at module load to compute PI_SESSIONS_DIR, so
// we have to redirect HOME *before* importing it. We point HOME at a temp
// directory whose .pi/agent/sessions/<project>/ holds copies of the fixtures,
// which lets us also exercise findSession() / allSessions() without touching
// the developer's real ~/.pi.

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures/sessions");

const FAKE_HOME = mkdtempSync(join(tmpdir(), "snorrio-session-meta-"));
const FAKE_SESSIONS_DIR = join(FAKE_HOME, ".pi/agent/sessions/--fixtures--");
mkdirSync(FAKE_SESSIONS_DIR, { recursive: true });

const FIXTURE_FILES = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".jsonl"));
for (const f of FIXTURE_FILES) {
  copyFileSync(join(FIXTURES_DIR, f), join(FAKE_SESSIONS_DIR, f));
}

process.env.HOME = FAKE_HOME;

// Dynamic import so the HOME override above takes effect before module init.
const sm = await import("../src/session-meta.ts");

interface FixtureExpectation {
  file: string;
  id: string;
  messageCount: number; // top-level entries with type === "message"
  start: string;
  end: string;
  hasAssistant: boolean;
}

// Snapshotted from the actual fixtures. If pi changes its message-entry shape,
// the parser's view of these numbers should change in lockstep — and if it
// doesn't, this test catches the drift.
const FIXTURES: FixtureExpectation[] = [
  {
    file: "2026-03-24T21-49-28-961Z_43bad035-df96-4d42-b577-22d3dc537ea9.jsonl",
    id: "43bad035-df96-4d42-b577-22d3dc537ea9",
    messageCount: 4,
    start: "2026-03-24T21:49:28.961Z",
    end: "2026-03-24T21:50:34.872Z",
    hasAssistant: true,
  },
  {
    file: "2026-03-05T15-09-01-585Z_7f4c7f73-309b-4370-b7f5-e96a5ae23d1f.jsonl",
    id: "7f4c7f73-309b-4370-b7f5-e96a5ae23d1f",
    messageCount: 16,
    start: "2026-03-05T15:09:01.585Z",
    end: "2026-03-05T15:11:19.527Z",
    hasAssistant: true,
  },
  {
    file: "2026-05-02T21-31-41-301Z_019dea9a-b774-7249-b390-64b867baf26f.jsonl",
    id: "019dea9a-b774-7249-b390-64b867baf26f",
    messageCount: 132,
    start: "2026-05-02T21:31:41.301Z",
    end: "2026-05-02T21:56:52.231Z",
    hasAssistant: true,
  },
  {
    file: "2026-02-04T01-06-28-982Z_af5a9941-f8ae-4a49-b045-5d62af697db8.jsonl",
    id: "af5a9941-f8ae-4a49-b045-5d62af697db8",
    messageCount: 198,
    start: "2026-02-04T01:06:28.982Z",
    end: "2026-02-04T01:38:04.022Z",
    hasAssistant: true,
  },
];

function fixturePath(f: string): string {
  return join(FAKE_SESSIONS_DIR, f);
}

describe("session-meta: fixture corpus", () => {
  before(() => {
    assert.equal(
      FIXTURE_FILES.length,
      FIXTURES.length,
      `fixture directory has ${FIXTURE_FILES.length} files but the test expects ${FIXTURES.length}; update FIXTURES if you added/removed one`,
    );
  });

  for (const fx of FIXTURES) {
    describe(fx.file, () => {
      const path = fixturePath(fx.file);

      test("sessionIdFromPath recovers the canonical UUID from the filename", () => {
        const id = sm.sessionIdFromPath(path);
        assert.equal(id, fx.id);
      });

      test("sessionIdFromEntries returns the same id (and matches the type:'session' entry)", () => {
        const id = sm.sessionIdFromEntries(path);
        assert.equal(id, fx.id);
      });

      test("sessionTimestamps returns finite, ordered ISO strings spanning all entries", () => {
        const ts = sm.sessionTimestamps(path);
        assert.equal(ts.start, fx.start);
        assert.equal(ts.end, fx.end);

        // Defensive: the parser must not return undefined or NaN for valid input.
        assert.notEqual(ts.start, null);
        assert.notEqual(ts.end, null);
        const startMs = new Date(ts.start!).getTime();
        const endMs = new Date(ts.end!).getTime();
        assert.ok(Number.isFinite(startMs), `start not finite: ${ts.start}`);
        assert.ok(Number.isFinite(endMs), `end not finite: ${ts.end}`);
        assert.ok(startMs <= endMs, `start (${ts.start}) is after end (${ts.end})`);
      });

      test("hasAssistantMessage matches expectation", () => {
        assert.equal(sm.hasAssistantMessage(path), fx.hasAssistant);
      });
    });
  }
});

describe("session-meta: discovery against a fixture HOME", () => {
  test("allSessions() finds every fixture under HOME/.pi/agent/sessions", () => {
    const found = sm.allSessions();
    const foundIds = new Set(found.map((s) => s.id));
    for (const fx of FIXTURES) {
      assert.ok(foundIds.has(fx.id), `allSessions did not find ${fx.id}`);
    }
    // No path should be undefined / empty — guards against silent walk bugs.
    for (const s of found) {
      assert.ok(s.path && s.path.endsWith(".jsonl"), `bad path: ${s.path}`);
      assert.ok(s.id, "session info missing id");
    }
  });

  test("findSession() resolves by full id and by short prefix", () => {
    for (const fx of FIXTURES) {
      const full = sm.findSession(fx.id);
      assert.ok(full, `findSession(${fx.id}) returned null`);
      assert.equal(full!.id, fx.id);

      const prefix = fx.id.slice(0, 8);
      const partial = sm.findSession(prefix);
      assert.ok(partial, `findSession(${prefix}) returned null`);
      assert.equal(partial!.id, fx.id);
    }
  });

  test("resolveFullId() is equivalent to findSession()", () => {
    const fx = FIXTURES[0]!;
    const a = sm.findSession(fx.id);
    const b = sm.resolveFullId(fx.id);
    assert.deepEqual(a, b);
  });

  test("findSession() returns null for an unknown id instead of throwing", () => {
    assert.equal(sm.findSession("ffffffff-ffff-ffff-ffff-ffffffffffff"), null);
  });
});

describe("session-meta: malformed input is tolerated, not fatal", () => {
  // Every parser in session-meta wraps JSON.parse in try/catch on purpose:
  // pi sometimes writes partial lines on crash. If a regression strips that,
  // a single corrupt line in a real session would break recall for the whole
  // session. These cases lock that contract in.

  test("sessionTimestamps ignores blank and unparseable lines", async () => {
    const { writeFileSync } = await import("node:fs");
    const p = join(FAKE_HOME, "garbage.jsonl");
    writeFileSync(
      p,
      [
        "",
        "this is not json",
        '{"type":"message","timestamp":"2026-01-01T00:00:00.000Z"}',
        '{"type":"message","timestamp":"2026-01-01T00:00:05.000Z"}',
        "{ partial",
      ].join("\n"),
    );
    const ts = sm.sessionTimestamps(p);
    assert.equal(ts.start, "2026-01-01T00:00:00.000Z");
    assert.equal(ts.end, "2026-01-01T00:00:05.000Z");
  });

  test("hasAssistantMessage tolerates garbage lines", async () => {
    const { writeFileSync } = await import("node:fs");
    const p = join(FAKE_HOME, "garbage2.jsonl");
    writeFileSync(
      p,
      [
        "not json at all",
        '{"type":"message","message":{"role":"user"}}',
        '{"type":"message","message":{"role":"assistant"}}',
      ].join("\n"),
    );
    assert.equal(sm.hasAssistantMessage(p), true);
  });

  test("sessionIdFromPath returns null for a non-pi filename instead of throwing", () => {
    assert.equal(sm.sessionIdFromPath("/tmp/not-a-pi-session.jsonl"), null);
    assert.equal(sm.sessionIdFromPath("/tmp/2026-01-01_no-uuid-here.jsonl"), null);
  });
});
