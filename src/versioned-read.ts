// Versioned reads from the snorrio data repo (interest-caches spec §3.3).
//
// Faithful past-self reads are CONTENT-ADDRESSED, never `git checkout`: the
// daemon writes the working tree continuously, and a checkout would race it.
//
//   sha     = git rev-list -1 --before=<T> HEAD
//   content = git show <sha>:cache/weeks/2026-W23.md
//
// `rev-list --before` filters on committer date — i.e. "repo state as of
// wall-clock T" (when the write landed), which is the contemporaneous view
// the hindsight fix needs. Author dates carry session world-time separately.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveDataRoot } from "./data-repo.ts";

function git(args: string[]): string {
  const root = resolveDataRoot();
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function toIso(timestamp: string | Date): string {
  const d = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (isNaN(d.getTime())) throw new Error(`invalid timestamp: ${String(timestamp)}`);
  return d.toISOString();
}

/**
 * Resolve the last commit at or before `timestamp`.
 * Returns null when the repo has no commit before T (history starts later).
 * Throws (descriptive) when the data repo / git itself is unavailable —
 * callers surface that as a clear error, distinct from "no commit before T".
 */
export function resolveShaAt(timestamp: string | Date): string | null {
  const root = resolveDataRoot();
  if (!existsSync(join(root, ".git"))) {
    throw new Error(`data repo not initialized at ${root} (no .git) — start the daemon once or run ensureDataRepo()`);
  }
  const t = toIso(timestamp);
  let out: string;
  try {
    out = git(["rev-list", "-1", `--before=${t}`, "HEAD"]);
  } catch (err: any) {
    throw new Error(`git rev-list failed in ${root}: ${err?.message?.slice(0, 200)}`);
  }
  return out.trim() || null;
}

/**
 * Read `relPath` (relative to the data-repo root) as of commit `sha`.
 * Returns null when the path did not exist at that commit.
 */
export function readFileAtSha(sha: string, relPath: string): string | null {
  try {
    return git(["show", `${sha}:${relPath}`]);
  } catch {
    return null; // path absent at that commit
  }
}

/**
 * Read `relPath` as it was at `timestamp`.
 * Returns null when the path did not exist at that time.
 * Throws when the repo has no commit before T, or git is unavailable.
 */
export function readFileAt(relPath: string, timestamp: string | Date): string | null {
  const sha = resolveShaAt(timestamp);
  if (sha === null) {
    throw new Error(`no commit in data repo before ${toIso(timestamp)} — history starts later`);
  }
  return readFileAtSha(sha, relPath);
}
