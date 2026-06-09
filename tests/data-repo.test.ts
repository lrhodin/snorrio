// Data-repo versioning (Phase 0) — ensureDataRepo + commitDataRepo.
//
// Contracts pinned here:
//   1. ensureDataRepo is idempotent and self-initializing: first call inits
//      the repo on the RESOLVED real path, writes the data .gitignore, makes
//      the initial snapshot commit; subsequent calls add nothing.
//   2. Identity is repo-LOCAL (user.name "snorrio" / user.email
//      "dmn@snorr.io" in .git/config). Global git config is never touched.
//   3. git missing ⇒ disabled flag, loud warning, NO throw. Memory must work
//      without git.
//   4. A failing commit (git gone after init) never throws and never blocks
//      cache writes — this is the "cascade completes even when git fails"
//      guarantee at the unit level: the daemon writes caches first via
//      atomicWriteFile, then calls commitDataRepo, which cannot throw.
//   5. Author date of a cascade commit = episode world-time
//      (GIT_AUTHOR_DATE); committer date stays "now".

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SAVED_ENV = { SNORRIO_HOME: process.env.SNORRIO_HOME, PATH: process.env.PATH };
const ROOTS: string[] = [];

let ensureDataRepo: () => { root: string; enabled: boolean };
let commitDataRepo: (c: { message: string; authorDate?: string }) => boolean;
let atomicWriteFile: (p: string, c: string) => void;

function freshRoot(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `snorrio-data-repo-${name}-`));
  ROOTS.push(dir);
  const home = join(dir, "snorrio");
  mkdirSync(home, { recursive: true });
  process.env.SNORRIO_HOME = home;
  return home;
}

function rawGit(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

// Capture stderr writes so we can assert the loud-warning contract.
function captureStderr<T>(fn: () => T): { result: T; stderr: string } {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = "";
  (process.stderr as any).write = (chunk: any) => { buf += String(chunk); return true; };
  try {
    return { result: fn(), stderr: buf };
  } finally {
    (process.stderr as any).write = orig;
  }
}

before(async () => {
  const mod = await import("../src/data-repo.ts");
  ensureDataRepo = mod.ensureDataRepo;
  commitDataRepo = mod.commitDataRepo;
  atomicWriteFile = (await import("../src/atomic-write.ts")).atomicWriteFile;
});

after(() => {
  for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
  if (SAVED_ENV.SNORRIO_HOME !== undefined) process.env.SNORRIO_HOME = SAVED_ENV.SNORRIO_HOME;
  else delete process.env.SNORRIO_HOME;
  process.env.PATH = SAVED_ENV.PATH;
});

test("ensureDataRepo: initializes once, idempotent on re-run", () => {
  const home = freshRoot("init");
  // pre-existing state must land in the initial snapshot
  mkdirSync(join(home, "episodes", "2026-01-01"), { recursive: true });
  writeFileSync(join(home, "episodes", "2026-01-01", "abc.md"), "an episode");
  // ignored operational noise
  mkdirSync(join(home, "logs"), { recursive: true });
  writeFileSync(join(home, "logs", "2026-01-01.log"), "log line");
  writeFileSync(join(home, "flush"), "");

  const s1 = ensureDataRepo();
  assert.equal(s1.enabled, true);
  assert.equal(s1.root, realpathSync(home), "repo root must be the RESOLVED real path");
  assert.ok(existsSync(join(home, ".git")), ".git created");
  assert.ok(existsSync(join(home, ".gitignore")), "data .gitignore written");

  const log1 = rawGit(home, ["log", "--format=%s"]).trim().split("\n");
  assert.equal(log1.length, 1, "exactly one commit after init");
  assert.match(log1[0], /initial snapshot/);

  const tracked = rawGit(home, ["ls-files"]);
  assert.match(tracked, /episodes\/2026-01-01\/abc\.md/, "pre-existing state committed");
  assert.doesNotMatch(tracked, /logs\//, "logs/ ignored");
  assert.doesNotMatch(tracked, /^flush$/m, "flush trigger ignored");

  // Idempotent: second call adds nothing, changes nothing.
  const s2 = ensureDataRepo();
  assert.equal(s2.enabled, true);
  const log2 = rawGit(home, ["log", "--format=%s"]).trim().split("\n");
  assert.deepEqual(log2, log1, "re-run must not create commits");
});

test("ensureDataRepo: identity is repo-local, global config untouched", () => {
  const home = freshRoot("identity");
  ensureDataRepo();

  assert.equal(rawGit(home, ["config", "--local", "user.name"]).trim(), "snorrio");
  assert.equal(rawGit(home, ["config", "--local", "user.email"]).trim(), "dmn@snorr.io");

  // Belt and suspenders: the values physically live in .git/config.
  const localCfg = readFileSync(join(home, ".git", "config"), "utf8");
  assert.match(localCfg, /name = snorrio/);
  assert.match(localCfg, /email = dmn@snorr\.io/);
});

test("ensureDataRepo: git missing → disabled, loud warning, no throw", () => {
  const home = freshRoot("nogit");
  process.env.PATH = "/nonexistent-path-for-test";
  try {
    const { result: state, stderr } = captureStderr(() => ensureDataRepo());
    assert.equal(state.enabled, false, "versioning disabled without git");
    assert.ok(!existsSync(join(home, ".git")), "no repo created");
    assert.match(stderr, /WARNING/, "warning must be loud");
    assert.match(stderr, /git/i);
  } finally {
    process.env.PATH = SAVED_ENV.PATH;
  }

  // Recovery: once git is back on PATH, the same root self-initializes.
  const state = ensureDataRepo();
  assert.equal(state.enabled, true, "recovers when git returns");
});

test("commitDataRepo: git failing mid-flight never throws — cache writes complete", () => {
  const home = freshRoot("gitfail");
  ensureDataRepo();

  // The daemon's ordering: cache write FIRST (atomicWriteFile), commit AFTER.
  const cachePath = join(home, "cache", "days", "2026-06-09.md");
  atomicWriteFile(cachePath, "the day summary");

  process.env.PATH = "/nonexistent-path-for-test";
  try {
    const { result: ok, stderr } = captureStderr(() =>
      commitDataRepo({ message: "cascade 2026-06-09: episode deadbeef → day/week/month/quarter/year" }),
    );
    assert.equal(ok, false, "commit reports failure");
    assert.match(stderr, /WARNING/, "failure is loud on stderr");
  } finally {
    process.env.PATH = SAVED_ENV.PATH;
  }

  // The write is untouched by the git failure.
  assert.equal(readFileSync(cachePath, "utf8"), "the day summary");

  // And the next commit (git back) picks the change up — nothing was lost.
  assert.equal(commitDataRepo({ message: "cascade retry" }), true);
  assert.match(rawGit(home, ["ls-files"]), /cache\/days\/2026-06-09\.md/);
});

test("commitDataRepo: author date = episode world-time, committer date = now", () => {
  const home = freshRoot("authordate");
  ensureDataRepo();

  const worldTime = "2026-06-09T18:30:00.000Z"; // episode timestamp
  atomicWriteFile(join(home, "episodes", "2026-06-09", "019e.md"), "episode body");
  atomicWriteFile(join(home, "cache", "days", "2026-06-09.md"), "day cache");

  const ok = commitDataRepo({
    message: "cascade 2026-06-09: episode 019e → day/week/month/quarter/year",
    authorDate: worldTime,
  });
  assert.equal(ok, true);

  const authorIso = rawGit(home, ["log", "-1", "--format=%aI"]).trim();
  const committerIso = rawGit(home, ["log", "-1", "--format=%cI"]).trim();
  assert.equal(new Date(authorIso).getTime(), new Date(worldTime).getTime(),
    "GIT_AUTHOR_DATE must equal the episode world-time");
  assert.ok(Math.abs(new Date(committerIso).getTime() - Date.now()) < 60_000,
    "committer date stays wall-clock now");

  // Both files landed in the one cascade commit.
  const shown = rawGit(home, ["show", "--stat", "--format=%s", "HEAD"]);
  assert.match(shown, /episodes\/2026-06-09\/019e\.md/);
  assert.match(shown, /cache\/days\/2026-06-09\.md/);
});

test("commitDataRepo: clean tree is a no-op (no empty commits)", () => {
  const home = freshRoot("clean");
  ensureDataRepo();
  const countBefore = rawGit(home, ["rev-list", "--count", "HEAD"]).trim();
  assert.equal(commitDataRepo({ message: "nothing changed" }), true);
  const countAfter = rawGit(home, ["rev-list", "--count", "HEAD"]).trim();
  assert.equal(countAfter, countBefore, "no commit when nothing changed");
});
