// Versioned reads (Phase 0) — resolveShaAt / readFileAtSha / readFileAt.
//
// Fixture: a data repo where cache/days/2026-03-05.md is committed as V1 at
// T1, then overwritten and committed as V2 at T2. `rev-list --before`
// filters on COMMITTER date, so the fixture pins committer dates explicitly
// (production commits use committer date = now, author date = world-time).
//
// Contracts:
//   - readFileAt(path, T between T1 and T2) → V1 (the contemporaneous view)
//   - a live read of the same path → V2 (atomicWrite keeps overwriting; git
//     history is what preserves the past)
//   - readFileAt(path, T ≥ T2) → V2
//   - no commit before T → resolveShaAt returns null / readFileAt throws a
//     clear error
//   - path absent at the resolved commit → null
//   - reads are content-addressed (`git show`), never `git checkout`: the
//     working tree must be untouched by a versioned read.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SAVED_SNORRIO_HOME = process.env.SNORRIO_HOME;

let TMP: string;
let HOME_DIR: string;

const T1 = "2026-03-01T00:00:00Z";
const T2 = "2026-03-10T00:00:00Z";
const BETWEEN = "2026-03-05T12:00:00Z";
const BEFORE_ALL = "2026-02-01T00:00:00Z";
const AFTER_ALL = "2026-04-01T00:00:00Z";

const REL = "cache/days/2026-03-05.md";
const REL_LATE = "cache/days/2026-03-09.md"; // only exists from the T2 commit

let resolveShaAt: (t: string | Date) => string | null;
let readFileAtSha: (sha: string, rel: string) => string | null;
let readFileAt: (rel: string, t: string | Date) => string | null;

function git(args: string[], when?: string): string {
  return execFileSync("git", ["-C", HOME_DIR, ...args], {
    encoding: "utf8",
    env: when
      ? { ...process.env, GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when }
      : process.env,
  });
}

before(async () => {
  TMP = mkdtempSync(join(tmpdir(), "snorrio-versioned-read-test-"));
  HOME_DIR = join(TMP, "snorrio");
  process.env.SNORRIO_HOME = HOME_DIR;

  mkdirSync(join(HOME_DIR, "cache", "days"), { recursive: true });
  git(["init"]);
  git(["config", "user.name", "snorrio"]);
  git(["config", "user.email", "dmn@snorr.io"]);
  git(["config", "commit.gpgsign", "false"]);

  // v1 at T1
  writeFileSync(join(HOME_DIR, REL), "V1 — the contemporaneous view\n");
  git(["add", "-A"]);
  git(["commit", "-m", "cascade: v1"], T1);

  // v2 (overwrite) + a new file at T2
  writeFileSync(join(HOME_DIR, REL), "V2 — today's hindsight-saturated version\n");
  writeFileSync(join(HOME_DIR, REL_LATE), "late file\n");
  git(["add", "-A"]);
  git(["commit", "-m", "cascade: v2"], T2);

  const mod = await import("../src/versioned-read.ts");
  resolveShaAt = mod.resolveShaAt;
  readFileAtSha = mod.readFileAtSha;
  readFileAt = mod.readFileAt;
});

after(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
  if (SAVED_SNORRIO_HOME !== undefined) process.env.SNORRIO_HOME = SAVED_SNORRIO_HOME;
  else delete process.env.SNORRIO_HOME;
});

test("readFileAt between T1 and T2 returns v1; live read returns v2", () => {
  const past = readFileAt(REL, BETWEEN);
  assert.equal(past, "V1 — the contemporaneous view\n");

  // Live file keeps being overwritten — that's by design; history is in git.
  const live = readFileSync(join(HOME_DIR, REL), "utf8");
  assert.equal(live, "V2 — today's hindsight-saturated version\n");
});

test("readFileAt at/after T2 returns v2", () => {
  assert.equal(readFileAt(REL, AFTER_ALL), "V2 — today's hindsight-saturated version\n");
  assert.equal(readFileAt(REL, T2), "V2 — today's hindsight-saturated version\n");
});

test("resolveShaAt: no commit before T → null; readFileAt → clear error", () => {
  assert.equal(resolveShaAt(BEFORE_ALL), null);
  assert.throws(
    () => readFileAt(REL, BEFORE_ALL),
    /no commit in data repo before/,
  );
});

test("path absent at the resolved commit → null (not a throw)", () => {
  const sha1 = resolveShaAt(BETWEEN)!;
  assert.equal(readFileAtSha(sha1, REL_LATE), null, "file only exists from T2 onwards");
  assert.equal(readFileAt(REL_LATE, BETWEEN), null);
});

test("resolveShaAt resolves distinct shas across the boundary", () => {
  const sha1 = resolveShaAt(BETWEEN)!;
  const sha2 = resolveShaAt(AFTER_ALL)!;
  assert.ok(sha1 && sha2 && sha1 !== sha2);
  assert.equal(readFileAtSha(sha2, REL), "V2 — today's hindsight-saturated version\n");
});

test("versioned reads never touch the working tree (no checkout)", () => {
  const beforeMtime = statSync(join(HOME_DIR, REL)).mtimeMs;
  readFileAt(REL, BETWEEN);
  readFileAt(REL, AFTER_ALL);
  assert.equal(statSync(join(HOME_DIR, REL)).mtimeMs, beforeMtime, "working tree untouched");
  assert.equal(readFileSync(join(HOME_DIR, REL), "utf8"), "V2 — today's hindsight-saturated version\n");
  // git status must stay clean — no detached HEAD, no checkout side effects.
  assert.equal(git(["status", "--porcelain"]).trim(), "");
});

test("invalid timestamp → clear error", () => {
  assert.throws(() => resolveShaAt("not-a-time"), /invalid timestamp/);
});
